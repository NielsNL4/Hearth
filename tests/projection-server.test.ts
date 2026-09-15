import { describe, expect, it, vi } from 'vitest';
import type { Client } from '@colyseus/core';
import { parseActorProjectionV1 } from '@hearth/domain';
import { createEmptyScene, createTokenMovementState, type SceneV2 } from '../packages/scene/src/index.js';
import { createBattleRoom } from '../apps/multiplayer/src/room.js';
import { buildActorProjectionV1 } from '../apps/multiplayer/src/projection.js';
import type { Actor, AuthProvider, CommitInput, Persistence, RoomAsset } from '../apps/multiplayer/src/contracts.js';

const roomId = '10000000-0000-4000-8000-000000000000';
const commandId = (value: number) => `00000000-0000-4000-8000-${value.toString().padStart(12, '0')}`;
const dm: Actor = { userId: 'dm', role: 'dm', displayName: 'DM' };
const alice: Actor = { userId: 'alice', role: 'player', displayName: 'Alice' };

function canonicalScene(): SceneV2 {
  const scene = createEmptyScene();
  scene.map = { assetId: 'safe-map-asset', width: 100, height: 100 };
  scene.tokens.alice = {
    id: 'alice', assetId: 'safe-token-asset', position: { x: 2, y: 3 }, size: { width: 1, height: 1 }, rotation: 0,
    label: 'Alice', ownerId: 'alice', hpCurrent: 7, hpMaximum: 10, hpHidden: true, z: 0, movement: createTokenMovementState(), revision: 4,
  };
  scene.tokens['secret-enemy'] = {
    id: 'secret-enemy', assetId: 'secret-token-asset', position: { x: 777, y: 778 }, size: { width: 1, height: 1 }, rotation: 0,
    label: 'Secret enemy', ownerId: 'secret-owner', hpCurrent: 99, hpMaximum: 99, hpHidden: false, z: 0, movement: createTokenMovementState(), revision: 8,
  };
  scene.walls['secret-wall'] = {
    id: 'secret-wall', type: 'blocking', start: { x: 700, y: 700 }, end: { x: 700, y: 720 }, height: 10, thickness: 1,
    elevation: 0, material: 'default', openings: [], revision: 2,
  };
  scene.structures['secret-structure'] = {
    id: 'secret-structure', kind: 'block', position: { x: 701, y: 701 }, size: { width: 4, height: 4 }, rotation: 0,
    label: 'Secret structure', z: 0, material: 'default', baseElevation: 0, slabHeight: 1, revision: 3,
  };
  scene.lights['secret-light'] = {
    id: 'secret-light', position: { x: 702, y: 702 }, radius: 20, color: '#ffffff', intensity: 1, enabled: true, revision: 1,
  };
  scene.drawings.secret = {
    id: 'secret', kind: 'polygon', points: [{ x: 700, y: 700 }, { x: 710, y: 700 }, { x: 710, y: 710 }],
    color: '#fff', width: 1, fill: null, hidden: true, ownerId: 'secret-owner', z: 0, revision: 1,
  };
  scene.initiative.entries = [
    { id: 'secret-initiative', tokenId: 'secret-enemy', label: 'Secret turn', score: 20, hidden: true },
  ];
  scene.fog.enabled = true;
  scene.fog.base = 'concealed';
  scene.fog.operations = [{ id: 'secret-fog-operation', kind: 'reveal', points: [{ x: 700, y: 700 }, { x: 710, y: 700 }, { x: 710, y: 710 }], playerId: 'secret-owner', revision: 1 }];
  scene.fog.revision = 1;
  return scene;
}

class MemoryPersistence implements Persistence {
  revision = 7;
  commits: CommitInput[] = [];
  assets = new Map<string, RoomAsset>();

  async loadRoomState() { return { roomId, sceneRevision: this.revision, scene: canonicalScene() }; }
  async getRoomAsset(assetId: string) { return this.assets.get(assetId) ?? null; }
  async commitRoomState(input: CommitInput) {
    expect(input.expectedSceneRevision).toBe(this.revision);
    this.commits.push(structuredClone(input));
    this.revision++;
    return { roomId, sceneRevision: this.revision, eventId: this.revision };
  }
  async reserveRoomAsset() { return { id: commandId(999), roomId, status: 'reserved', sourceObjectKey: 'source', outputObjectPrefix: 'output/' }; }
}

