import { describe, expect, it } from 'vitest';
import { RoomConnection, RoomPresenceState } from '../packages/room-schema/src/index.js';
import type { ActorProjectionV1 } from '../packages/domain/src/index.js';
import {
  createMultiplayerConnection,
  getConnectedUserIds,
  type ColyseusClientLike,
  type ColyseusRoomLike,
  type ConnectionStatus,
  type SessionStorageLike,
} from '../packages/sync/src/index.js';

class MemoryStorage implements SessionStorageLike {
  values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}

class FakeRoom implements ColyseusRoomLike {
  state = new RoomPresenceState();
  reconnectionToken = 'room:reconnect-token';
  sent: Array<[string, unknown]> = [];
  consented: boolean | undefined;
  stateCallback?: (state: RoomPresenceState) => void;
  leaveCallback?: () => void;
  errorCallback?: (code: number, message: string) => void;
  dropCallback?: (code: number, reason?: string) => void;
  reconnectCallback?: () => void;
  messageCallbacks = new Map<string | number, (message: unknown) => void>();
  send(type: string, message: unknown) { this.sent.push([type, message]); }
  async leave(consented?: boolean) { this.consented = consented; }
  onStateChange(callback: (state: RoomPresenceState) => void) { this.stateCallback = callback; }
  onMessage(type: string | number, callback: (message: unknown) => void) { this.messageCallbacks.set(type, callback); }
  onLeave(callback: () => void) { this.leaveCallback = callback; }
  onError(callback: (code: number, message: string) => void) { this.errorCallback = callback; }
  onDrop(callback: (code: number, reason?: string) => void) { this.dropCallback = callback; }
  onReconnect(callback: () => void) { this.reconnectCallback = callback; }
}

const projection = (overrides: Partial<ActorProjectionV1> = {}): ActorProjectionV1 => ({
  protocolVersion: 1, kind: 'full', streamId: 'stream-a', sceneRevision: 0, projectionRevision: 0,
  streamReset: { kind: 'initial' },
  scene: {
    map: null,
    grid: { type: 'square', visible: true, cellSize: 10, offset: { x: 0, y: 0 }, distancePerCell: 5, unit: 'ft', snap: true },
    tokens: [], drawings: [], initiative: { active: false, round: 0, turnIndex: null, entries: [] },
  },
  sight: { mode: 'unrestricted' }, fog: { mode: 'disabled' }, wallMesh: { segments: [] }, lights: [],
  controls: {
    movement: { canMove: true, canSetPolicy: false, policy: 'owned', expectedNavigationRevision: 0 },
    tokens: { canCreate: false, records: [] },
    drawings: { canCreate: false, canSetPolicy: false, policy: 'own', expectedDrawingRevision: 0, records: [] },
    initiative: { canAdd: false, canReorder: false, canStart: false, canAdvance: false, canStop: false, expectedInitiativeRevision: 0, records: [] },
    fog: { canCommit: false, canUndo: false, canClear: false, expectedFogRevision: 0, latestOperationId: null },
    geometry: { canCreateWall: false, canUpdateWall: false, canDeleteWall: false, canCreateStructure: false, canUpdateStructure: false, canDeleteStructure: false, expectedWallRevision: 0, expectedStructureRevision: 0 },
    perspective: { canUse: false, canSet: false, enabled: false },
  },
  ...overrides,
});

/** Models a P1 transport that delivers its initial/reset snapshot as callbacks attach. */
class InitialResetTransportRoom extends FakeRoom {
  override onMessage(type: string | number, callback: (message: unknown) => void) {
    super.onMessage(type, callback);
    if (type === 'scene.projection.v1') callback(projection());
  }
}

const storageKey = 'hearth:reconnection:10000000-0000-4000-8000-000000000000';
const projectionStorageKey = `${storageKey}:projection`;
const streamMetadata = { streamId: 'stream-a', sceneRevision: 0, projectionRevision: 0 };

