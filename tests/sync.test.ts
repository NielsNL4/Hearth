import { describe, expect, it } from 'vitest';
import { createEmptyScene } from '../packages/scene/src/index.js';
import { RoomConnection, sceneToRoomSchema, type RoomScene } from '../packages/room-schema/src/index.js';
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
  state: RoomScene = sceneToRoomSchema(createEmptyScene());
  reconnectionToken = 'room:reconnect-token';
  sent: Array<[string, unknown]> = [];
  consented: boolean | undefined;
  stateCallback?: (state: RoomScene) => void;
  leaveCallback?: () => void;
  errorCallback?: (code: number, message: string) => void;
  dropCallback?: (code?: number) => void;
  reconnectCallback?: () => void;
  messageCallbacks = new Map<string | number, (message: unknown) => void>();
  send(type: string, message: unknown) { this.sent.push([type, message]); }
  async leave(consented?: boolean) { this.consented = consented; }
  onStateChange(callback: (state: RoomScene) => void) { this.stateCallback = callback; }
  onMessage(type: string | number, callback: (message: unknown) => void) { this.messageCallbacks.set(type, callback); }
  onDrop(callback: (code?: number) => void) { this.dropCallback = callback; }
  onReconnect(callback: () => void) { this.reconnectCallback = callback; }
  onLeave(callback: () => void) { this.leaveCallback = callback; }
  onError(callback: (code: number, message: string) => void) { this.errorCallback = callback; }
}

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
    const states: RoomScene[] = [];
    const connection = createMultiplayerConnection({
      endpoint: 'ws://example.test',
      roomId: '10000000-0000-4000-8000-000000000000',
      accessToken: 'supabase-token',
      client,
      storage,
      reconnectDelayMs: 0,
      onStatus: (status) => statuses.push(status),
      onState: (state) => states.push(state),
    });
    await connection.connect();
    expect(joins).toEqual([['battle', {
      roomId: '10000000-0000-4000-8000-000000000000', accessToken: 'supabase-token',
    }]]);
    expect(statuses).toEqual(['connecting', 'online']);
    expect(states).toEqual([first.state]);
    expect([...storage.values.values()]).toEqual(['room:reconnect-token']);

    connection.send('token.transform.preview', {
      tokenId: 'token', sequence: 1, position: { x: 1, y: 2 }, rotation: 3,
    });
    expect(first.sent).toHaveLength(1);
    expect(() => connection.send('token.transform.preview', {
      tokenId: '', sequence: -1, position: { x: 1, y: 2 }, rotation: 3,
    })).toThrow();

    first.dropCallback?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(reconnects).toEqual([]);
    expect(statuses.at(-1)).toBe('reconnecting');
    first.reconnectCallback?.();
    expect(statuses.at(-1)).toBe('online');
    first.leaveCallback?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(reconnects).toEqual(['room:reconnect-token']);
    expect(statuses).toEqual(['connecting', 'online', 'reconnecting', 'online', 'reconnecting', 'online']);
    expect(connection.getRoom()).toBe(second);
    await connection.disconnect();
    expect(second.consented).toBe(true);
    expect(storage.values.size).toBe(0);
  });

  it('tries an injected stored reconnection token before joining fresh', async () => {
    const room = new FakeRoom();
    const storage = new MemoryStorage();
    storage.setItem('hearth:reconnection:10000000-0000-4000-8000-000000000000', 'saved-token');
    let joins = 0;
    const client: ColyseusClientLike = {
      async joinOrCreate() { joins++; return room; },
      async reconnect(token) { expect(token).toBe('saved-token'); return room; },
    };
    const connection = createMultiplayerConnection({
      endpoint: 'ws://example.test', roomId: '10000000-0000-4000-8000-000000000000', accessToken: 'token',
      client, storage, onStatus() {}, onState() {},
    });
    await connection.connect();
    expect(joins).toBe(0);
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
      client, onStatus() {}, onState() {}, requestTimeoutMs: 10,
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

  it('deduplicates connected users across multiple session records', () => {
    const state = sceneToRoomSchema(createEmptyScene());
    state.connections.set('tab-a', new RoomConnection({ userId: 'alice', displayName: 'Alice', role: 'player', connected: false }));
    state.connections.set('tab-b', new RoomConnection({ userId: 'alice', displayName: 'Alice', role: 'player', connected: true }));
    state.connections.set('tab-c', new RoomConnection({ userId: 'bob', displayName: 'Bob', role: 'player', connected: true }));
    expect(getConnectedUserIds(state)).toEqual(new Set(['alice', 'bob']));
  });
});
