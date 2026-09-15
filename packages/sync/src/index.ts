import type { SupabaseClient } from '@supabase/supabase-js';
import { RoomPresenceState } from '@hearth/room-schema';
import {
  commandResultSchema, createRoomSchema, inviteCodeSchema, mapPingEventSchema, mapPingSchema, multiplayerCommandSchemas,
  parseActorProjectionV1,
  projectionStreamMetadataSchema,
  type MultiplayerCommandName,
  type MapPingEvent as DomainMapPingEvent, type MapPingInput,
  type Campaign, type Room, type RoomCommands, type RoomEvent, type RoomMember,
  type ActorProjectionV1, type ProjectionStreamMetadata,
} from '@hearth/domain';

export function createRoomRepository(client: SupabaseClient) {
  const commands: RoomCommands = {
    async createRoom(input, commandId) {
      const parsed = createRoomSchema.parse(input);
      const { data, error } = await client.rpc('create_room', {
        p_command_id: commandId, p_name: parsed.name, p_campaign_name: parsed.campaignName,
      });
      if (error) throw error;
      return commandResultSchema.parse(data).room_id;
    },
    async joinRoom(code, commandId) {
      const { data, error } = await client.rpc('join_room', {
        p_command_id: commandId, p_code: inviteCodeSchema.parse(code),
      });
      if (error) throw error;
      return commandResultSchema.parse(data).room_id;
    },
  };

  return {
    ...commands,
    async listRooms() {
      const [rooms, campaigns, memberships] = await Promise.all([
        client.from('rooms').select('id,campaign_id,name,created_by,created_at,revision').order('created_at', { ascending: false }),
        client.from('campaigns').select('id,name,owner_id'),
        client.from('room_members').select('room_id,user_id,role,display_name,joined_at'),
      ]);
      if (rooms.error) throw rooms.error;
      if (campaigns.error) throw campaigns.error;
      if (memberships.error) throw memberships.error;
      return { rooms: rooms.data as Room[], campaigns: campaigns.data as Campaign[], members: memberships.data as RoomMember[] };
    },
    async getRoom(roomId: string) {
      const { data, error } = await client.from('rooms')
        .select('id,campaign_id,name,created_by,created_at,revision').eq('id', roomId).maybeSingle();
      if (error) throw error;
      return data as Room | null;
    },
    async getLobby(roomId: string) {
      const [members, events] = await Promise.all([
        client.from('room_members').select('room_id,user_id,role,display_name,joined_at')
          .eq('room_id', roomId).order('joined_at'),
        client.from('room_events').select('id,room_id,actor_id,type,payload,created_at')
          .eq('room_id', roomId).order('id', { ascending: false }).limit(20),
      ]);
      if (members.error) throw members.error;
      if (events.error) throw events.error;
      return { members: members.data as RoomMember[], events: events.data as RoomEvent[] };
    },
    async getInvite(roomId: string) {
      const { data, error } = await client.from('room_invites').select('code').eq('room_id', roomId).maybeSingle();
      if (error) throw error;
      return data?.code as string | undefined;
    },
    async listRoomAssets(roomId: string) {
      const { data, error } = await client.from('room_assets')
        .select('id,room_id,created_by,kind,status,width,height,updated_at')
        .eq('room_id', roomId).order('updated_at', { ascending: false });
      if (error) throw error;
      return data as RoomAssetSummary[];
    },
  };
}

export interface RoomAssetSummary {
  id: string;
  room_id: string;
  created_by: string;
  kind: 'map' | 'token';
  status: 'reserved' | 'uploading' | 'processing' | 'ready' | 'failed';
  width: number | null;
  height: number | null;
  updated_at: string;
}

export type RoomRepository = ReturnType<typeof createRoomRepository>;
export type ConnectionStatus = 'connecting' | 'online' | 'reconnecting';

/** Presence is advisory UI state only; database membership grants permissions. */
export function subscribeToRoomPresence(
  client: SupabaseClient,
  roomId: string,
  userId: string,
  onChange: (userIds: Set<string>) => void,
  onStatus: (status: ConnectionStatus) => void,
  onResync: () => void,
) {
  let disposed = false;
  const channel = client.channel(`room:${roomId}`, {
    config: { private: true, presence: { key: userId } },
  });
  channel.on('presence', { event: 'sync' }, () => {
    if (disposed) return;
    onChange(new Set(Object.keys(channel.presenceState())));
    onResync();
  });
  onStatus('connecting');
  channel.subscribe(async (status) => {
    if (disposed) return;
    if (status === 'SUBSCRIBED') {
      const result = await channel.track({ online_at: new Date().toISOString() });
      if (disposed) return;
      onStatus(result === 'ok' ? 'online' : 'reconnecting');
      onResync();
    } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
      onStatus('reconnecting');
      onChange(new Set());
    }
  });
  return () => { disposed = true; void client.removeChannel(channel); };
}

