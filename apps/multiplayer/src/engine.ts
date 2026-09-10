import {
  assetReserveCommandSchema,
  gridSetCommandSchema,
  mapSetCommandSchema,
  playerMovementSetCommandSchema,
  tokenCreateCommandSchema,
  tokenDeleteCommandSchema,
  tokenDetailsUpdateCommandSchema,
  tokenTransformCommitSchema,
  tokenTransformPreviewSchema,
  type MultiplayerCommandName,
} from '@hearth/domain';
import { RoomGrid, RoomMap, RoomPoint, RoomSize, RoomToken, type RoomScene } from '@hearth/room-schema';
import { cloneScene, parseSceneV2, type JsonValue, type SceneV2, type TokenRecord } from '@hearth/scene';
import type { Actor, Persistence } from './contracts.js';

export class CommandError extends Error {
  constructor(public readonly code: 'forbidden' | 'not_found' | 'conflict' | 'rate_limited', message: string) {
    super(message);
  }
}

export interface CommandOutcome {
  commandId?: string;
  sceneRevision: number;
  duplicate?: boolean;
  result?: unknown;
}

interface Preview {
  sessionId: string;
  actorId: string;
  sequence: number;
  lastAt: number;
  timer: ReturnType<typeof setTimeout>;
}

export interface EngineOptions {
  previewIntervalMs?: number;
  previewExpiryMs?: number;
  now?: () => number;
}

const schemas = {
  'map.set': mapSetCommandSchema,
  'grid.set': gridSetCommandSchema,
  'permissions.playerMovement.set': playerMovementSetCommandSchema,
  'token.create': tokenCreateCommandSchema,
  'token.transform.commit': tokenTransformCommitSchema,
  'token.details.update': tokenDetailsUpdateCommandSchema,
  'token.delete': tokenDeleteCommandSchema,
  'asset.reserve': assetReserveCommandSchema,
} as const;

type DurableCommandName = keyof typeof schemas;

export class AuthoritativeRoomEngine {
  private sceneRevision: number;
  private canonical: SceneV2;
  private queue: Promise<void> = Promise.resolve();
  private readonly receipts = new Map<string, { fingerprint: string; outcome: CommandOutcome }>();
  private readonly previews = new Map<string, Preview>();
  private readonly now: () => number;
  private readonly previewIntervalMs: number;
  private readonly previewExpiryMs: number;

  constructor(
    public readonly roomId: string,
    private readonly state: RoomScene,
    initialScene: SceneV2,
    sceneRevision: number,
    private readonly persistence: Persistence,
    options: EngineOptions = {},
  ) {
    this.canonical = cloneScene(initialScene);
    this.sceneRevision = sceneRevision;
    this.now = options.now ?? Date.now;
    this.previewIntervalMs = options.previewIntervalMs ?? 30;
    this.previewExpiryMs = options.previewExpiryMs ?? 2_000;
  }

  get revision(): number { return this.sceneRevision; }
  get canonicalScene(): SceneV2 { return cloneScene(this.canonical); }

  execute(actor: Actor, sessionId: string, type: MultiplayerCommandName, input: unknown): Promise<CommandOutcome> {
    if (type === 'token.transform.preview') {
      return Promise.resolve().then(() => this.preview(actor, sessionId, input));
    }
    return this.serialized(() => this.executeDurable(actor, sessionId, type, input));
  }

  disconnect(sessionId: string): void {
    for (const [tokenId, preview] of this.previews) {
      if (preview.sessionId === sessionId) this.revertPreview(tokenId);
    }
  }

  async checkpoint(): Promise<void> {
    // Durable commands mutate canonical/schema state only after their RPC succeeds,
    // so draining the queue is the complete final checkpoint.
    await this.queue;
  }

