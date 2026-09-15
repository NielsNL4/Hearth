import { randomUUID } from 'node:crypto';
import { Room, type AuthContext, type Client } from '@colyseus/core';
import { mapPingEventSchema, mapPingSchema, multiplayerCommandSchemas, type MultiplayerCommandName, type ProjectionStreamMetadata } from '@hearth/domain';
import { RoomConnection, RoomPresenceState, sceneToRoomSchema, type RoomScene } from '@hearth/room-schema';
import { z } from 'zod';
import { authenticateRoomClient, type Actor, type AuthProvider, type Persistence } from './contracts.js';
import { AuthoritativeRoomEngine, CommandError, type EngineOptions } from './engine.js';
import { buildActorProjectionV1 } from './projection.js';

export interface BattleRoomDependencies {
  auth: AuthProvider;
  persistence: Persistence;
  reconnectionSeconds?: number | 'manual';
  engine?: EngineOptions;
}

const roomOptionsSchema = z.object({ databaseRoomId: z.uuid(), accessToken: z.string().min(1).optional() }).passthrough();
const commandNames = Object.keys(multiplayerCommandSchemas) as MultiplayerCommandName[];

function actorColor(userId: string): string {
  let hash = 0;
  for (const character of userId) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return `#${(hash & 0xffffff).toString(16).padStart(6, '0')}`;
}

export function createMapPingEvent(actor: Actor, input: unknown, now = Date.now()) {
  const ping = mapPingSchema.parse(input);
  return mapPingEventSchema.parse({
    ...ping,
    userId: actor.userId,
    displayName: actor.displayName,
    color: actorColor(actor.userId),
    serverTimeMs: now,
    expiresAtMs: now + 2_500,
  });
}

type PresenceState = Pick<RoomScene, 'connections'> | Pick<RoomPresenceState, 'connections'>;
interface SessionProjectionDeliveryState {
  nextProjectionRevision: number;
  metadata?: ProjectionStreamMetadata;
}
interface ProjectionDeliveryAllocation {
  projectionRevision: number;
  streamReset: boolean;
  previous?: ProjectionStreamMetadata;
  state: SessionProjectionDeliveryState;
}

export function setConnectionPresence(state: PresenceState, sessionId: string, actor: Actor, connected: boolean): void {
  const connection = state.connections.get(sessionId);
  if (connection) {
    connection.userId = actor.userId;
    connection.displayName = actor.displayName;
    connection.role = actor.role;
    connection.connected = connected;
  } else {
    state.connections.set(sessionId, new RoomConnection({
      userId: actor.userId, displayName: actor.displayName, role: actor.role, connected,
    }));
  }
}

export function removeConnectionPresence(state: PresenceState, sessionId: string): void {
  state.connections.delete(sessionId);
}