export interface SessionStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface ColyseusRoomLike {
  state: RoomPresenceState;
  reconnectionToken: string;
  send(type: string, message: unknown): void;
  leave(consented?: boolean): Promise<unknown> | void;
  onStateChange(callback: (state: RoomPresenceState) => void): unknown;
  onMessage(type: string | number, callback: (message: unknown) => void): unknown;
  onLeave(callback: (code?: number) => void): unknown;
  onError(callback: (code: number, message: string) => void): unknown;
  onDrop?(callback: (code: number, reason?: string) => void): unknown;
  onReconnect?(callback: () => void): unknown;
}

export interface ColyseusClientLike {
  joinOrCreate(roomName: string, options: unknown, schema?: typeof RoomPresenceState): Promise<ColyseusRoomLike>;
  reconnect(token: string, schema?: typeof RoomPresenceState): Promise<ColyseusRoomLike>;
}

export interface MultiplayerConnectionOptions {
  endpoint: string;
  roomId: string;
  accessToken: string;
  storage?: SessionStorageLike;
  client?: ColyseusClientLike;
  onProjection: (projection: ActorProjectionV1) => void;
  onPresence?: (state: RoomPresenceState) => void;
  onStatus: (status: ConnectionStatus) => void;
  onError?: (error: Error) => void;
  onPing?: (ping: DomainMapPingEvent) => void;
  reconnectAttempts?: number;
  reconnectDelayMs?: number;
  connectTimeoutMs?: number;
  requestTimeoutMs?: number;
}

export type { MapPingEvent } from '@hearth/domain';

export interface MultiplayerRequestResult {
  type: MultiplayerCommandName;
  commandId: string;
  sceneRevision: number;
  duplicate?: boolean;
  result?: unknown;
}

export class MultiplayerRequestError extends Error {
  constructor(public readonly code: string, message: string) { super(message); }
}

export interface MultiplayerConnection {
  connect(): Promise<void>;
  send<T extends MultiplayerCommandName>(type: T, command: unknown): void;
  request<T extends Exclude<MultiplayerCommandName, 'token.transform.preview'>>(
    type: T,
    command: unknown,
  ): Promise<MultiplayerRequestResult>;
  sendPing(input: MapPingInput): void;
  disconnect(): Promise<void>;
  getRoom(): ColyseusRoomLike | undefined;
}