  async dispose(): Promise<void> {
    for (const tokenId of [...this.previews.keys()]) this.revertPreview(tokenId);
    await this.checkpoint();
  }

  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async executeDurable(
    actor: Actor,
    sessionId: string,
    type: DurableCommandName,
    input: unknown,
  ): Promise<CommandOutcome> {
    const command = schemas[type].parse(input) as { commandId: string; payload: Record<string, any> };
    const fingerprint = JSON.stringify({ type, command });
    const receipt = this.receipts.get(command.commandId);
    if (receipt) {
      if (receipt.fingerprint !== fingerprint) throw new CommandError('conflict', 'Command ID was already used with different input.');
      return { ...receipt.outcome, duplicate: true };
    }

    if (type === 'token.transform.commit') {
      const preview = this.previews.get(command.payload.tokenId as string);
      if (preview && preview.sessionId !== sessionId) {
        throw new CommandError('conflict', 'Token is being moved by another connection.');
      }
    }

    if (type === 'asset.reserve') {
      const kind = command.payload.kind as 'map' | 'token';
      if (kind === 'map') this.requireDm(actor);
      const result = await this.persistence.reserveRoomAsset({
        commandId: command.commandId,
        roomId: this.roomId,
        creatorId: actor.userId,
        kind,
        sourceMetadata: command.payload.sourceMetadata as Record<string, JsonValue>,
      });
      const outcome = { commandId: command.commandId, sceneRevision: this.sceneRevision, result };
      this.receipts.set(command.commandId, { fingerprint, outcome });
      return outcome;
    }

    const next = cloneScene(this.canonical);
    const eventPayload = await this.applyCanonical(next, actor, type, command.payload);
    parseSceneV2(next);
    try {
      const committed = await this.persistence.commitRoomState({
        commandId: command.commandId,
        roomId: this.roomId,
        actorId: actor.userId,
        expectedSceneRevision: this.sceneRevision,
        scene: next,
        eventType: type,
        eventPayload,
      });
      this.canonical = next;
      this.sceneRevision = committed.sceneRevision;
      this.applySynchronized(type, command.payload, next);
      if (type === 'token.transform.commit') this.clearPreview(command.payload.tokenId as string, false);
      if (type === 'token.delete') this.clearPreview(command.payload.tokenId as string, false);
      const outcome = { commandId: command.commandId, sceneRevision: this.sceneRevision, result: committed };
      this.receipts.set(command.commandId, { fingerprint, outcome });
      return outcome;
    } catch (error) {
      if (type === 'token.transform.commit') this.revertPreview(command.payload.tokenId as string);
      throw error;
    }
  }

  private preview(actor: Actor, sessionId: string, input: unknown): CommandOutcome {
    const command = tokenTransformPreviewSchema.parse(input);
    const token = this.canonical.tokens[command.tokenId];
    if (!token) throw new CommandError('not_found', 'Token not found.');
    this.requireTokenMovement(actor, token);
    const prior = this.previews.get(command.tokenId);
    if (prior && prior.sessionId !== sessionId) throw new CommandError('conflict', 'Token is being moved by another connection.');
    if (prior && command.sequence <= prior.sequence) throw new CommandError('conflict', 'Preview sequence must increase.');
    const now = this.now();
    if (prior && now - prior.lastAt < this.previewIntervalMs) throw new CommandError('rate_limited', 'Preview rate exceeded.');
    if (prior) clearTimeout(prior.timer);
    const live = this.state.tokens.get(command.tokenId);
    if (!live) throw new CommandError('not_found', 'Token not found.');
    live.position.x = command.position.x;
    live.position.y = command.position.y;
    live.rotation = command.rotation;
    const timer = setTimeout(() => this.revertPreview(command.tokenId), this.previewExpiryMs);
    timer.unref?.();
    this.previews.set(command.tokenId, {
      sessionId, actorId: actor.userId, sequence: command.sequence, lastAt: now, timer,
    });
    return { sceneRevision: this.sceneRevision };
  }

  private async applyCanonical(
    scene: SceneV2,
    actor: Actor,
    type: Exclude<DurableCommandName, 'asset.reserve'>,
    payload: Record<string, any>,
  ): Promise<Record<string, JsonValue>> {
    switch (type) {
      case 'map.set':
        this.requireDm(actor);
        if (payload.map) {
          const asset = await this.requireReadyAsset(payload.map.assetId, 'map');
          if (asset.width !== payload.map.width || asset.height !== payload.map.height) {
            throw new CommandError('conflict', 'Map dimensions do not match the ready asset.');
          }
        }
        scene.map = payload.map;
        break;
      case 'grid.set':
        this.requireDm(actor);
        scene.grid = {
          type: 'square',
          visible: payload.visible,
          cellSize: payload.cellSize,
          offset: payload.offset,
          distancePerCell: payload.distancePerCell,
          unit: payload.unit,
          snap: payload.snap,
        };
        break;
      case 'permissions.playerMovement.set':
        this.requireDm(actor);
        scene.permissions.playerMovement = payload.playerMovement;
        break;
      case 'token.create': {
        const token = { ...payload.token, revision: 0 } as TokenRecord;
        if (scene.tokens[token.id]) throw new CommandError('conflict', 'Token already exists.');
        if (actor.role !== 'dm' && token.ownerId !== actor.userId) throw new CommandError('forbidden', 'Players may only create their own tokens.');
        await this.requireReadyAsset(token.assetId, 'token');
        scene.tokens[token.id] = token;
        break;
      }
      case 'token.transform.commit': {
        const token = this.requireToken(scene, payload.tokenId);
        this.requireTokenMovement(actor, token);
        this.requireTokenRevision(token, payload.expectedTokenRevision);
        token.position = payload.position;
        token.rotation = payload.rotation;
        token.revision++;
        break;
      }
      case 'token.details.update': {
        const token = this.requireToken(scene, payload.tokenId);
        this.requireTokenOwner(actor, token);
        this.requireTokenRevision(token, payload.expectedTokenRevision);
        if (actor.role !== 'dm' && payload.details.ownerId !== undefined && payload.details.ownerId !== actor.userId) {
          throw new CommandError('forbidden', 'Only the DM may transfer token ownership.');
        }
        Object.assign(token, payload.details);
        token.revision++;
        break;
      }
      case 'token.delete': {
        const token = this.requireToken(scene, payload.tokenId);
        this.requireTokenOwner(actor, token);
        this.requireTokenRevision(token, payload.expectedTokenRevision);
        delete scene.tokens[payload.tokenId];
        break;
      }
    }
    return { ...payload } as Record<string, JsonValue>;
  }