type FakeClient = Client & { sent: Array<[string, unknown]>; failNextSend: boolean; failNextCommandResultSend: boolean };
function fakeClient(sessionId: string, actor: Actor): FakeClient {
  const sent: Array<[string, unknown]> = [];
  const client = {
    sessionId,
    auth: actor,
    sent,
    failNextSend: false,
    failNextCommandResultSend: false,
    send: vi.fn((type: string, message: unknown) => {
      if (type === 'command.result' && client.failNextCommandResultSend) {
        client.failNextCommandResultSend = false;
        throw new Error('controlled acknowledgement send failure');
      }
      if (client.failNextSend) {
        client.failNextSend = false;
        throw new Error('controlled recipient send failure');
      }
      sent.push([type, message]);
    }),
  };
  return client as unknown as FakeClient;
}

const projectionMessages = (client: FakeClient) => client.sent.filter(([type]) => type === 'scene.projection.v1').map(([, message]) => message as Record<string, any>);

describe('server actor projection transport', () => {
  it('builds DM/editor and fog-enabled player projections from one canonical scene', () => {
    const scene = canonicalScene();
    const dmProjection = buildActorProjectionV1(scene, dm, { streamId: 'stream-a', sceneRevision: 7, projectionRevision: 0 });
    const playerProjection = buildActorProjectionV1(scene, alice, { streamId: 'stream-a', sceneRevision: 7, projectionRevision: 0 });

    expect(dmProjection.wallMesh.segments).toHaveLength(1);
    expect(dmProjection.fog).toEqual({ mode: 'disabled' });
    expect(dmProjection.controls.geometry.editableGeometry?.walls[0]?.wallId).toBe('secret-wall');
    expect(dmProjection.lights).toHaveLength(1);
    expect(dmProjection.scene.drawings.map(({ id }) => id)).toEqual(['secret']);
    expect(dmProjection.scene.initiative.entries).toEqual([{ id: 'secret-initiative', tokenId: 'secret-enemy', label: 'Secret turn', score: 20 }]);
    expect(playerProjection.sight).toEqual({ mode: 'restricted', polygons: [] });
    expect(playerProjection.fog).toEqual({ mode: 'visible-regions', polygons: [] });
    expect(playerProjection.scene.tokens.map(({ id }) => id)).toEqual(['alice']);
    expect(playerProjection.scene.tokens[0]).not.toHaveProperty('hp');
    expect(playerProjection.wallMesh.segments).toEqual([]);
    expect(playerProjection.lights).toEqual([]);
    expect(playerProjection.scene.drawings).toEqual([]);
    expect(playerProjection.scene.initiative.entries).toEqual([]);

    const serialized = JSON.stringify(playerProjection);
    for (const sentinel of ['secret-wall', 'secret-structure', 'secret-light', 'secret-fog-operation', 'secret-owner', '777', '99']) {
      expect(serialized).not.toContain(sentinel);
    }
  });

  it('keeps shared state presence-only and targets initial/update projections around durable persistence', async () => {
    const persistence = new MemoryPersistence();
    const auth: AuthProvider = {
      async verifyAccessToken() { return { userId: alice.userId }; },
      async getMembership(_room, userId) { return userId === dm.userId ? dm : userId === alice.userId ? alice : null; },
    };
    const BattleRoom = createBattleRoom({ auth, persistence });
    const room = new BattleRoom();
    await room.onCreate({ databaseRoomId: roomId });
    const dmClient = fakeClient('dm-session', dm);
    const playerClient = fakeClient('player-session', alice);
    room.onJoin(dmClient);
    room.onJoin(playerClient);
    expect(projectionMessages(dmClient)).toHaveLength(1);
    expect(projectionMessages(playerClient)).toHaveLength(1);
    expect(projectionMessages(playerClient)[0]?.streamReset).toEqual({ kind: 'initial' });
    expect(room.state).not.toHaveProperty('tokens');
    expect(room.state).not.toHaveProperty('walls');
    expect(room.state).not.toHaveProperty('coordinateSystem');
    expect(JSON.stringify(room.state)).not.toContain('secret-wall');
    expect(JSON.stringify(room.state)).not.toContain('777');

    const handleCommand = (room as unknown as { handleCommand: (client: Client, type: string, message: unknown) => Promise<void> }).handleCommand.bind(room);
    await handleCommand(dmClient, 'structure.create', {
      commandId: commandId(1),
      payload: { structure: { id: 'new-structure', kind: 'block', position: { x: 10, y: 10 }, size: { width: 2, height: 2 }, rotation: 0, label: 'New', z: 0, material: 'default', baseElevation: 0, slabHeight: 1 }, expectedStructureRevision: 0 },
    });
    expect(persistence.commits).toHaveLength(1);
    expect(projectionMessages(dmClient)).toHaveLength(2);
    expect(projectionMessages(playerClient)).toHaveLength(2);
    expect(projectionMessages(dmClient)[0]?.streamId).toBe(projectionMessages(dmClient)[1]?.streamId);
    expect(projectionMessages(dmClient)[0]?.streamReset).toEqual({ kind: 'initial' });
    expect(projectionMessages(dmClient)[1]?.streamReset).toBeUndefined();
    expect(projectionMessages(dmClient)[1]?.projectionRevision).toBe(1);
    expect(parseActorProjectionV1(projectionMessages(dmClient)[1]!, {
      streamId: projectionMessages(dmClient)[0]!.streamId,
      sceneRevision: projectionMessages(dmClient)[0]!.sceneRevision,
      projectionRevision: projectionMessages(dmClient)[0]!.projectionRevision,
    })).toEqual(projectionMessages(dmClient)[1]);
    expect(dmClient.sent.map(([type]) => type)).toEqual(['scene.projection.v1', 'scene.projection.v1', 'command.result']);
    expect(projectionMessages(dmClient)[1]?.controls.geometry.editableGeometry?.structures.some((value: { structureId: string }) => value.structureId === 'new-structure')).toBe(true);

    await handleCommand(dmClient, 'structure.create', {
      commandId: commandId(1),
      payload: { structure: { id: 'new-structure', kind: 'block', position: { x: 10, y: 10 }, size: { width: 2, height: 2 }, rotation: 0, label: 'New', z: 0, material: 'default', baseElevation: 0, slabHeight: 1 }, expectedStructureRevision: 0 },
    });
    expect(persistence.commits).toHaveLength(1);
    expect(projectionMessages(dmClient)).toHaveLength(2);
    expect(projectionMessages(playerClient)).toHaveLength(2);
    await room.onDispose();
  });

  it('keeps acknowledgement success and other recipients updated when a player projection send fails', async () => {
    const persistence = new MemoryPersistence();
    const auth: AuthProvider = {
      async verifyAccessToken() { return { userId: dm.userId }; },
      async getMembership(_room, userId) { return userId === dm.userId ? dm : userId === alice.userId ? alice : null; },
    };
    const BattleRoom = createBattleRoom({ auth, persistence });
    const room = new BattleRoom();
    await room.onCreate({ databaseRoomId: roomId });
    const dmClient = fakeClient('dm-session', dm);
    const playerClient = fakeClient('player-session', alice);
    room.onJoin(dmClient);
    room.onJoin(playerClient);
    playerClient.failNextSend = true;
    const handleCommand = (room as unknown as { handleCommand: (client: Client, type: string, message: unknown) => Promise<void> }).handleCommand.bind(room);
    await handleCommand(dmClient, 'structure.create', {
      commandId: commandId(2),
      payload: { structure: { id: 'post-failure-structure', kind: 'block', position: { x: 10, y: 10 }, size: { width: 2, height: 2 }, rotation: 0, label: 'New', z: 0, material: 'default', baseElevation: 0, slabHeight: 1 }, expectedStructureRevision: 0 },
    });
    expect(persistence.commits).toHaveLength(1);
    expect(projectionMessages(dmClient)).toHaveLength(2);
    expect(projectionMessages(playerClient)).toHaveLength(2);
    expect(projectionMessages(playerClient)[1]?.fog).toEqual({ mode: 'visible-regions', polygons: [] });
    expect(dmClient.sent.at(-1)).toEqual(['command.result', expect.objectContaining({ ok: true })]);
    await room.onDispose();
  });

  it('gives fog-disabled players safe derived wall mesh/light inputs and filters open doors', () => {
    const scene = canonicalScene();
    scene.fog.enabled = false;
    scene.walls['open-door'] = {
      id: 'open-door', type: 'door', doorState: 'open', start: { x: 40, y: 40 }, end: { x: 50, y: 40 }, height: 10,
      thickness: 1, elevation: 0, material: 'default', openings: [], revision: 0,
    };
    const projection = buildActorProjectionV1(scene, alice, { streamId: 'stream-a', sceneRevision: 7, projectionRevision: 0 });
    expect(projection.sight).toEqual({ mode: 'unrestricted' });
    expect(projection.fog).toEqual({ mode: 'disabled' });
    expect(projection.wallMesh.segments.map(({ id }) => id)).toHaveLength(1);
    expect(projection.wallMesh.segments[0]?.id).not.toContain('secret-wall');
    expect(projection.lights.map(({ id }) => id)).toHaveLength(1);
    expect(projection.lights[0]?.id).not.toContain('secret-light');
  });

  it('does not emit a false negative when the successful acknowledgement send fails after persistence', async () => {
    const persistence = new MemoryPersistence();
    const auth: AuthProvider = {
      async verifyAccessToken() { return { userId: dm.userId }; },
      async getMembership() { return dm; },
    };
    const BattleRoom = createBattleRoom({ auth, persistence });
    const room = new BattleRoom();
    await room.onCreate({ databaseRoomId: roomId });
    const client = fakeClient('dm-session', dm);
    room.onJoin(client);
    client.failNextCommandResultSend = true;
    const handleCommand = (room as unknown as { handleCommand: (client: Client, type: string, message: unknown) => Promise<void> }).handleCommand.bind(room);
    await expect(handleCommand(client, 'structure.create', {
      commandId: commandId(3),
      payload: { structure: { id: 'ack-failure-structure', kind: 'block', position: { x: 10, y: 10 }, size: { width: 2, height: 2 }, rotation: 0, label: 'New', z: 0, material: 'default', baseElevation: 0, slabHeight: 1 }, expectedStructureRevision: 0 },
    })).resolves.toBeUndefined();
    expect(persistence.commits).toHaveLength(1);
    expect(client.sent.some(([type, message]) => type === 'command.result' && (message as { ok?: boolean }).ok === false)).toBe(false);
    await room.onDispose();
  });

  it('suppresses transform previews from presence and projection messages while preserving engine authority', async () => {
    const persistence = new MemoryPersistence();
    const auth: AuthProvider = {
      async verifyAccessToken() { return { userId: alice.userId }; },
      async getMembership() { return alice; },
    };
    const BattleRoom = createBattleRoom({ auth, persistence });
    const room = new BattleRoom();
    await room.onCreate({ databaseRoomId: roomId });
    const client = fakeClient('player-session', alice);
    room.onJoin(client);
    const initialProjectionCount = projectionMessages(client).length;
    const handleCommand = (room as unknown as { handleCommand: (client: Client, type: string, message: unknown) => Promise<void> }).handleCommand.bind(room);
    await handleCommand(client, 'token.transform.preview', { tokenId: 'alice', sequence: 1, position: { x: 90, y: 91 }, rotation: 30 });
    expect(projectionMessages(client)).toHaveLength(initialProjectionCount);
    expect(client.sent.some(([type]) => type === 'token.preview.v1')).toBe(false);
    expect(JSON.stringify(room.state)).not.toContain('90');
    expect(JSON.stringify(room.state)).not.toContain('secret-wall');
    await room.onDispose();
  });

  it('sends one fresh initial projection on reconnect', async () => {
    const persistence = new MemoryPersistence();
    const auth: AuthProvider = {
      async verifyAccessToken() { return { userId: alice.userId }; },
      async getMembership() { return alice; },
    };
    const BattleRoom = createBattleRoom({ auth, persistence });
    const room = new BattleRoom();
    await room.onCreate({ databaseRoomId: roomId });
    const client = fakeClient('player-session', alice);
    room.onJoin(client);
    expect(projectionMessages(client)).toHaveLength(1);
    expect(projectionMessages(client)[0]?.streamReset).toEqual({ kind: 'initial' });
    room.onReconnect(client);
    expect(projectionMessages(client)).toHaveLength(2);
    expect(projectionMessages(client)[1]?.streamReset).toBeUndefined();
    expect(projectionMessages(client)[0]?.streamId).toBe(projectionMessages(client)[1]?.streamId);
    const first = projectionMessages(client)[0]!;
    const second = projectionMessages(client)[1]!;
    expect(parseActorProjectionV1(second, {
      streamId: first.streamId,
      sceneRevision: first.sceneRevision,
      projectionRevision: first.projectionRevision,
    })).toEqual(second);
    await room.onDispose();

    const nextRoom = new BattleRoom();
    await nextRoom.onCreate({ databaseRoomId: roomId });
    const nextClient = fakeClient('next-player-session', alice);
    nextRoom.onJoin(nextClient);
    expect(projectionMessages(nextClient)[0]?.streamId).not.toBe(projectionMessages(client)[0]?.streamId);
    await nextRoom.onDispose();
  });

  it('keeps independent parser-validated delivery streams per recipient across reconnect and room restart', async () => {
    const persistence = new MemoryPersistence();
    const auth: AuthProvider = {
      async verifyAccessToken() { return { userId: dm.userId }; },
      async getMembership(_room, userId) { return userId === dm.userId ? dm : userId === alice.userId ? alice : null; },
    };
    const BattleRoom = createBattleRoom({ auth, persistence });
    const room = new BattleRoom();
    await room.onCreate({ databaseRoomId: roomId });
    const firstDm = fakeClient('incarnation-dm', dm);
    const firstPlayer = fakeClient('incarnation-player', alice);
    room.onJoin(firstDm);
    room.onJoin(firstPlayer);
    const dmFirst = projectionMessages(firstDm)[0]!;
    const playerFirst = projectionMessages(firstPlayer)[0]!;
    expect(dmFirst.projectionRevision).toBe(0);
    expect(playerFirst.projectionRevision).toBe(0);
    expect(dmFirst.streamReset).toEqual({ kind: 'initial' });
    expect(playerFirst.streamReset).toEqual({ kind: 'initial' });

    const handleCommand = (room as unknown as { handleCommand: (client: Client, type: string, message: unknown) => Promise<void> }).handleCommand.bind(room);
    await handleCommand(firstDm, 'structure.create', {
      commandId: commandId(4),
      payload: { structure: { id: 'independent-stream-structure', kind: 'block', position: { x: 10, y: 10 }, size: { width: 2, height: 2 }, rotation: 0, label: 'New', z: 0, material: 'default', baseElevation: 0, slabHeight: 1 }, expectedStructureRevision: 0 },
    });
    const dmSecond = projectionMessages(firstDm)[1]!;
    const playerSecond = projectionMessages(firstPlayer)[1]!;
    expect(dmSecond.projectionRevision).toBe(1);
    expect(playerSecond.projectionRevision).toBe(1);
    expect(dmSecond.streamReset).toBeUndefined();
    expect(playerSecond.streamReset).toBeUndefined();
    expect(parseActorProjectionV1(dmSecond, { streamId: dmFirst.streamId, sceneRevision: dmFirst.sceneRevision, projectionRevision: dmFirst.projectionRevision })).toEqual(dmSecond);
    expect(parseActorProjectionV1(playerSecond, { streamId: playerFirst.streamId, sceneRevision: playerFirst.sceneRevision, projectionRevision: playerFirst.projectionRevision })).toEqual(playerSecond);

    room.onReconnect(firstDm);
    room.onReconnect(firstPlayer);
    const dmReconnect = projectionMessages(firstDm)[2]!;
    const playerReconnect = projectionMessages(firstPlayer)[2]!;
    expect(dmReconnect.projectionRevision).toBe(2);
    expect(playerReconnect.projectionRevision).toBe(2);
    expect(dmReconnect.streamReset).toBeUndefined();
    expect(playerReconnect.streamReset).toBeUndefined();
    expect(parseActorProjectionV1(dmReconnect, { streamId: dmSecond.streamId, sceneRevision: dmSecond.sceneRevision, projectionRevision: dmSecond.projectionRevision })).toEqual(dmReconnect);
    expect(parseActorProjectionV1(playerReconnect, { streamId: playerSecond.streamId, sceneRevision: playerSecond.sceneRevision, projectionRevision: playerSecond.projectionRevision })).toEqual(playerReconnect);
    await room.onDispose();

    const restartedRoom = new BattleRoom();
    await restartedRoom.onCreate({ databaseRoomId: roomId });
    const restartedDm = fakeClient('incarnation-dm', dm);
    const restartedPlayer = fakeClient('incarnation-player', alice);
    restartedRoom.onJoin(restartedDm);
    restartedRoom.onJoin(restartedPlayer);
    const restartedDmFirst = projectionMessages(restartedDm)[0]!;
    const restartedPlayerFirst = projectionMessages(restartedPlayer)[0]!;
    expect(restartedDmFirst.projectionRevision).toBe(0);
    expect(restartedPlayerFirst.projectionRevision).toBe(0);
    expect(restartedDmFirst.streamReset).toEqual({ kind: 'initial' });
    expect(restartedPlayerFirst.streamReset).toEqual({ kind: 'initial' });
    expect(restartedDmFirst.streamId).not.toBe(dmReconnect.streamId);
    expect(restartedPlayerFirst.streamId).not.toBe(playerReconnect.streamId);
    expect(parseActorProjectionV1(restartedDmFirst, { streamId: dmReconnect.streamId, sceneRevision: dmReconnect.sceneRevision, projectionRevision: dmReconnect.projectionRevision })).toEqual(restartedDmFirst);
    expect(parseActorProjectionV1(restartedPlayerFirst, { streamId: playerReconnect.streamId, sceneRevision: playerReconnect.sceneRevision, projectionRevision: playerReconnect.projectionRevision })).toEqual(restartedPlayerFirst);
    await restartedRoom.onDispose();
  });
});
