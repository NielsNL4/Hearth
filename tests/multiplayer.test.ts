import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuthContext, Client } from '@colyseus/core';
import { roomSchemaToScene, sceneToRoomSchema } from '../packages/room-schema/src/index.js';
import { createEmptyScene, createTokenMovementState, type SceneV2, type StructureRecord, type WallRecord } from '../packages/scene/src/index.js';
import { authenticateRoomClient, type Actor, type AuthProvider, type CommitInput, type Persistence, type RoomAsset } from '../apps/multiplayer/src/contracts.js';
import { AuthoritativeRoomEngine, CommandError } from '../apps/multiplayer/src/engine.js';
import { createBattleRoom, createMapPingEvent, removeConnectionPresence, setConnectionPresence } from '../apps/multiplayer/src/room.js';

const roomId = '10000000-0000-4000-8000-000000000000';
const commandId = (value: number) => `00000000-0000-4000-8000-${value.toString().padStart(12, '0')}`;
const dm: Actor = { userId: 'dm', role: 'dm', displayName: 'DM' };
const alice: Actor = { userId: 'alice', role: 'player', displayName: 'Alice' };
const bob: Actor = { userId: 'bob', role: 'player', displayName: 'Bob' };
const tokenAssetId = '20000000-0000-4000-8000-000000000000';
const mapAssetId = '30000000-0000-4000-8000-000000000000';

function wallRecord(id = 'wall'): Omit<WallRecord, 'revision'> {
  return {
    id, type: 'blocking', start: { x: 20, y: 0 }, end: { x: 20, y: 30 },
    height: 10, thickness: 1, elevation: 0, material: 'default', openings: [],
  };
}

function structureRecord(id = 'crate'): Omit<StructureRecord, 'revision'> {
  return {
    id, kind: 'block', position: { x: 10, y: 20 }, size: { width: 2, height: 3 }, rotation: 15,
    label: 'Crate', z: 2, material: 'wood', baseElevation: 1, slabHeight: 2,
  };
}

function initialScene(): SceneV2 {
  const scene = createEmptyScene();
  scene.tokens.alice = {
    id: 'alice', assetId: 'asset-a', position: { x: 1, y: 2 }, size: { width: 1, height: 1 }, rotation: 0,
    label: 'Alice', ownerId: 'alice', hpCurrent: 10, hpMaximum: 10, hpHidden: false, z: 1, movement: createTokenMovementState(), revision: 0,
  };
  scene.tokens.bob = {
    id: 'bob', assetId: 'asset-b', position: { x: 3, y: 4 }, size: { width: 1, height: 1 }, rotation: 0,
    label: 'Bob', ownerId: 'bob', hpCurrent: 8, hpMaximum: 8, hpHidden: false, z: 2, movement: createTokenMovementState(), revision: 0,
  };
  return scene;
}

class MemoryPersistence implements Persistence {
  revision = 0;
  commits: CommitInput[] = [];
  reservations = 0;
  failNext = false;
  assets = new Map<string, RoomAsset>([
    [tokenAssetId, { id: tokenAssetId, roomId, kind: 'token', status: 'ready', width: 64, height: 64 }],
    [mapAssetId, { id: mapAssetId, roomId, kind: 'map', status: 'ready', width: 100, height: 100 }],
  ]);

  async loadRoomState() { return { roomId, sceneRevision: this.revision, scene: initialScene() }; }
  async getRoomAsset(assetId: string) { return this.assets.get(assetId) ?? null; }
  async commitRoomState(input: CommitInput) {
    if (this.failNext) { this.failNext = false; throw new Error('database unavailable'); }
    expect(input.expectedSceneRevision).toBe(this.revision);
    this.commits.push(structuredClone(input));
    this.revision++;
    return { roomId, sceneRevision: this.revision, eventId: this.revision };
  }
  async reserveRoomAsset(input: Parameters<Persistence['reserveRoomAsset']>[0]) {
    this.reservations++;
    return { id: commandId(900 + this.reservations), roomId, status: 'reserved', sourceObjectKey: 'source', outputObjectPrefix: 'output/' };
  }
}

function setup(now: () => number = Date.now) {
  const scene = initialScene();
  const state = sceneToRoomSchema(scene);
  const persistence = new MemoryPersistence();
  const engine = new AuthoritativeRoomEngine(roomId, state, scene, 0, persistence, {
    now, previewIntervalMs: 30, previewExpiryMs: 60_000,
  });
  return { engine, state, persistence };
}

