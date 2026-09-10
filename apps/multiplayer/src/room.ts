import { Room, type AuthContext, type Client } from '@colyseus/core';
import { multiplayerCommandSchemas, type MultiplayerCommandName } from '@hearth/domain';
import { RoomConnection, sceneToRoomSchema, type RoomScene } from '@hearth/room-schema';
import { z } from 'zod';
import { authenticateRoomClient, type Actor, type AuthProvider, type Persistence } from './contracts.js';
import { AuthoritativeRoomEngine, CommandError, type EngineOptions } from './engine.js';

export interface BattleRoomDependencies {
  auth: AuthProvider;
  persistence: Persistence;
  reconnectionSeconds?: number | 'manual';
  engine?: EngineOptions;
}

const roomOptionsSchema = z.object({ roomId: z.uuid(), accessToken: z.string().min(1).optional() }).passthrough();
const commandNames = Object.keys(multiplayerCommandSchemas) as MultiplayerCommandName[];

export function setConnectionPresence(state: RoomScene, sessionId: string, actor: Actor, connected: boolean): void {
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

export function removeConnectionPresence(state: RoomScene, sessionId: string): void {
  state.connections.delete(sessionId);
}

export function createBattleRoom(dependencies: BattleRoomDependencies) {
  return class BattleRoom extends Room<{ state: RoomScene }> {
    private databaseRoomId = '';
    private engine!: AuthoritativeRoomEngine;
    private readonly connections = new Map<string, Actor>();

    async onCreate(rawOptions: unknown): Promise<void> {
      const options = roomOptionsSchema.parse(rawOptions);
      this.databaseRoomId = options.roomId;
      const loaded = await dependencies.persistence.loadRoomState(options.roomId);
      if (loaded.roomId !== options.roomId) throw new Error('Loaded room identity does not match the requested room.');
      const state = sceneToRoomSchema(loaded.scene);
      this.setState(state);
      this.engine = new AuthoritativeRoomEngine(
        options.roomId, state, loaded.scene, loaded.sceneRevision, dependencies.persistence, dependencies.engine,
      );
      for (const type of commandNames) {
        this.onMessage(type, (client, message) => void this.handleCommand(client, type, message));
      }
    }

    async onAuth(_client: Client, rawOptions: unknown, context: AuthContext): Promise<Actor> {
      const options = roomOptionsSchema.parse(rawOptions);
      if (options.roomId !== this.databaseRoomId) throw new Error('Room identity mismatch.');
      const accessToken = options.accessToken ?? context.token;
      if (!accessToken) throw new Error('A Supabase access token is required.');
      return authenticateRoomClient(dependencies.auth, this.databaseRoomId, accessToken);
    }

    onJoin(client: Client): void {
      const actor = this.actor(client);
      this.connections.set(client.sessionId, actor);
      setConnectionPresence(this.state, client.sessionId, actor, true);
    }

    onReconnect(client: Client): void {
      const actor = this.actor(client);
      this.connections.set(client.sessionId, actor);
      setConnectionPresence(this.state, client.sessionId, actor, true);
    }

    onDrop(client: Client): void {
      const actor = this.connections.get(client.sessionId) ?? this.actor(client);
      setConnectionPresence(this.state, client.sessionId, actor, false);
      this.engine.disconnect(client.sessionId);
      void this.allowReconnection(client, dependencies.reconnectionSeconds ?? 20);
    }

    onLeave(client: Client): void {
      this.connections.delete(client.sessionId);
      removeConnectionPresence(this.state, client.sessionId);
      this.engine.disconnect(client.sessionId);
    }

    async onDispose(): Promise<void> {
      await this.engine.dispose();
      this.connections.clear();
      this.state.connections.clear();
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
      try {
        const outcome = await this.engine.execute(this.actor(client), client.sessionId, type, message);
        client.send('command.result', { type, ok: true, ...outcome });
      } catch (error) {
        client.send('command.result', {
          type,
          commandId,
          ok: false,
          code: error instanceof CommandError ? error.code : 'invalid_command',
          message: error instanceof Error ? error.message : 'Command failed.',
        });
      }
    }
  };
}
