import type { SupabaseClient } from '@supabase/supabase-js';
import { RoomScene } from '@hearth/room-schema';
export { roomSchemaToScene, sceneToRoomSchema } from '@hearth/room-schema';
import {
  commandResultSchema, createRoomSchema, inviteCodeSchema, multiplayerCommandSchemas,
  type MultiplayerCommandName,
  type Campaign, type Room, type RoomCommands, type RoomEvent, type RoomMember,
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
  state: RoomScene;
  reconnectionToken: string;
  send(type: string, message: unknown): void;
  leave(consented?: boolean): Promise<unknown> | void;
  onStateChange(callback: (state: RoomScene) => void): unknown;
  onMessage(type: string | number, callback: (message: unknown) => void): unknown;
  onDrop?(callback: (code?: number) => void): unknown;
  onReconnect?(callback: () => void): unknown;
  onLeave(callback: (code?: number) => void): unknown;
  onError(callback: (code: number, message: string) => void): unknown;
}

export interface ColyseusClientLike {
  joinOrCreate(roomName: string, options: unknown, schema?: typeof RoomScene): Promise<ColyseusRoomLike>;
  reconnect(token: string, schema?: typeof RoomScene): Promise<ColyseusRoomLike>;
}

export interface MultiplayerConnectionOptions {
  endpoint: string;
  roomId: string;
  accessToken: string;
  storage?: SessionStorageLike;
  client?: ColyseusClientLike;
  onState: (state: RoomScene) => void;
  onStatus: (status: ConnectionStatus) => void;
  onError?: (error: Error) => void;
  reconnectAttempts?: number;
  reconnectDelayMs?: number;
  requestTimeoutMs?: number;
}

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
  disconnect(): Promise<void>;
  getRoom(): ColyseusRoomLike | undefined;
}

export function createMultiplayerConnection(options: MultiplayerConnectionOptions): MultiplayerConnection {
  let client = options.client;
  const storageKey = `hearth:reconnection:${options.roomId}`;
  let room: ColyseusRoomLike | undefined;
  let disposed = false;
  let generation = 0;
  let reconnectTask: Promise<void> | undefined;
  const pending = new Map<string, {
    resolve: (result: MultiplayerRequestResult) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  const reportError = (error: unknown) => options.onError?.(error instanceof Error ? error : new Error(String(error)));
  const rejectPending = (error: Error): void => {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    pending.clear();
  };
  const getClient = async (): Promise<ColyseusClientLike> => {
    if (!client) {
      const { Client } = await import('colyseus.js');
      client = new Client(options.endpoint) as unknown as ColyseusClientLike;
    }
    return client;
  };

  const attach = (next: ColyseusRoomLike): void => {
    room = next;
    const attachedGeneration = ++generation;
    options.storage?.setItem(storageKey, next.reconnectionToken);
    options.onState(next.state);
    options.onStatus('online');
    next.onStateChange((state) => {
      if (!disposed && attachedGeneration === generation) options.onState(state);
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
    next.onDrop?.(() => {
      if (!disposed && attachedGeneration === generation) options.onStatus('reconnecting');
    });
    next.onReconnect?.(() => {
      if (disposed || attachedGeneration !== generation) return;
      options.storage?.setItem(storageKey, next.reconnectionToken);
      options.onStatus('online');
    });
    next.onError((code, message) => {
      reportError(new Error(message));
      if (code === 4003 && !disposed && attachedGeneration === generation) {
        room = undefined;
        generation++;
        beginReconnect(next.reconnectionToken);
      }
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
    reconnectTask = reconnect(token).finally(() => { reconnectTask = undefined; });
  };

  const activate = async (next: ColyseusRoomLike): Promise<boolean> => {
    if (disposed) {
      await next.leave(true);
      return false;
    }
    attach(next);
    return true;
  };

  const reconnect = async (token: string): Promise<void> => {
    options.onStatus('reconnecting');
    const attempts = options.reconnectAttempts ?? 5;
    const delay = options.reconnectDelayMs ?? 250;
    for (let attempt = 0; attempt < attempts && !disposed; attempt++) {
      try {
        const reconnected = await (await getClient()).reconnect(token, RoomScene);
        await activate(reconnected);
        return;
      } catch (error) {
        if (attempt === attempts - 1) {
          options.storage?.removeItem(storageKey);
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
      disposed = false;
      options.onStatus('connecting');
      const token = options.storage?.getItem(storageKey);
      if (token) {
        try {
          await activate(await (await getClient()).reconnect(token, RoomScene));
          return;
        } catch (error) {
          options.storage?.removeItem(storageKey);
          reportError(error);
        }
      }
      await activate(await (await getClient()).joinOrCreate('battle', {
        roomId: options.roomId,
        accessToken: options.accessToken,
      }, RoomScene));
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
    async disconnect() {
      disposed = true;
      generation++;
      rejectPending(new Error('Multiplayer connection closed.'));
      options.storage?.removeItem(storageKey);
      const current = room;
      room = undefined;
      await current?.leave(true);
    },
    getRoom: () => room,
  };
}

export function getConnectedUserIds(state: RoomScene): Set<string> {
  const userIds = new Set<string>();
  state.connections.forEach((connection) => {
    if (connection.connected) userIds.add(connection.userId);
  });
  return userIds;
}
