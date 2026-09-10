import { afterEach, describe, expect, it, vi } from 'vitest';
import { roomSchemaToScene, sceneToRoomSchema } from '../packages/room-schema/src/index.js';
import { createEmptyScene, type SceneV2 } from '../packages/scene/src/index.js';
import { authenticateRoomClient, type Actor, type AuthProvider, type CommitInput, type Persistence, type RoomAsset } from '../apps/multiplayer/src/contracts.js';
import { AuthoritativeRoomEngine, CommandError } from '../apps/multiplayer/src/engine.js';
import { removeConnectionPresence, setConnectionPresence } from '../apps/multiplayer/src/room.js';

const roomId = '10000000-0000-4000-8000-000000000000';
const commandId = (value: number) => `00000000-0000-4000-8000-${value.toString().padStart(12, '0')}`;
const dm: Actor = { userId: 'dm', role: 'dm', displayName: 'DM' };
const alice: Actor = { userId: 'alice', role: 'player', displayName: 'Alice' };
const bob: Actor = { userId: 'bob', role: 'player', displayName: 'Bob' };
const tokenAssetId = '20000000-0000-4000-8000-000000000000';
const mapAssetId = '30000000-0000-4000-8000-000000000000';

function initialScene(): SceneV2 {
  const scene = createEmptyScene();
  scene.tokens.alice = {
    id: 'alice', assetId: 'asset-a', position: { x: 1, y: 2 }, size: { width: 1, height: 1 }, rotation: 0,
    label: 'Alice', ownerId: 'alice', hpCurrent: 10, hpMaximum: 10, hpHidden: false, z: 1, revision: 0,
  };
  scene.tokens.bob = {
    id: 'bob', assetId: 'asset-b', position: { x: 3, y: 4 }, size: { width: 1, height: 1 }, rotation: 0,
    label: 'Bob', ownerId: 'bob', hpCurrent: 8, hpMaximum: 8, hpHidden: false, z: 2, revision: 0,
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