describe('Colyseus sync adapter', () => {
  it('connects, validates sends, stores tokens, and reconnects dropped rooms', async () => {
    const first = new FakeRoom();
    const second = new FakeRoom();
    second.reconnectionToken = 'room:new-token';
    const joins: unknown[] = [];
    const reconnects: string[] = [];
    const client: ColyseusClientLike = {
      async joinOrCreate(name, options) { joins.push([name, options]); return first; },
      async reconnect(token) { reconnects.push(token); return second; },
    };
    const storage = new MemoryStorage();
    const statuses: ConnectionStatus[] = [];
    const projections: ActorProjectionV1[] = [];
    const pings: string[] = [];
    const connection = createMultiplayerConnection({
      endpoint: 'ws://example.test',
      roomId: '10000000-0000-4000-8000-000000000000',
      accessToken: 'supabase-token',
      client,
      storage,
      reconnectDelayMs: 0,
      onStatus: (status) => statuses.push(status),
      onProjection: (value) => projections.push(value),
      onPing: (ping) => pings.push(ping.id),
    });
    await connection.connect();
    expect(joins).toEqual([['battle', {
      databaseRoomId: '10000000-0000-4000-8000-000000000000', accessToken: 'supabase-token',
    }]]);
    expect(statuses).toEqual(['connecting', 'online']);
    first.messageCallbacks.get('scene.projection.v1')?.(projection());
    expect(projections).toHaveLength(1);
    expect(storage.getItem(storageKey)).toBe('room:reconnect-token');
    expect(storage.getItem(projectionStorageKey)).toBe(JSON.stringify(streamMetadata));

    connection.send('token.transform.preview', {
      tokenId: 'token', sequence: 1, position: { x: 1, y: 2 }, rotation: 3,
    });
    expect(first.sent).toHaveLength(1);
    expect(() => connection.send('token.transform.preview', {
      tokenId: '', sequence: -1, position: { x: 1, y: 2 }, rotation: 3,
    })).toThrow();
    connection.sendPing({ id: 'ping-1', position: { x: 5, y: 6 } });
    expect(first.sent.at(-1)).toEqual(['map.ping', { id: 'ping-1', position: { x: 5, y: 6 } }]);
    expect(() => connection.sendPing({ id: '', position: { x: 5, y: 6 } })).toThrow();
    first.messageCallbacks.get('map.ping')?.({
      id: 'ping-1', position: { x: 5, y: 6 }, userId: 'alice', displayName: 'Alice', color: '#123abc', serverTimeMs: 1, expiresAtMs: 2,
    });
    expect(pings).toEqual(['ping-1']);

    first.leaveCallback?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(reconnects).toEqual(['room:reconnect-token']);
    expect(statuses).toEqual(['connecting', 'online', 'reconnecting', 'online']);
    expect(connection.getRoom()).toBe(second);
    await connection.disconnect();
    expect(second.consented).toBe(true);
    expect(storage.values.size).toBe(0);
  });

  it('fresh-joins when a stored token has no projection metadata', async () => {
    const room = new FakeRoom();
    const storage = new MemoryStorage();
    storage.setItem(storageKey, 'saved-token');
    let joins = 0;
    const client: ColyseusClientLike = {
      async joinOrCreate() { joins++; return room; },
      async reconnect() { throw new Error('token-only session must not reconnect'); },
    };
    const connection = createMultiplayerConnection({
      endpoint: 'ws://example.test', roomId: '10000000-0000-4000-8000-000000000000', accessToken: 'token',
      client, storage, onStatus() {}, onProjection() {},
    });
    await connection.connect();
    expect(joins).toBe(1);
    expect(storage.getItem(storageKey)).toBe(room.reconnectionToken);
    expect(storage.getItem(projectionStorageKey)).toBeNull();
    await connection.disconnect();
  });

  it('fresh-joins after clearing malformed stored projection metadata', async () => {
    const room = new FakeRoom();
    const storage = new MemoryStorage();
    storage.setItem(storageKey, 'saved-token');
    storage.setItem(projectionStorageKey, '{malformed');
    let joins = 0;
    const connection = createMultiplayerConnection({
      endpoint: 'ws://example.test', roomId: '10000000-0000-4000-8000-000000000000', accessToken: 'token',
      client: {
        async joinOrCreate() { joins++; return room; },
        async reconnect() { throw new Error('malformed session must not reconnect'); },
      },
      storage, onStatus() {}, onProjection() {},
    });

    await connection.connect();
    expect(joins).toBe(1);
    expect(storage.getItem(storageKey)).toBe(room.reconnectionToken);
    expect(storage.getItem(projectionStorageKey)).toBeNull();
    await connection.disconnect();
  });

  it('restores stored projection metadata for continuation delivery', async () => {
    const room = new FakeRoom();
    const storage = new MemoryStorage();
    storage.setItem(storageKey, 'saved-token');
    storage.setItem(projectionStorageKey, JSON.stringify(streamMetadata));
    const accepted: ActorProjectionV1[] = [];
    const connection = createMultiplayerConnection({
      endpoint: 'ws://example.test', roomId: '10000000-0000-4000-8000-000000000000', accessToken: 'token',
      client: { async joinOrCreate() { throw new Error('fresh join should not be used'); }, async reconnect() { return room; } },
      storage, onStatus() {}, onProjection: (value) => accepted.push(value),
    });

    await connection.connect();
    room.messageCallbacks.get('scene.projection.v1')?.(projection({ projectionRevision: 1, streamReset: undefined }));
    expect(accepted).toHaveLength(1);
    expect(accepted[0]?.projectionRevision).toBe(1);
    await connection.disconnect();
  });

  it('clears token metadata before fresh fallback and explicit disconnect', async () => {
    const fallbackRoom = new FakeRoom();
    const storage = new MemoryStorage();
    storage.setItem(storageKey, 'expired-token');
    storage.setItem(projectionStorageKey, JSON.stringify(streamMetadata));
    const connection = createMultiplayerConnection({
      endpoint: 'ws://example.test', roomId: '10000000-0000-4000-8000-000000000000', accessToken: 'token', storage,
      client: {
        async joinOrCreate() { return fallbackRoom; },
        async reconnect() { throw new Error('expired'); },
      },
      onStatus() {}, onProjection() {},
    });

    await connection.connect();
    expect(storage.getItem(projectionStorageKey)).toBeNull();
    expect(storage.getItem(storageKey)).toBe(fallbackRoom.reconnectionToken);
    await connection.disconnect();
    expect(storage.getItem(storageKey)).toBeNull();
    expect(storage.getItem(projectionStorageKey)).toBeNull();
  });

  it('updates status and rotated tokens through drop and reconnect handlers', async () => {
    const room = new FakeRoom();
    const storage = new MemoryStorage();
    const statuses: ConnectionStatus[] = [];
    const projections: ActorProjectionV1[] = [];
    const connection = createMultiplayerConnection({
      endpoint: 'ws://example.test', roomId: '10000000-0000-4000-8000-000000000000', accessToken: 'token', storage,
      client: { async joinOrCreate() { return room; }, async reconnect() { return room; } },
      onStatus: (status) => statuses.push(status), onProjection: (value) => projections.push(value),
    });

    await connection.connect();
    room.reconnectionToken = 'rotated-on-drop';
    room.dropCallback?.(1006, 'network');
    expect(statuses.at(-1)).toBe('reconnecting');
    expect(storage.getItem(storageKey)).toBe('rotated-on-drop');
    expect(storage.getItem(projectionStorageKey)).toBeNull();
    room.reconnectionToken = 'old-token-during-callback';
    room.reconnectCallback?.();
    expect(statuses.at(-1)).toBe('online');
    room.reconnectionToken = 'rotated-on-reconnect';
    await Promise.resolve();
    expect(storage.getItem(storageKey)).toBe('rotated-on-reconnect');
    expect(storage.getItem(projectionStorageKey)).toBeNull();
    expect(projections).toHaveLength(0);
    await connection.disconnect();
  });

  it('correlates command results, rejects failures, and rejects pending requests on disconnect', async () => {
    const room = new FakeRoom();
    const client: ColyseusClientLike = {
      async joinOrCreate() { return room; },
      async reconnect() { return room; },
    };
    const connection = createMultiplayerConnection({
      endpoint: 'ws://example.test', roomId: '10000000-0000-4000-8000-000000000000', accessToken: 'token',
      client, onStatus() {}, onProjection() {}, requestTimeoutMs: 10,
    });
    await connection.connect();
    const first = connection.request('grid.set', {
      commandId: '00000000-0000-4000-8000-000000000001',
      payload: { visible: true, cellSize: 10, offset: { x: 0, y: 0 }, distancePerCell: 5, unit: 'ft', snap: true },
    });
    room.messageCallbacks.get('command.result')?.({
      type: 'grid.set', commandId: '00000000-0000-4000-8000-000000000001', ok: true, sceneRevision: 4,
    });
    await expect(first).resolves.toMatchObject({ commandId: '00000000-0000-4000-8000-000000000001', sceneRevision: 4 });

    const failed = connection.request('token.delete', {
      commandId: '00000000-0000-4000-8000-000000000002',
      payload: { tokenId: 'token', expectedTokenRevision: 1 },
    });
    room.messageCallbacks.get('command.result')?.({
      type: 'token.delete', commandId: '00000000-0000-4000-8000-000000000002', ok: false,
      code: 'conflict', message: 'stale',
    });
    await expect(failed).rejects.toMatchObject({ code: 'conflict', message: 'stale' });

    const timedOut = connection.request('map.set', {
      commandId: '00000000-0000-4000-8000-000000000004', payload: { map: null },
    });
    await expect(timedOut).rejects.toThrow(/timed out/);

    const pending = connection.request('permissions.playerMovement.set', {
      commandId: '00000000-0000-4000-8000-000000000003', payload: { playerMovement: 'all' },
    });
    await connection.disconnect();
    await expect(pending).rejects.toThrow(/closed/);
  });

  it('rejects requests cleanly before a room is connected', async () => {
    const connection = createMultiplayerConnection({
      endpoint: 'ws://example.test', roomId: '10000000-0000-4000-8000-000000000000', accessToken: 'token',
      client: { async joinOrCreate() { return new FakeRoom(); }, async reconnect() { return new FakeRoom(); } },
      onStatus() {}, onProjection() {},
    });
    await expect(connection.request('grid.set', {
      commandId: '00000000-0000-4000-8000-000000000005',
      payload: { visible: true, cellSize: 10, offset: { x: 0, y: 0 }, distancePerCell: 5, unit: 'ft', snap: true },
    })).rejects.toThrow('Multiplayer room is not connected.');
  });

  it('times out a stalled initial connection and closes a late room', async () => {
    let resolveJoin!: (room: ColyseusRoomLike) => void;
    const lateRoom = new FakeRoom();
    const connection = createMultiplayerConnection({
      endpoint: 'ws://example.test', roomId: '10000000-0000-4000-8000-000000000000', accessToken: 'token',
      client: {
        joinOrCreate: () => new Promise((resolve) => { resolveJoin = resolve; }),
        async reconnect() { return new FakeRoom(); },
      },
      connectTimeoutMs: 5, onStatus() {}, onProjection() {},
    });
    await expect(connection.connect()).rejects.toThrow('Multiplayer connection timed out.');
    expect(connection.getRoom()).toBeUndefined();
    resolveJoin(lateRoom);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(lateRoom.consented).toBe(false);
  });

  it('coalesces concurrent connection attempts', async () => {
    const room = new FakeRoom();
    let joins = 0;
    let resolveJoin!: (room: ColyseusRoomLike) => void;
    const connection = createMultiplayerConnection({
      endpoint: 'ws://example.test', roomId: '10000000-0000-4000-8000-000000000000', accessToken: 'token',
      client: {
        joinOrCreate: () => { joins++; return new Promise((resolve) => { resolveJoin = resolve; }); },
        async reconnect() { return room; },
      },
      onStatus() {}, onProjection() {},
    });
    const first = connection.connect();
    const second = connection.connect();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(joins).toBe(1);
    resolveJoin(room);
    await Promise.all([first, second]);
    await connection.disconnect();
  });

  it('does not join fresh after being disconnected during stored-token reconnect', async () => {
    const storage = new MemoryStorage();
    const key = 'hearth:reconnection:10000000-0000-4000-8000-000000000000';
    storage.setItem(key, 'saved-token');
    storage.setItem(projectionStorageKey, JSON.stringify(streamMetadata));
    let rejectReconnect!: (error: Error) => void;
    let joins = 0;
    const connection = createMultiplayerConnection({
      endpoint: 'ws://example.test', roomId: '10000000-0000-4000-8000-000000000000', accessToken: 'token', storage,
      client: {
        async joinOrCreate() { joins++; return new FakeRoom(); },
        reconnect: () => new Promise((_, reject) => { rejectReconnect = reject; }),
      },
      onStatus() {}, onProjection() {},
    });
    const connecting = connection.connect();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await connection.disconnect();
    storage.setItem(key, 'replacement-token');
    rejectReconnect(new Error('closed'));
    await connecting;
    expect(joins).toBe(0);
    expect(storage.getItem(key)).toBe('replacement-token');
  });

  it('accepts only validated projection stream revisions', async () => {
    const room = new FakeRoom();
    const accepted: ActorProjectionV1[] = [];
    const errors: Error[] = [];
    const connection = createMultiplayerConnection({
      endpoint: 'ws://example.test', roomId: '10000000-0000-4000-8000-000000000000', accessToken: 'token',
      client: { async joinOrCreate() { return room; }, async reconnect() { return room; } },
      onStatus() {}, onProjection: (value) => accepted.push(value), onError: (error) => errors.push(error),
    });
    await connection.connect();
    const emit = (value: unknown) => room.messageCallbacks.get('scene.projection.v1')?.(value);
    emit(projection());
    emit(projection());
    emit(projection({ projectionRevision: 1, streamReset: undefined, sceneRevision: -1 }));
    emit(projection({ projectionRevision: 1, streamReset: undefined }));
    emit(projection({ streamId: 'stream-b', streamReset: { kind: 'initial' } }));
    emit({ ...projection({ projectionRevision: 2, streamReset: undefined }), unknown: true });
    expect(accepted).toHaveLength(3);
    expect(accepted[1]?.projectionRevision).toBe(1);
    expect(accepted[2]?.streamId).toBe('stream-b');
    expect(errors).toHaveLength(3);
    await connection.disconnect();
  });

  it('accepts a P1-shaped initial/reset snapshot delivered by the transport fixture', async () => {
    const room = new InitialResetTransportRoom();
    const accepted: ActorProjectionV1[] = [];
    const connection = createMultiplayerConnection({
      endpoint: 'ws://example.test', roomId: '10000000-0000-4000-8000-000000000000', accessToken: 'token',
      client: { async joinOrCreate() { return room; }, async reconnect() { return room; } },
      onStatus() {}, onProjection: (value) => accepted.push(value),
    });

    await connection.connect();
    expect(accepted).toHaveLength(1);
    expect(accepted[0]?.projectionRevision).toBe(0);
    expect(accepted[0]?.streamReset).toEqual({ kind: 'initial' });
    await connection.disconnect();
  });

  it('deduplicates connected users across multiple session records', () => {
    const state = new RoomPresenceState();
    state.connections.set('tab-a', new RoomConnection({ userId: 'alice', displayName: 'Alice', role: 'player', connected: false }));
    state.connections.set('tab-b', new RoomConnection({ userId: 'alice', displayName: 'Alice', role: 'player', connected: true }));
    state.connections.set('tab-c', new RoomConnection({ userId: 'bob', displayName: 'Bob', role: 'player', connected: true }));
    expect(getConnectedUserIds(state)).toEqual(new Set(['alice', 'bob']));
  });
});