  private applySynchronized(type: Exclude<DurableCommandName, 'asset.reserve'>, payload: Record<string, any>, scene: SceneV2): void {
    switch (type) {
      case 'map.set':
        this.state.map = scene.map ? new RoomMap(scene.map) : undefined;
        break;
      case 'grid.set':
        this.state.grid = new RoomGrid({ ...scene.grid, offset: new RoomPoint(scene.grid.offset) });
        break;
      case 'permissions.playerMovement.set':
        this.state.permissions.playerMovement = scene.permissions.playerMovement;
        break;
      case 'token.create': {
        const token = scene.tokens[payload.token.id]!;
        this.state.tokens.set(token.id, this.toRoomToken(token));
        break;
      }
      case 'token.transform.commit':
      case 'token.details.update': {
        const token = scene.tokens[payload.tokenId]!;
        const live = this.state.tokens.get(payload.tokenId);
        if (live) {
          const preview = this.previews.get(payload.tokenId);
          const previewPosition = preview && type === 'token.details.update'
            ? { x: live.position.x, y: live.position.y, rotation: live.rotation }
            : undefined;
          Object.assign(live, this.toRoomToken(token));
          if (previewPosition) {
            live.position.x = previewPosition.x;
            live.position.y = previewPosition.y;
            live.rotation = previewPosition.rotation;
          }
        }
        break;
      }
      case 'token.delete':
        this.state.tokens.delete(payload.tokenId);
        break;
    }
  }

  private toRoomToken(token: TokenRecord): RoomToken {
    return new RoomToken({ ...token, position: new RoomPoint(token.position), size: new RoomSize(token.size) });
  }

  private requireToken(scene: SceneV2, tokenId: string): TokenRecord {
    const token = scene.tokens[tokenId];
    if (!token) throw new CommandError('not_found', 'Token not found.');
    return token;
  }

  private requireTokenRevision(token: TokenRecord, expectedRevision: number): void {
    if (token.revision !== expectedRevision) {
      throw new CommandError('conflict', `Token revision conflict: expected ${expectedRevision}, current ${token.revision}.`);
    }
  }

  private async requireReadyAsset(assetId: string, kind: 'map' | 'token') {
    const asset = await this.persistence.getRoomAsset(assetId);
    if (!asset) throw new CommandError('not_found', 'Asset not found.');
    if (asset.roomId !== this.roomId) throw new CommandError('forbidden', 'Asset belongs to another room.');
    if (asset.kind !== kind) throw new CommandError('conflict', `A ${kind} asset is required.`);
    if (asset.status !== 'ready') throw new CommandError('conflict', 'Asset is not ready.');
    return asset;
  }

  private requireDm(actor: Actor): void {
    if (actor.role !== 'dm') throw new CommandError('forbidden', 'DM permission required.');
  }

  private requireTokenOwner(actor: Actor, token: TokenRecord): void {
    if (actor.role !== 'dm' && token.ownerId !== actor.userId) throw new CommandError('forbidden', 'Token ownership required.');
  }

  private requireTokenMovement(actor: Actor, token: TokenRecord): void {
    if (actor.role !== 'dm' && this.canonical.permissions.playerMovement !== 'all' && token.ownerId !== actor.userId) {
      throw new CommandError('forbidden', 'Token movement is not permitted.');
    }
  }

  private clearPreview(tokenId: string, revert: boolean): void {
    const preview = this.previews.get(tokenId);
    if (!preview) return;
    clearTimeout(preview.timer);
    this.previews.delete(tokenId);
    if (revert) {
      const token = this.canonical.tokens[tokenId];
      const live = this.state.tokens.get(tokenId);
      if (token && live) {
        live.position.x = token.position.x;
        live.position.y = token.position.y;
        live.rotation = token.rotation;
      }
    }
  }

  private revertPreview(tokenId: string): void { this.clearPreview(tokenId, true); }
}