export function createBattleRoom(dependencies: BattleRoomDependencies) {
  return class BattleRoom extends Room<{ state: RoomPresenceState }> {
    private databaseRoomId = '';
    private engine!: AuthoritativeRoomEngine;
    private readonly connections = new Map<string, Actor>();
    private readonly sessionClients = new Map<string, Client>();
    private readonly lastPingAt = new Map<string, number>();
    private projectionStreamId = '';
    private readonly projectionDelivery = new Map<string, SessionProjectionDeliveryState>();

    async onCreate(rawOptions: unknown): Promise<void> {
      const options = roomOptionsSchema.parse(rawOptions);
      this.databaseRoomId = options.databaseRoomId;
      this.projectionStreamId = randomUUID();
      this.projectionDelivery.clear();
      const loaded = await dependencies.persistence.loadRoomState(options.databaseRoomId);
      if (loaded.roomId !== options.databaseRoomId) throw new Error('Loaded room identity does not match the requested room.');
      const privateState = sceneToRoomSchema(loaded.scene);
      this.setState(new RoomPresenceState());
      this.engine = new AuthoritativeRoomEngine(
        options.databaseRoomId, privateState, loaded.scene, loaded.sceneRevision, dependencies.persistence, dependencies.engine,
      );
      for (const type of commandNames) {
        this.onMessage(type, (client, message) => void this.handleCommand(client, type, message));
      }
      this.onMessage('map.ping', (client, message) => {
        const now = Date.now();
        if (now - (this.lastPingAt.get(client.sessionId) ?? 0) < 250) return;
        let ping: ReturnType<typeof createMapPingEvent>;
        try { ping = createMapPingEvent(this.actor(client), message, now); }
        catch { return; }
        const map = this.engine.canonicalScene.map;
        if (!map || ping.position.x < 0 || ping.position.y < 0 || ping.position.x > map.width || ping.position.y > map.height) return;
        this.lastPingAt.set(client.sessionId, now);
        this.broadcast('map.ping', ping);
      });
    }

    async onAuth(_client: Client, rawOptions: unknown, context: AuthContext): Promise<Actor> {
      const options = roomOptionsSchema.parse(rawOptions);
      if (options.databaseRoomId !== this.databaseRoomId) throw new Error('Room identity mismatch.');
      const accessToken = options.accessToken ?? context.token;
      if (!accessToken) throw new Error('A Supabase access token is required.');
      return authenticateRoomClient(dependencies.auth, this.databaseRoomId, accessToken);
    }

    onJoin(client: Client): void {
      const actor = this.actor(client);
      this.sessionClients.set(client.sessionId, client);
      this.connections.set(client.sessionId, actor);
      setConnectionPresence(this.state, client.sessionId, actor, true);
      this.deliverProjection(client, actor);
    }

    onReconnect(client: Client): void {
      const actor = this.actor(client);
      this.sessionClients.set(client.sessionId, client);
      this.connections.set(client.sessionId, actor);
      setConnectionPresence(this.state, client.sessionId, actor, true);
      this.deliverProjection(client, actor);
    }

    onDrop(client: Client): void {
      const actor = this.connections.get(client.sessionId) ?? this.actor(client);
      this.sessionClients.delete(client.sessionId);
      setConnectionPresence(this.state, client.sessionId, actor, false);
      this.engine.disconnect(client.sessionId);
      void this.allowReconnection(client, dependencies.reconnectionSeconds ?? 20);
    }

    onLeave(client: Client): void {
      this.sessionClients.delete(client.sessionId);
      this.connections.delete(client.sessionId);
      this.projectionDelivery.delete(client.sessionId);
      this.lastPingAt.delete(client.sessionId);
      removeConnectionPresence(this.state, client.sessionId);
      this.engine.disconnect(client.sessionId);
    }

    async onDispose(): Promise<void> {
      if (this.engine) await this.engine.dispose();
      this.connections.clear();
      this.sessionClients.clear();
      this.projectionDelivery.clear();
      this.lastPingAt.clear();
      this.state?.connections.clear();
    }

    private actor(client: Client): Actor {
      const actor = client.auth as Actor | undefined;
      if (!actor?.userId || (actor.role !== 'dm' && actor.role !== 'player')) throw new Error('Authenticated actor missing.');
      return actor;
    }

    private async handleCommand(client: Client, type: MultiplayerCommandName, message: unknown): Promise<void> {
      let commandId: string | undefined;
      if (typeof message === 'object' && message !== null && 'commandId' in message && typeof message.commandId === 'string') {
        commandId = message.commandId;
      }
      let outcome;
      try {
        outcome = await this.engine.execute(this.actor(client), client.sessionId, type, message);
      } catch (error) {
        client.send('command.result', {
          type,
          commandId,
          ok: false,
          code: error instanceof CommandError ? error.code : 'invalid_command',
          message: error instanceof Error ? error.message : 'Command failed.',
        });
        return;
      }
      if (!outcome.duplicate && type !== 'token.transform.preview') this.publishProjections();
      try { client.send('command.result', { type, ok: true, ...outcome }); } catch { /* committed command stays successful */ }
    }

    private allocateProjection(sessionId: string): ProjectionDeliveryAllocation {
      const state = this.projectionDelivery.get(sessionId) ?? { nextProjectionRevision: 0 };
      return {
        projectionRevision: state.nextProjectionRevision,
        streamReset: state.metadata === undefined && state.nextProjectionRevision === 0,
        previous: state.metadata,
        state,
      };
    }

    private markProjectionDelivered(client: Client, allocation: ProjectionDeliveryAllocation, projection: { sceneRevision: number; projectionRevision: number }): void {
      allocation.state.nextProjectionRevision = projection.projectionRevision + 1;
      allocation.state.metadata = {
        streamId: this.projectionStreamId,
        sceneRevision: projection.sceneRevision,
        projectionRevision: projection.projectionRevision,
      };
      this.projectionDelivery.set(client.sessionId, allocation.state);
    }

    private sendProjection(client: Client, actor: Actor, allocation: ProjectionDeliveryAllocation, failClosed = false): void {
      const projection = buildActorProjectionV1(this.engine.canonicalScene, actor, {
        streamId: this.projectionStreamId,
        sceneRevision: this.engine.revision,
        projectionRevision: allocation.projectionRevision,
        streamReset: allocation.streamReset,
        failClosed,
        previous: allocation.previous,
      });
      client.send('scene.projection.v1', projection);
      this.markProjectionDelivered(client, allocation, projection);
    }

    private deliverProjection(client: Client, actor: Actor): void {
      const allocation = this.allocateProjection(client.sessionId);
      try {
        this.sendProjection(client, actor, allocation);
      } catch {
        if (actor.role !== 'player') return;
        try {
          this.sendProjection(client, actor, allocation, true);
        } catch {
          // A failed recipient must not block other actor publications or the
          // acknowledgement of an already committed durable command.
        }
      }
    }

    private publishProjections(): void {
      for (const [sessionId, actor] of this.connections) {
        const client = this.sessionClients.get(sessionId);
        if (client) this.deliverProjection(client, actor);
      }
    }
  };
}