export function createMultiplayerConnection(options: MultiplayerConnectionOptions): MultiplayerConnection {
  let client = options.client;
  const storageKey = `hearth:reconnection:${options.roomId}`;
  const projectionStorageKey = `${storageKey}:projection`;
  let room: ColyseusRoomLike | undefined;
  let disposed = false;
  let generation = 0;
  let lifecycle = 0;
  let connectTask: Promise<void> | undefined;
  let reconnectTask: Promise<void> | undefined;
  const pending = new Map<string, {
    resolve: (result: MultiplayerRequestResult) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  let projectionMetadata: ProjectionStreamMetadata | undefined;

  const toError = (error: unknown): Error => error instanceof Error ? error : new Error(String(error));
  const safeEndpoint = (endpoint: string): string => {
    try {
      const url = new URL(endpoint);
      url.username = '';
      url.password = '';
      url.search = '';
      url.hash = '';
      return url.toString();
    } catch {
      return endpoint.replace(/([?&](?:access[_-]?token|token|auth|authorization)=)[^&]*/gi, '$1[redacted]');
    }
  };
  const reportError = (error: unknown) => {
    const cause = toError(error);
    console.error('[hearth-sync] multiplayer connection error', {
      endpoint: safeEndpoint(options.endpoint),
      roomId: options.roomId,
      message: cause.message,
      stack: cause.stack,
    });
    options.onError?.(cause);
  };
  const rejectPending = (error: Error): void => {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    pending.clear();
  };
  const getClient = async (): Promise<ColyseusClientLike> => {
    if (!client) {
      const { Client } = await import('@colyseus/sdk');
      client = new Client(options.endpoint) as unknown as ColyseusClientLike;
    }
    return client;
  };

  const clearStoredSession = (token?: string): void => {
    const storage = options.storage;
    if (!storage) return;
    if (token !== undefined && storage.getItem(storageKey) !== token) return;
    storage.removeItem(storageKey);
    storage.removeItem(projectionStorageKey);
  };
  const readStoredSession = (): { token: string; metadata?: ProjectionStreamMetadata } | undefined => {
    const storage = options.storage;
    const token = storage?.getItem(storageKey);
    if (!storage) return undefined;
    const rawMetadata = storage.getItem(projectionStorageKey);
    if (!token || rawMetadata === null) {
      clearStoredSession(token ?? undefined);
      return undefined;
    }
    try {
      const metadata = projectionStreamMetadataSchema.parse(JSON.parse(rawMetadata));
      return { token, metadata };
    } catch {
      clearStoredSession(token);
      return undefined;
    }
  };
  const persistSession = (token: string): void => {
    const storage = options.storage;
    if (!storage) return;
    storage.setItem(storageKey, token);
    if (projectionMetadata) storage.setItem(projectionStorageKey, JSON.stringify(projectionMetadata));
    else storage.removeItem(projectionStorageKey);
  };
  const closeRoom = async (target: ColyseusRoomLike, consented: boolean): Promise<void> => {
    try {
      const leaving = Promise.resolve(target.leave(consented));
      if (!consented) { await leaving; return; }
      let completed = false;
      await Promise.race([
        leaving.finally(() => { completed = true; }),
        new Promise<void>((resolve) => setTimeout(resolve, 1_000)),
      ]);
      if (!completed) await Promise.resolve(target.leave(false));
    } catch { /* The connection is already closing. */ }
  };
  const acquireRoom = async (
    operation: number,
    label: string,
    factory: () => Promise<ColyseusRoomLike>,
  ): Promise<ColyseusRoomLike | undefined> => {
    const source = factory();
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        reject(new Error(`${label} timed out.`));
      }, options.connectTimeoutMs ?? 10_000);
    });
    try {
      const next = await Promise.race([source, timeout]);
      if (disposed || operation !== lifecycle) {
        await closeRoom(next, false);
        return undefined;
      }
      return next;
    } catch (error) {
      if (timedOut) void source.then((late) => closeRoom(late, false)).catch(() => undefined);
      throw toError(error);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  const attach = (next: ColyseusRoomLike): void => {
    room = next;
    const attachedGeneration = ++generation;
    persistSession(next.reconnectionToken);
    options.onPresence?.(next.state);
    options.onStatus('online');
    next.onStateChange((state) => {
      if (!disposed && attachedGeneration === generation) options.onPresence?.(state);
    });
    next.onMessage('scene.projection.v1', (raw) => {
      if (disposed || attachedGeneration !== generation) return;
      try {
        const projection = parseActorProjectionV1(raw, projectionMetadata);
        if (projectionMetadata === undefined && (projection.projectionRevision !== 0 || projection.streamReset?.kind !== 'initial')) {
          throw new Error('The first projection must be an initial revision-zero snapshot.');
        }
        projectionMetadata = {
          streamId: projection.streamId,
          sceneRevision: projection.sceneRevision,
          projectionRevision: projection.projectionRevision,
        };
        persistSession(next.reconnectionToken);
        options.onProjection(projection);
      } catch (error) {
        reportError(error);
      }
    });
    next.onMessage('command.result', (raw) => {
      if (attachedGeneration !== generation || typeof raw !== 'object' || raw === null) return;
      const message = raw as Record<string, unknown>;
      if (typeof message.commandId !== 'string') return;
      const request = pending.get(message.commandId);
      if (!request) return;
      pending.delete(message.commandId);
      clearTimeout(request.timer);
      if (message.ok === true && typeof message.type === 'string' && typeof message.sceneRevision === 'number') {
        request.resolve({
          type: message.type as MultiplayerCommandName,
          commandId: message.commandId,
          sceneRevision: message.sceneRevision,
          duplicate: message.duplicate === true || undefined,
          result: message.result,
        });
      } else {
        request.reject(new MultiplayerRequestError(
          typeof message.code === 'string' ? message.code : 'command_failed',
          typeof message.message === 'string' ? message.message : 'Command failed.',
        ));
      }
    });
    next.onMessage('map.ping', (raw) => {
      if (disposed || attachedGeneration !== generation) return;
      const parsed = mapPingEventSchema.safeParse(raw);
      if (parsed.success) options.onPing?.(parsed.data);
    });
    next.onError((code, message) => {
      if (disposed || attachedGeneration !== generation) return;
      reportError(new Error(message));
      if (code === 4003) {
        room = undefined;
        generation++;
        beginReconnect(next.reconnectionToken);
      }
    });
    next.onDrop?.(() => {
      if (disposed || attachedGeneration !== generation) return;
      persistSession(next.reconnectionToken);
      options.onStatus('reconnecting');
    });
    next.onReconnect?.(() => {
      if (disposed || attachedGeneration !== generation) return;
      options.onStatus('online');
      queueMicrotask(() => {
        if (disposed || attachedGeneration !== generation) return;
        persistSession(next.reconnectionToken);
      });
    });
    next.onLeave(() => {
      if (disposed || attachedGeneration !== generation) return;
      room = undefined;
      generation++;
      beginReconnect(next.reconnectionToken);
    });
  };

  const beginReconnect = (token: string): void => {
    if (reconnectTask || disposed) return;
    const operation = ++lifecycle;
    reconnectTask = reconnect(token, operation).finally(() => { reconnectTask = undefined; });
  };

  const activate = (next: ColyseusRoomLike, operation: number): boolean => {
    if (disposed || operation !== lifecycle) { void closeRoom(next, false); return false; }
    attach(next);
    return true;
  };

  const reconnect = async (token: string, operation: number): Promise<void> => {
    options.onStatus('reconnecting');
    const attempts = options.reconnectAttempts ?? 5;
    const delay = options.reconnectDelayMs ?? 250;
    for (let attempt = 0; attempt < attempts && !disposed; attempt++) {
      try {
        const currentClient = await getClient();
        if (disposed || operation !== lifecycle) return;
        const reconnected = await acquireRoom(operation, 'Multiplayer reconnection', () => currentClient.reconnect(token, RoomPresenceState));
        if (reconnected) activate(reconnected, operation);
        return;
      } catch (error) {
        if (disposed || operation !== lifecycle) return;
        if (attempt === attempts - 1) {
          clearStoredSession(token);
          projectionMetadata = undefined;
          rejectPending(new Error('Multiplayer reconnection failed.'));
          reportError(error);
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, delay * 2 ** attempt));
      }
    }
  };

  return {
    async connect() {
      if (room) return;
      if (connectTask) return connectTask;
      disposed = false;
      projectionMetadata = undefined;
      const operation = ++lifecycle;
      options.onStatus('connecting');
      const task = (async () => {
        const currentClient = await getClient();
        if (disposed || operation !== lifecycle) return;
        const stored = readStoredSession();
        if (stored) {
          projectionMetadata = stored.metadata;
          try {
            const reconnected = await acquireRoom(operation, 'Multiplayer reconnection', () => currentClient.reconnect(stored.token, RoomPresenceState));
            if (reconnected) activate(reconnected, operation);
            return;
          } catch (error) {
            if (disposed || operation !== lifecycle) return;
            clearStoredSession(stored.token);
            projectionMetadata = undefined;
            reportError(error);
          }
        }
        const joined = await acquireRoom(operation, 'Multiplayer connection', () => currentClient.joinOrCreate('battle', {
          databaseRoomId: options.roomId,
          accessToken: options.accessToken,
        }, RoomPresenceState));
        if (joined) activate(joined, operation);
      })();
      connectTask = task;
      try { await task; }
      catch (error) {
        if (!disposed && operation === lifecycle) reportError(error);
        throw error;
      }
      finally { if (connectTask === task) connectTask = undefined; }
    },
    send(type, command) {
      if (!room) throw new Error('Multiplayer room is not connected.');
      const parsed = multiplayerCommandSchemas[type].parse(command);
      room.send(type, parsed);
    },
    request(type, command) {
      if (!room) return Promise.reject(new Error('Multiplayer room is not connected.'));
      const parsed = multiplayerCommandSchemas[type].parse(command) as { commandId?: string };
      if (!parsed.commandId) return Promise.reject(new Error('Durable commands require a command ID.'));
      if (pending.has(parsed.commandId)) return Promise.reject(new Error('A request with this command ID is already pending.'));
      return new Promise<MultiplayerRequestResult>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(parsed.commandId!);
          reject(new Error(`Command ${parsed.commandId} timed out.`));
        }, options.requestTimeoutMs ?? 10_000);
        pending.set(parsed.commandId!, { resolve, reject, timer });
        try {
          room!.send(type, parsed);
        } catch (error) {
          clearTimeout(timer);
          pending.delete(parsed.commandId!);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    },
    sendPing(input) {
      if (!room) throw new Error('Multiplayer room is not connected.');
      room.send('map.ping', mapPingSchema.parse(input));
    },
    async disconnect() {
      disposed = true;
      lifecycle++;
      generation++;
      projectionMetadata = undefined;
      rejectPending(new Error('Multiplayer connection closed.'));
      const current = room;
      room = undefined;
      const storedToken = current?.reconnectionToken ?? options.storage?.getItem(storageKey) ?? undefined;
      clearStoredSession(storedToken);
      if (current) {
        await closeRoom(current, true);
      }
    },
    getRoom: () => room,
  };
}

export function getConnectedUserIds(state: RoomPresenceState): Set<string> {
  const userIds = new Set<string>();
  state.connections.forEach((connection) => {
    if (connection.connected) userIds.add(connection.userId);
  });
  return userIds;
}