describe('authoritative multiplayer engine', () => {
  afterEach(() => vi.useRealTimers());

  it('passes the application room ID to BattleRoom without using Colyseus roomId', async () => {
    const persistence = new MemoryPersistence();
    const loadRoomState = vi.spyOn(persistence, 'loadRoomState');
    const receivedRoomIds: string[] = [];
    const auth: AuthProvider = {
      async verifyAccessToken() { return { userId: alice.userId }; },
      async getMembership(receivedRoomId, userId) {
        receivedRoomIds.push(receivedRoomId);
        return userId === alice.userId ? alice : null;
      },
    };
    const BattleRoom = createBattleRoom({ auth, persistence });
    const room = new BattleRoom();
    try {
      await room.onCreate({ databaseRoomId: roomId, accessToken: 'access-token' });
      expect(loadRoomState).toHaveBeenCalledWith(roomId);
      await expect(room.onAuth(
        null as unknown as Client,
        { databaseRoomId: roomId, accessToken: 'access-token' },
        { token: 'access-token' } as AuthContext,
      )).resolves.toEqual(alice);
      expect(receivedRoomIds).toEqual([roomId]);
    } finally {
      await room.onDispose();
    }
  });

  it('authenticates the supplied token and requires database membership', async () => {
    const calls: string[] = [];
    const auth: AuthProvider = {
      async verifyAccessToken(token) { calls.push(token); return { userId: 'alice' }; },
      async getMembership(receivedRoom, userId) {
        expect(receivedRoom).toBe(roomId);
        return userId === 'alice' ? alice : null;
      },
    };
    await expect(authenticateRoomClient(auth, roomId, 'access-token')).resolves.toEqual(alice);
    expect(calls).toEqual(['access-token']);
    auth.getMembership = async () => null;
    await expect(authenticateRoomClient(auth, roomId, 'access-token')).rejects.toThrow(/membership/);
  });

  it('enforces DM, ownership, and shared movement permissions', async () => {
    const { engine, persistence } = setup();
    await expect(engine.execute(alice, 'a', 'map.set', {
      commandId: commandId(1), payload: { map: null },
    })).rejects.toBeInstanceOf(CommandError);
    expect(persistence.commits).toHaveLength(0);

    await expect(engine.execute(alice, 'a', 'token.transform.commit', {
      commandId: commandId(2), payload: { tokenId: 'bob', expectedTokenRevision: 0, position: { x: 8, y: 9 }, rotation: 10 },
    })).rejects.toMatchObject({ code: 'forbidden' });
    await engine.execute(dm, 'dm', 'permissions.playerMovement.set', {
      commandId: commandId(3), payload: { playerMovement: 'all' },
    });
    await engine.execute(alice, 'a', 'token.transform.commit', {
      commandId: commandId(4), payload: { tokenId: 'bob', expectedTokenRevision: 0, position: { x: 8, y: 9 }, rotation: 10 },
    });
    expect(engine.canonicalScene.tokens.bob?.position).toEqual({ x: 8, y: 9 });
  });

  it('commits before targeted schema mutation and deduplicates stable command IDs', async () => {
    const { engine, state, persistence } = setup();
    const originalGrid = state.grid;
    const command = { commandId: commandId(10), payload: { tokenId: 'alice', expectedTokenRevision: 0, position: { x: 5, y: 6 }, rotation: 45 } };
    const first = await engine.execute(alice, 'a', 'token.transform.commit', command);
    const second = await engine.execute(alice, 'a', 'token.transform.commit', command);
    expect(second).toMatchObject({ duplicate: true, sceneRevision: first.sceneRevision });
    expect(persistence.commits).toHaveLength(1);
    expect(state.grid).toBe(originalGrid);
    expect(state.tokens.get('alice')).toMatchObject({ rotation: 45, revision: 1 });
    await expect(engine.execute(alice, 'a', 'token.transform.commit', {
      ...command, payload: { ...command.payload, rotation: 46 },
    })).rejects.toMatchObject({ code: 'conflict' });
  });

  it('keeps previews ephemeral, sequence/rate checked, and reverts on failure and disconnect', async () => {
    let now = 100;
    const { engine, state, persistence } = setup(() => now);
    await engine.execute(alice, 'session-a', 'token.transform.preview', {
      tokenId: 'alice', sequence: 1, position: { x: 20, y: 21 }, rotation: 30,
    });
    expect(state.tokens.get('alice')?.position.x).toBe(20);
    expect(engine.canonicalScene.tokens.alice?.position.x).toBe(1);
    await expect(engine.execute(alice, 'session-a', 'token.transform.preview', {
      tokenId: 'alice', sequence: 2, position: { x: 22, y: 23 }, rotation: 31,
    })).rejects.toMatchObject({ code: 'rate_limited' });
    now += 31;
    await engine.execute(alice, 'session-a', 'token.transform.preview', {
      tokenId: 'alice', sequence: 2, position: { x: 22, y: 23 }, rotation: 31,
    });
    persistence.failNext = true;
    await expect(engine.execute(alice, 'session-a', 'token.transform.commit', {
      commandId: commandId(20), payload: { tokenId: 'alice', expectedTokenRevision: 0, position: { x: 22, y: 23 }, rotation: 31 },
    })).rejects.toThrow('database unavailable');
    expect(state.tokens.get('alice')?.position.x).toBe(1);

    now += 31;
    await engine.execute(alice, 'session-a', 'token.transform.preview', {
      tokenId: 'alice', sequence: 3, position: { x: 40, y: 41 }, rotation: 90,
    });
    engine.disconnect('session-a');
    expect(state.tokens.get('alice')?.position.x).toBe(1);
    engine.dispose();
  });

  it('validates asset permissions and keeps reservations out of scene revisions', async () => {
    const { engine, persistence } = setup();
    const result = await engine.execute(alice, 'a', 'asset.reserve', {
      commandId: commandId(30), payload: { kind: 'token', sourceMetadata: { contentType: 'image/png' } },
    });
    expect(result.sceneRevision).toBe(0);
    await expect(engine.execute(alice, 'a', 'asset.reserve', {
      commandId: commandId(31), payload: { kind: 'map', sourceMetadata: {} },
    })).rejects.toMatchObject({ code: 'forbidden' });
    expect(persistence.reservations).toBe(1);
  });

  it('never persists a live preview in an unrelated canonical command', async () => {
    const { engine, persistence } = setup();
    await engine.execute(alice, 'a', 'token.transform.preview', {
      tokenId: 'alice', sequence: 1, position: { x: 99, y: 99 }, rotation: 99,
    });
    await engine.execute(dm, 'dm', 'grid.set', {
      commandId: commandId(40),
      payload: { visible: true, cellSize: 50, offset: { x: 0, y: 0 }, distancePerCell: 5, unit: 'ft', snap: true },
    });
    expect(persistence.commits[0]?.scene.tokens.alice?.position).toEqual({ x: 1, y: 2 });
    engine.dispose();
  });

  it('supports authorized token create, details, transfer, and delete', async () => {
    const { engine, state } = setup();
    await engine.execute(alice, 'a', 'token.create', {
      commandId: commandId(50),
      payload: { token: {
        id: 'new-token', assetId: tokenAssetId, position: { x: 0, y: 0 }, size: { width: 2, height: 2 }, rotation: 0,
        label: 'New', ownerId: 'alice', hpCurrent: 5, hpMaximum: 5, hpHidden: false, z: 3,
      } },
    });
    expect(state.tokens.get('new-token')).toMatchObject({ ownerId: 'alice', revision: 0 });
    await expect(engine.execute(alice, 'a', 'token.details.update', {
      commandId: commandId(51), payload: { tokenId: 'new-token', expectedTokenRevision: 0, details: { ownerId: 'bob' } },
    })).rejects.toMatchObject({ code: 'forbidden' });
    await engine.execute(dm, 'dm', 'token.details.update', {
      commandId: commandId(52), payload: { tokenId: 'new-token', expectedTokenRevision: 0, details: { label: 'Transferred', ownerId: 'bob' } },
    });
    expect(state.tokens.get('new-token')).toMatchObject({ label: 'Transferred', ownerId: 'bob', revision: 1 });
    await expect(engine.execute(alice, 'a', 'token.delete', {
      commandId: commandId(53), payload: { tokenId: 'new-token', expectedTokenRevision: 1 },
    })).rejects.toMatchObject({ code: 'forbidden' });
    await engine.execute(bob, 'b', 'token.delete', {
      commandId: commandId(54), payload: { tokenId: 'new-token', expectedTokenRevision: 1 },
    });
    expect(state.tokens.has('new-token')).toBe(false);
  });

  it('expires previews and prevents another session from previewing or committing over them', async () => {
    vi.useFakeTimers();
    const { engine, state } = setup(() => Date.now());
    await engine.execute(alice, 'first', 'token.transform.preview', {
      tokenId: 'alice', sequence: 1, position: { x: 50, y: 50 }, rotation: 50,
    });
    await expect(engine.execute(dm, 'second', 'token.transform.preview', {
      tokenId: 'alice', sequence: 1, position: { x: 60, y: 60 }, rotation: 60,
    })).rejects.toMatchObject({ code: 'conflict' });
    await expect(engine.execute(dm, 'second', 'token.transform.commit', {
      commandId: commandId(60), payload: { tokenId: 'alice', expectedTokenRevision: 0, position: { x: 60, y: 60 }, rotation: 60 },
    })).rejects.toMatchObject({ code: 'conflict' });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(state.tokens.get('alice')?.position).toMatchObject({ x: 1, y: 2 });
    engine.dispose();
  });

  it('serializes concurrent commits against each returned scene revision', async () => {
    const { engine, persistence } = setup();
    await Promise.all([
      engine.execute(dm, 'dm', 'map.set', {
        commandId: commandId(70), payload: { map: { assetId: mapAssetId, width: 100, height: 100 } },
      }),
      engine.execute(dm, 'dm', 'grid.set', {
        commandId: commandId(71),
        payload: { visible: false, cellSize: 25, offset: { x: 2, y: 3 }, distancePerCell: 5, unit: 'ft', snap: false },
      }),
    ]);
    expect(persistence.commits.map((commit) => commit.expectedSceneRevision)).toEqual([0, 1]);
    expect(persistence.commits[1]?.scene.map?.assetId).toBe(mapAssetId);
  });

  it('rejects stale token revisions without persistence', async () => {
    const { engine, persistence } = setup();
    await expect(engine.execute(alice, 'a', 'token.transform.commit', {
      commandId: commandId(80),
      payload: { tokenId: 'alice', expectedTokenRevision: 7, position: { x: 5, y: 5 }, rotation: 0 },
    })).rejects.toMatchObject({ code: 'conflict' });
    await expect(engine.execute(alice, 'a', 'token.details.update', {
      commandId: commandId(81), payload: { tokenId: 'alice', expectedTokenRevision: 7, details: { label: 'stale' } },
    })).rejects.toMatchObject({ code: 'conflict' });
    await expect(engine.execute(alice, 'a', 'token.delete', {
      commandId: commandId(82), payload: { tokenId: 'alice', expectedTokenRevision: 7 },
    })).rejects.toMatchObject({ code: 'conflict' });
    expect(persistence.commits).toHaveLength(0);
  });

  it('supports DM-only wall CRUD with collection and record revisions', async () => {
    const { engine, state, persistence } = setup();
    const wall = { ...wallRecord(), material: 'masonry' as const, openings: [{ type: 'window' as const, start: .25, end: .75, bottom: 2, height: 5 }] };
    await expect(engine.execute(alice, 'a', 'wall.create', {
      commandId: commandId(130), payload: { wall, expectedWallRevision: 0 },
    })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(engine.execute(alice, 'a', 'wall.delete', {
      commandId: commandId(131), payload: { wallId: 'missing', expectedWallRevision: 99, expectedRecordRevision: 99 },
    })).rejects.toMatchObject({ code: 'forbidden' });
    expect(engine.canonicalScene.walls).toEqual({});
    expect(state.walls.size).toBe(0);
    expect(persistence.commits).toHaveLength(0);

    const created = await engine.execute(dm, 'dm', 'wall.create', {
      commandId: commandId(132), payload: { wall, expectedWallRevision: 0 },
    });
    expect(created.sceneRevision).toBe(1);
    expect(engine.canonicalScene).toMatchObject({ wallRevision: 1, navigationRevision: 1, walls: { wall: { revision: 0, type: 'blocking', material: 'masonry', openings: wall.openings } } });
    expect(state.wallRevision).toBe(1);
    expect(state.navigationRevision).toBe(1);
    expect(state.walls.get('wall')).toMatchObject({ id: 'wall', type: 'blocking', material: 'masonry', revision: 0 });
    expect(state.walls.get('wall')?.openings[0]).toMatchObject({ type: 'window', start: .25, end: .75, bottom: 2, height: 5 });

    await expect(engine.execute(dm, 'dm', 'wall.create', {
      commandId: commandId(133), payload: { wall, expectedWallRevision: 1 },
    })).rejects.toMatchObject({ code: 'conflict' });
    const replacement = { ...wall, type: 'door' as const, doorState: 'closed' as const, material: 'metal' as const, openings: [], start: { x: 25, y: 0 } };
    await engine.execute(dm, 'dm', 'wall.update', {
      commandId: commandId(134), payload: { wall: replacement, expectedWallRevision: 1, expectedRecordRevision: 0 },
    });
    expect(engine.canonicalScene).toMatchObject({ wallRevision: 2, navigationRevision: 2, walls: { wall: { revision: 1, type: 'door', doorState: 'closed', material: 'metal', openings: [] } } });
    expect(state.wallRevision).toBe(2);
    expect(state.navigationRevision).toBe(2);
    expect(state.walls.get('wall')).toMatchObject({ type: 'door', doorState: 'closed', revision: 1 });

    const duplicate = await engine.execute(dm, 'dm', 'wall.update', {
      commandId: commandId(134), payload: { wall: replacement, expectedWallRevision: 1, expectedRecordRevision: 0 },
    });
    expect(duplicate.duplicate).toBe(true);
    expect(persistence.commits).toHaveLength(2);
    await engine.execute(dm, 'dm', 'wall.delete', {
      commandId: commandId(135), payload: { wallId: 'wall', expectedWallRevision: 2, expectedRecordRevision: 1 },
    });
    expect(engine.canonicalScene).toMatchObject({ wallRevision: 3, navigationRevision: 3, walls: {} });
    expect(state.walls.size).toBe(0);
    expect(state.wallRevision).toBe(3);
    expect(state.navigationRevision).toBe(3);
    expect(persistence.commits.map((commit) => commit.eventType)).toEqual(['wall.create', 'wall.update', 'wall.delete']);
  });

  it('persists DM-only perspective permission and structure CRUD without navigation changes', async () => {
    const { engine, state, persistence } = setup();
    await expect(engine.execute(alice, 'a', 'permissions.playerPerspectiveView.set', {
      commandId: commandId(151), payload: { enabled: true },
    })).rejects.toMatchObject({ code: 'forbidden' });
    await engine.execute(dm, 'dm', 'permissions.playerPerspectiveView.set', {
      commandId: commandId(152), payload: { enabled: true },
    });
    expect(engine.canonicalScene.permissions.playerPerspectiveView).toBe(true);
    expect(state.permissions.playerPerspectiveView).toBe(true);
    expect(persistence.commits.at(-1)?.scene.navigationRevision).toBe(0);

    const structure = structureRecord();
    await expect(engine.execute(alice, 'a', 'structure.create', {
      commandId: commandId(153), payload: { structure, expectedStructureRevision: 0 },
    })).rejects.toMatchObject({ code: 'forbidden' });
    await engine.execute(dm, 'dm', 'structure.create', {
      commandId: commandId(154), payload: { structure, expectedStructureRevision: 0 },
    });
    expect(engine.canonicalScene).toMatchObject({ structureRevision: 1, navigationRevision: 0, wallRevision: 0, structures: { crate: { kind: 'block', revision: 0, material: 'wood' } } });
    expect(state.structureRevision).toBe(1);
    expect(state.structures.get('crate')).toMatchObject({ kind: 'block', baseElevation: 1, slabHeight: 2 });

    const replacement = { ...structure, kind: 'roof' as const, position: { x: 12, y: 20 } };
    await engine.execute(dm, 'dm', 'structure.update', {
      commandId: commandId(155), payload: { structure: replacement, expectedStructureRevision: 1, expectedRecordRevision: 0 },
    });
    expect(engine.canonicalScene.structures.crate).toMatchObject({ kind: 'roof', revision: 1, position: { x: 12, y: 20 } });
    await expect(engine.execute(dm, 'dm', 'structure.delete', {
      commandId: commandId(156), payload: { structureId: 'crate', expectedStructureRevision: 1, expectedRecordRevision: 1 },
    })).rejects.toMatchObject({ code: 'conflict' });
    await engine.execute(dm, 'dm', 'structure.delete', {
      commandId: commandId(157), payload: { structureId: 'crate', expectedStructureRevision: 2, expectedRecordRevision: 1 },
    });
    expect(engine.canonicalScene.structures).toEqual({});
    expect(engine.canonicalScene.structureRevision).toBe(3);
    expect(engine.canonicalScene.navigationRevision).toBe(0);
    expect(persistence.commits.map((commit) => commit.eventType)).toEqual([
      'permissions.playerPerspectiveView.set', 'structure.create', 'structure.update', 'structure.delete',
    ]);
  });

  it('authorizes perspective permission before receipt lookup on command replay', async () => {
    const { engine, state, persistence } = setup();
    const command = {
      commandId: commandId(158), payload: { enabled: true },
    };
    await engine.execute(dm, 'dm', 'permissions.playerPerspectiveView.set', command);
    const before = engine.canonicalScene;
    await expect(engine.execute(alice, 'a', 'permissions.playerPerspectiveView.set', command))
      .rejects.toMatchObject({ code: 'forbidden' });
    expect(engine.canonicalScene).toEqual(before);
    expect(state.permissions.playerPerspectiveView).toBe(true);
    expect(persistence.commits).toHaveLength(1);
  });

  it('rejects client wall revisions and enforces the bounded wall ID contract', async () => {
    const { engine, persistence } = setup();
    const wall = wallRecord();
    const tooLongId = 'w'.repeat(129);
    await expect(engine.execute(dm, 'dm', 'wall.create', {
      commandId: commandId(145), payload: { wall: { ...wall, revision: 0 }, expectedWallRevision: 0 },
    })).rejects.toThrow();
    await expect(engine.execute(dm, 'dm', 'wall.create', {
      commandId: commandId(146), payload: { wall: { ...wall, id: tooLongId }, expectedWallRevision: 0 },
    })).rejects.toThrow();
    await engine.execute(dm, 'dm', 'wall.create', {
      commandId: commandId(147), payload: { wall, expectedWallRevision: 0 },
    });
    await expect(engine.execute(dm, 'dm', 'wall.update', {
      commandId: commandId(148), payload: { wall: { ...wall, revision: 0 }, expectedWallRevision: 1, expectedRecordRevision: 0 },
    })).rejects.toThrow();
    await expect(engine.execute(dm, 'dm', 'wall.update', {
      commandId: commandId(149), payload: { wall: { ...wall, id: tooLongId }, expectedWallRevision: 1, expectedRecordRevision: 0 },
    })).rejects.toThrow();
    await expect(engine.execute(dm, 'dm', 'wall.delete', {
      commandId: commandId(150), payload: { wallId: tooLongId, expectedWallRevision: 1, expectedRecordRevision: 0 },
    })).rejects.toThrow();
    expect(persistence.commits).toHaveLength(1);
    expect(engine.canonicalScene.walls.wall?.revision).toBe(0);
  });

  it('rejects stale, missing, partial, and invalid wall records without state changes', async () => {
    const { engine, state, persistence } = setup();
    const wall = wallRecord();
    await engine.execute(dm, 'dm', 'wall.create', {
      commandId: commandId(136), payload: { wall, expectedWallRevision: 0 },
    });
    const before = engine.canonicalScene;
    await expect(engine.execute(dm, 'dm', 'wall.update', {
      commandId: commandId(137), payload: { wall: { ...wall, start: { x: 30, y: 0 } }, expectedWallRevision: 0, expectedRecordRevision: 0 },
    })).rejects.toMatchObject({ code: 'conflict' });
    await expect(engine.execute(dm, 'dm', 'wall.update', {
      commandId: commandId(138), payload: { wall: { ...wall, start: { x: 30, y: 0 } }, expectedWallRevision: 1, expectedRecordRevision: 4 },
    })).rejects.toMatchObject({ code: 'conflict' });
    await expect(engine.execute(dm, 'dm', 'wall.update', {
      commandId: commandId(139), payload: {
        wall: { id: 'wall', type: 'door', start: wall.start, end: wall.end, height: wall.height, thickness: wall.thickness, elevation: wall.elevation },
        expectedWallRevision: 1, expectedRecordRevision: 0,
      },
    })).rejects.toThrow();
    await expect(engine.execute(dm, 'dm', 'wall.update', {
      commandId: commandId(140), payload: { wall: { ...wall, end: wall.start }, expectedWallRevision: 1, expectedRecordRevision: 0 },
    })).rejects.toThrow(/must have length/);
    await expect(engine.execute(dm, 'dm', 'wall.delete', {
      commandId: commandId(141), payload: { wallId: 'missing', expectedWallRevision: 1, expectedRecordRevision: 0 },
    })).rejects.toMatchObject({ code: 'not_found' });
    expect(engine.canonicalScene).toEqual(before);
    expect(state.walls.get('wall')).toMatchObject({ start: { x: 20, y: 0 }, revision: 0 });
    expect(state.wallRevision).toBe(1);
    expect(state.navigationRevision).toBe(1);
    expect(persistence.commits).toHaveLength(1);
  });

  it('does not publish a wall mutation when persistence fails', async () => {
    const { engine, state, persistence } = setup();
    const wall = wallRecord();
    persistence.failNext = true;
    await expect(engine.execute(dm, 'dm', 'wall.create', {
      commandId: commandId(142), payload: { wall, expectedWallRevision: 0 },
    })).rejects.toThrow('database unavailable');
    expect(engine.canonicalScene).toMatchObject({ wallRevision: 0, navigationRevision: 0, walls: {} });
    expect(state.walls.size).toBe(0);
    expect(state.wallRevision).toBe(0);
    expect(state.navigationRevision).toBe(0);
    expect(persistence.commits).toHaveLength(0);
  });

  it('invalidates authoritative movement playback without changing position or allowance', async () => {
    const scene = initialScene();
    scene.map = { assetId: mapAssetId, width: 100, height: 100 };
    scene.grid.cellSize = 10;
    scene.tokens.alice!.position = { x: 5, y: 5 };
    scene.tokens.bob!.position = { x: 85, y: 85 };
    const state = sceneToRoomSchema(scene);
    const persistence = new MemoryPersistence();
    const engine = new AuthoritativeRoomEngine(roomId, state, scene, 0, persistence, { now: () => 1_000 });
    await engine.execute(alice, 'a', 'token.move.commit', {
      commandId: commandId(143), payload: {
        tokenId: 'alice', destination: { column: 2, row: 0 }, expectedTokenRevision: 0,
        expectedNavigationRevision: 0, expectedMovementRevision: 0,
      },
    });
    const moving = engine.canonicalScene.tokens.alice!;
    expect(moving).toMatchObject({ position: { x: 25, y: 5 }, movement: { status: 'moving', spentCells: 2 } });
    expect(moving.movement?.activePath).toEqual([{ column: 0, row: 0 }, { column: 1, row: 0 }, { column: 2, row: 0 }]);
    await engine.execute(dm, 'dm', 'wall.create', {
      commandId: commandId(144), payload: { wall: wallRecord('interrupting-wall'), expectedWallRevision: 0 },
    });
    expect(engine.canonicalScene.tokens.alice).toMatchObject({
      position: { x: 25, y: 5 },
      movement: { status: 'interrupted', spentCells: 2, activePath: [], pathCostCells: 0, pathStartedAtServerMs: null, revision: 2 },
      revision: 2,
    });
    const synchronized = state.tokens.get('alice')!;
    expect(synchronized.position).toMatchObject({ x: 25, y: 5 });
    expect(synchronized.revision).toBe(2);
    expect(synchronized.movement.status).toBe('interrupted');
    expect(synchronized.movement.spentCells).toBe(2);
    expect([...synchronized.movement.activePath]).toEqual([]);
    expect(synchronized.movement.pathCostCells).toBe(0);
    expect(synchronized.movement.pathStartedAtServerMs).toBe(-1);
    expect(synchronized.movement.revision).toBe(2);
    expect(state.walls.get('interrupting-wall')).toMatchObject({ revision: 0 });
  });

  it('rejects stale routes and recomputes retries against edited walls', async () => {
    const scene = initialScene();
    scene.map = { assetId: mapAssetId, width: 100, height: 100 };
    scene.grid.cellSize = 10;
    scene.tokens.alice!.position = { x: 5, y: 5 };
    scene.tokens.bob!.position = { x: 85, y: 85 };
    const state = sceneToRoomSchema(scene);
    const persistence = new MemoryPersistence();
    const engine = new AuthoritativeRoomEngine(roomId, state, scene, 0, persistence, { now: () => 1_000 });

    await engine.execute(alice, 'a', 'token.move.commit', {
      commandId: commandId(151), payload: {
        tokenId: 'alice', destination: { column: 2, row: 0 }, expectedTokenRevision: 0,
        expectedNavigationRevision: 0, expectedMovementRevision: 0,
      },
    });
    await engine.execute(dm, 'dm', 'wall.create', {
      commandId: commandId(152), payload: {
        wall: { ...wallRecord('edited'), start: { x: 35, y: 0 }, end: { x: 35, y: 20 } }, expectedWallRevision: 0,
      },
    });
    const interrupted = persistence.commits[1]!.scene.tokens.alice!;
    expect(interrupted).toMatchObject({
      position: { x: 25, y: 5 }, revision: 2,
      movement: { status: 'interrupted', spentCells: 2, activePath: [], pathCostCells: 0, pathStartedAtServerMs: null, revision: 2 },
    });
    expect(persistence.commits[1]!.scene.navigationRevision).toBe(2);

    const retryPayload = {
      tokenId: 'alice', destination: { column: 4, row: 0 }, expectedTokenRevision: 2,
      expectedNavigationRevision: 1, expectedMovementRevision: 2,
    };
    await expect(engine.execute(alice, 'a', 'token.move.commit', {
      commandId: commandId(153), payload: retryPayload,
    })).rejects.toMatchObject({ code: 'conflict' });
    expect(persistence.commits).toHaveLength(2);

    await engine.execute(alice, 'a', 'token.move.commit', {
      commandId: commandId(154), payload: { ...retryPayload, expectedNavigationRevision: 2 },
    });
    const retried = persistence.commits[2]!.scene.tokens.alice!;
    expect(retried.position).toEqual({ x: 45, y: 5 });
    expect(retried.movement?.spentCells).toBeGreaterThan(2);
    expect(retried.movement?.status).toBe('moving');
    expect(retried.movement?.activePath.some((point) => point.row > 0)).toBe(true);
    expect(persistence.commits[2]!.scene.navigationRevision).toBe(3);
  });

  it('authoritatively commits paths and rejects stale navigation or exhausted allowances', async () => {
    const scene = initialScene();
    scene.map = { assetId: mapAssetId, width: 100, height: 100 };
    scene.grid.cellSize = 10;
    scene.tokens.alice!.position = { x: 5, y: 5 };
    scene.tokens.bob!.position = { x: 85, y: 85 };
    const state = sceneToRoomSchema(scene);
    const persistence = new MemoryPersistence();
    const engine = new AuthoritativeRoomEngine(roomId, state, scene, 0, persistence, { now: () => 1_000 });

    await engine.execute(alice, 'a', 'token.move.commit', {
      commandId: commandId(83), payload: {
        tokenId: 'alice', destination: { column: 2, row: 0 }, expectedTokenRevision: 0,
        expectedNavigationRevision: 0, expectedMovementRevision: 0,
      },
    });
    expect(engine.canonicalScene.tokens.alice).toMatchObject({
      position: { x: 25, y: 5 }, revision: 1,
      movement: { spentCells: 2, pathCostCells: 2, pathStartedAtServerMs: 1_000, status: 'moving', revision: 1 },
    });
    expect(state).toMatchObject({ navigationRevision: 1 });
    expect(state.tokens.get('alice')?.movement.activePath).toHaveLength(3);

    await expect(engine.execute(alice, 'a', 'token.move.commit', {
      commandId: commandId(84), payload: {
        tokenId: 'alice', destination: { column: 3, row: 0 }, expectedTokenRevision: 1,
        expectedNavigationRevision: 0, expectedMovementRevision: 1,
      },
    })).rejects.toMatchObject({ code: 'conflict' });

    const limitedScene = initialScene();
    limitedScene.map = { assetId: mapAssetId, width: 100, height: 100 };
    limitedScene.grid.cellSize = 10;
    limitedScene.tokens.alice!.position = { x: 5, y: 5 };
    limitedScene.tokens.alice!.movement!.allowanceCells = 1;
    limitedScene.tokens.bob!.position = { x: 85, y: 85 };
    const limitedPersistence = new MemoryPersistence();
    const limited = new AuthoritativeRoomEngine(roomId, sceneToRoomSchema(limitedScene), limitedScene, 0, limitedPersistence);
    await expect(limited.execute(alice, 'a', 'token.move.commit', {
      commandId: commandId(85), payload: {
        tokenId: 'alice', destination: { column: 2, row: 0 }, expectedTokenRevision: 0,
        expectedNavigationRevision: 0, expectedMovementRevision: 0,
      },
    })).rejects.toMatchObject({ code: 'conflict' });
    expect(limitedPersistence.commits).toHaveLength(0);
  });

  it('validates map and token assets before persistence', async () => {
    const { engine, persistence } = setup();
    await expect(engine.execute(alice, 'a', 'token.create', {
      commandId: commandId(90), payload: { token: {
        id: 'missing', assetId: commandId(999), position: { x: 0, y: 0 }, size: { width: 1, height: 1 }, rotation: 0,
        label: '', ownerId: 'alice', hpCurrent: 1, hpMaximum: 1, hpHidden: false, z: 0,
      } },
    })).rejects.toMatchObject({ code: 'not_found' });
    persistence.assets.set(tokenAssetId, { ...persistence.assets.get(tokenAssetId)!, status: 'processing' });
    await expect(engine.execute(alice, 'a', 'token.create', {
      commandId: commandId(91), payload: { token: {
        id: 'not-ready', assetId: tokenAssetId, position: { x: 0, y: 0 }, size: { width: 1, height: 1 }, rotation: 0,
        label: '', ownerId: 'alice', hpCurrent: 1, hpMaximum: 1, hpHidden: false, z: 0,
      } },
    })).rejects.toMatchObject({ code: 'conflict' });
    persistence.assets.set(tokenAssetId, { ...persistence.assets.get(tokenAssetId)!, status: 'ready', roomId: commandId(998) });
    await expect(engine.execute(alice, 'a', 'token.create', {
      commandId: commandId(92), payload: { token: {
        id: 'wrong-room', assetId: tokenAssetId, position: { x: 0, y: 0 }, size: { width: 1, height: 1 }, rotation: 0,
        label: '', ownerId: 'alice', hpCurrent: 1, hpMaximum: 1, hpHidden: false, z: 0,
      } },
    })).rejects.toMatchObject({ code: 'forbidden' });
    persistence.assets.set(tokenAssetId, {
      ...persistence.assets.get(tokenAssetId)!, roomId, kind: 'map', status: 'ready',
    });
    await expect(engine.execute(alice, 'a', 'token.create', {
      commandId: commandId(94), payload: { token: {
        id: 'wrong-kind', assetId: tokenAssetId, position: { x: 0, y: 0 }, size: { width: 1, height: 1 }, rotation: 0,
        label: '', ownerId: 'alice', hpCurrent: 1, hpMaximum: 1, hpHidden: false, z: 0,
      } },
    })).rejects.toMatchObject({ code: 'conflict' });
    await expect(engine.execute(dm, 'dm', 'map.set', {
      commandId: commandId(93), payload: { map: { assetId: mapAssetId, width: 99, height: 100 } },
    })).rejects.toMatchObject({ code: 'conflict' });
    expect(persistence.commits).toHaveLength(0);
  });

  it('commits and undoes validated shared fog polygons authoritatively', async () => {
    const scene = initialScene();
    scene.map = { assetId: mapAssetId, width: 100, height: 100 };
    const state = sceneToRoomSchema(scene);
    const persistence = new MemoryPersistence();
    const engine = new AuthoritativeRoomEngine(roomId, state, scene, 0, persistence);
    const reveal = { id: 'reveal-a', kind: 'reveal' as const, points: [{ x: 10, y: 10 }, { x: 40, y: 10 }, { x: 40, y: 40 }, { x: 10, y: 40 }] };

    await expect(engine.execute(alice, 'a', 'fog.operation.commit', {
      commandId: commandId(115), payload: { operation: reveal, expectedFogRevision: 0 },
    })).rejects.toMatchObject({ code: 'forbidden' });
    await engine.execute(dm, 'dm', 'fog.operation.commit', {
      commandId: commandId(116), payload: { operation: reveal, expectedFogRevision: 0 },
    });
    expect(engine.canonicalScene.fog).toMatchObject({
      enabled: true, base: 'concealed', revision: 1,
      operations: [{ ...reveal, playerId: null, revision: 1 }],
    });
    expect(state.fog).toMatchObject({ enabled: true, base: 'concealed', revision: 1 });
    expect(state.fog.operations[0]?.points).toHaveLength(4);

    await expect(engine.execute(dm, 'dm', 'fog.operation.commit', {
      commandId: commandId(117), payload: {
        operation: { id: 'stale', kind: 'conceal', points: reveal.points }, expectedFogRevision: 0,
      },
    })).rejects.toMatchObject({ code: 'conflict' });
    await expect(engine.execute(dm, 'dm', 'fog.operation.commit', {
      commandId: commandId(118), payload: {
        operation: { id: 'flat', kind: 'conceal', points: [{ x: 0, y: 0 }, { x: 5, y: 5 }, { x: 10, y: 10 }] }, expectedFogRevision: 1,
      },
    })).rejects.toMatchObject({ code: 'conflict' });
    await engine.execute(dm, 'dm', 'fog.operation.commit', {
      commandId: commandId(119), payload: {
        operation: { id: 'conceal-b', kind: 'conceal', points: [{ x: 20, y: 20 }, { x: 30, y: 20 }, { x: 30, y: 30 }] }, expectedFogRevision: 1,
      },
    });
    await expect(engine.execute(dm, 'dm', 'fog.undo', {
      commandId: commandId(120), payload: { expectedFogRevision: 2, expectedOperationId: 'reveal-a' },
    })).rejects.toMatchObject({ code: 'conflict' });
    await engine.execute(dm, 'dm', 'fog.undo', {
      commandId: commandId(121), payload: { expectedFogRevision: 2, expectedOperationId: 'conceal-b' },
    });
    await engine.execute(dm, 'dm', 'fog.clear', {
      commandId: commandId(122), payload: { expectedFogRevision: 3 },
    });
    expect(engine.canonicalScene.fog).toEqual({
      version: 1, mode: 'shared', enabled: false, base: 'revealed', operations: [], revision: 4,
    });
    expect(persistence.commits.map((commit) => commit.eventType)).toEqual([
      'fog.operation.commit', 'fog.operation.commit', 'fog.undo', 'fog.clear',
    ]);
  });

  it('persists owned drawings with collection and record conflict checks', async () => {
    const scene = initialScene();
    scene.map = { assetId: mapAssetId, width: 100, height: 100 };
    const state = sceneToRoomSchema(scene);
    const persistence = new MemoryPersistence();
    const engine = new AuthoritativeRoomEngine(roomId, state, scene, 0, persistence);
    const drawing = { id: 'route', kind: 'line' as const, points: [{ x: 5, y: 5 }, { x: 30, y: 25 }], color: '#ffcc88', width: 3, fill: null, hidden: false, z: 1 };

    await engine.execute(alice, 'a', 'drawing.create', {
      commandId: commandId(123), payload: { drawing, expectedDrawingRevision: 0 },
    });
    expect(engine.canonicalScene.drawings.route).toEqual({ ...drawing, ownerId: 'alice', revision: 0 });
    expect(state.drawings.get('route')).toMatchObject({ ownerId: 'alice', color: '#ffcc88', revision: 0 });
    expect(state.drawingRevision).toBe(1);
    await expect(engine.execute(bob, 'b', 'drawing.update', {
      commandId: commandId(124), payload: { drawingId: 'route', expectedDrawingRevision: 1, expectedRecordRevision: 0, details: { color: '#ffffff' } },
    })).rejects.toMatchObject({ code: 'forbidden' });
    await engine.execute(dm, 'dm', 'drawing.update', {
      commandId: commandId(125), payload: { drawingId: 'route', expectedDrawingRevision: 1, expectedRecordRevision: 0, details: { width: 6 } },
    });
    await expect(engine.execute(alice, 'a', 'drawing.delete', {
      commandId: commandId(126), payload: { drawingId: 'route', expectedDrawingRevision: 1, expectedRecordRevision: 0 },
    })).rejects.toMatchObject({ code: 'conflict' });
    await engine.execute(alice, 'a', 'drawing.delete', {
      commandId: commandId(127), payload: { drawingId: 'route', expectedDrawingRevision: 2, expectedRecordRevision: 1 },
    });
    expect(engine.canonicalScene.drawings).toEqual({});
    expect(state.drawings.has('route')).toBe(false);
    await engine.execute(dm, 'dm', 'permissions.playerDrawing.set', {
      commandId: commandId(128), payload: { playerDrawing: 'none' },
    });
    await expect(engine.execute(alice, 'a', 'drawing.create', {
      commandId: commandId(129), payload: { drawing: { ...drawing, id: 'blocked' }, expectedDrawingRevision: 3 },
    })).rejects.toMatchObject({ code: 'forbidden' });
    expect(persistence.commits.map((commit) => commit.eventType)).toEqual([
      'drawing.create', 'drawing.update', 'drawing.delete', 'permissions.playerDrawing.set',
    ]);
  });

  it('attributes and expires validated pings without scene persistence', () => {
    expect(createMapPingEvent(alice, { id: 'ping-1', position: { x: 4, y: 8 } }, 1_000)).toEqual({
      id: 'ping-1', position: { x: 4, y: 8 }, userId: 'alice', displayName: 'Alice',
      color: '#899680', serverTimeMs: 1_000, expiresAtMs: 3_500,
    });
    expect(() => createMapPingEvent(alice, { id: '', position: { x: 4, y: 8 } }, 1_000)).toThrow();
  });

  it('runs authoritative initiative and resets movement at each active turn', async () => {
    const scene = initialScene();
    scene.tokens.alice!.movement = { ...createTokenMovementState(), allowanceCells: 6, spentCells: 4 };
    scene.tokens.bob!.movement = { ...createTokenMovementState(), allowanceCells: 5, spentCells: 3 };
    const state = sceneToRoomSchema(scene);
    const persistence = new MemoryPersistence();
    const engine = new AuthoritativeRoomEngine(roomId, state, scene, 0, persistence);

    await engine.execute(alice, 'a', 'initiative.entry.add', {
      commandId: commandId(96), payload: {
        entry: { id: 'alice-turn', tokenId: 'alice', label: 'Alice', score: 12, hidden: false },
        expectedInitiativeRevision: 0,
      },
    });
    await expect(engine.execute(alice, 'a', 'initiative.entry.add', {
      commandId: commandId(97), payload: {
        entry: { id: 'bob-by-alice', tokenId: 'bob', label: 'Bob', score: 14, hidden: false },
        expectedInitiativeRevision: 1,
      },
    })).rejects.toMatchObject({ code: 'forbidden' });
    await engine.execute(bob, 'b', 'initiative.entry.add', {
      commandId: commandId(98), payload: {
        entry: { id: 'bob-turn', tokenId: 'bob', label: 'Bob', score: 14, hidden: false },
        expectedInitiativeRevision: 1,
      },
    });
    await expect(engine.execute(alice, 'a', 'initiative.reorder', {
      commandId: commandId(99), payload: { entryIds: ['bob-turn', 'alice-turn'], expectedInitiativeRevision: 2 },
    })).rejects.toMatchObject({ code: 'forbidden' });
    await engine.execute(dm, 'dm', 'initiative.reorder', {
      commandId: commandId(100), payload: { entryIds: ['bob-turn', 'alice-turn'], expectedInitiativeRevision: 2 },
    });
    await engine.execute(dm, 'dm', 'initiative.start', {
      commandId: commandId(101), payload: { expectedInitiativeRevision: 3 },
    });
    expect(engine.canonicalScene.initiative).toMatchObject({ active: true, round: 1, turnIndex: 0, revision: 4 });
    expect(engine.canonicalScene.tokens.bob).toMatchObject({
      revision: 1, movement: { allowanceCells: 5, spentCells: 0, revision: 1, status: 'idle' },
    });
    expect(state.initiative).toMatchObject({ active: true, round: 1, turnIndex: 0, revision: 4 });
    expect(state.tokens.get('bob')?.movement.spentCells).toBe(0);
    await expect(engine.execute(bob, 'b', 'initiative.entry.remove', {
      commandId: commandId(113), payload: { entryId: 'bob-turn', expectedInitiativeRevision: 4 },
    })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(engine.execute(bob, 'b', 'token.delete', {
      commandId: commandId(114), payload: { tokenId: 'bob', expectedTokenRevision: 1 },
    })).rejects.toMatchObject({ code: 'conflict' });
    await expect(engine.execute(alice, 'a', 'token.move.commit', {
      commandId: commandId(111), payload: {
        tokenId: 'alice', destination: { column: 0, row: 0 }, expectedTokenRevision: 0,
        expectedNavigationRevision: 0, expectedMovementRevision: 0,
      },
    })).rejects.toMatchObject({ code: 'conflict' });
    await expect(engine.execute(alice, 'a', 'token.transform.commit', {
      commandId: commandId(112), payload: {
        tokenId: 'alice', expectedTokenRevision: 0, position: { x: 2, y: 3 }, rotation: 0,
      },
    })).rejects.toMatchObject({ code: 'conflict' });

    await engine.execute(dm, 'dm', 'initiative.advance', {
      commandId: commandId(102), payload: { expectedInitiativeRevision: 4 },
    });
    expect(engine.canonicalScene.tokens.alice).toMatchObject({ revision: 1, movement: { spentCells: 0, revision: 1 } });
    await engine.execute(dm, 'dm', 'initiative.advance', {
      commandId: commandId(103), payload: { expectedInitiativeRevision: 5 },
    });
    expect(engine.canonicalScene.initiative).toMatchObject({ round: 2, turnIndex: 0, revision: 6 });
    expect(engine.canonicalScene.tokens.bob).toMatchObject({ revision: 2, movement: { revision: 2 } });
    await expect(engine.execute(dm, 'dm', 'initiative.advance', {
      commandId: commandId(104), payload: { expectedInitiativeRevision: 5 },
    })).rejects.toMatchObject({ code: 'conflict' });
    expect(persistence.commits.map((commit) => commit.eventType)).toEqual([
      'initiative.entry.add', 'initiative.entry.add', 'initiative.reorder',
      'initiative.start', 'initiative.advance', 'initiative.advance',
    ]);
  });

  it('allows entry owners to edit and remove entries while lifecycle controls remain DM-only', async () => {
    const { engine, persistence } = setup();
    await engine.execute(alice, 'a', 'initiative.entry.add', {
      commandId: commandId(105), payload: {
        entry: { id: 'alice-turn', tokenId: 'alice', label: 'Alice', score: 10, hidden: false },
        expectedInitiativeRevision: 0,
      },
    });
    await engine.execute(alice, 'a', 'initiative.entry.update', {
      commandId: commandId(106), payload: {
        entryId: 'alice-turn', details: { label: 'Alice Ready', score: 17 }, expectedInitiativeRevision: 1,
      },
    });
    await expect(engine.execute(alice, 'a', 'initiative.start', {
      commandId: commandId(107), payload: { expectedInitiativeRevision: 2 },
    })).rejects.toMatchObject({ code: 'forbidden' });
    await engine.execute(dm, 'dm', 'initiative.start', {
      commandId: commandId(108), payload: { expectedInitiativeRevision: 2 },
    });
    await engine.execute(dm, 'dm', 'initiative.stop', {
      commandId: commandId(109), payload: { expectedInitiativeRevision: 3 },
    });
    await engine.execute(alice, 'a', 'initiative.entry.remove', {
      commandId: commandId(110), payload: { entryId: 'alice-turn', expectedInitiativeRevision: 4 },
    });
    expect(engine.canonicalScene.initiative).toEqual({
      version: 1, active: false, round: 1, turnIndex: null, entries: [], revision: 5,
    });
    expect(persistence.commits).toHaveLength(5);
  });

  it('keeps per-session presence ephemeral and outside SceneV2 conversion', () => {
    const state = sceneToRoomSchema(initialScene());
    setConnectionPresence(state, 'tab-a', alice, true);
    setConnectionPresence(state, 'tab-b', alice, true);
    setConnectionPresence(state, 'tab-a', alice, false);
    expect(state.connections.get('tab-a')?.connected).toBe(false);
    expect(state.connections.get('tab-b')?.connected).toBe(true);
    expect(roomSchemaToScene(state)).toEqual(initialScene());
    removeConnectionPresence(state, 'tab-a');
    expect(state.connections.has('tab-a')).toBe(false);
  });

  it('drains pending durable commands during the final checkpoint', async () => {
    const { engine, persistence } = setup();
    const commit = persistence.commitRoomState.bind(persistence);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    persistence.commitRoomState = async (input) => {
      await gate;
      return commit(input);
    };
    const command = engine.execute(dm, 'dm', 'grid.set', {
      commandId: commandId(95),
      payload: { visible: true, cellSize: 20, offset: { x: 0, y: 0 }, distancePerCell: 5, unit: 'ft', snap: true },
    });
    let disposed = false;
    const disposal = engine.dispose().then(() => { disposed = true; });
    await Promise.resolve();
    expect(disposed).toBe(false);
    release();
    await Promise.all([command, disposal]);
    expect(disposed).toBe(true);
    expect(persistence.commits).toHaveLength(1);
  });
});
