import {
  assetReserveCommandSchema,
  drawingCreateCommandSchema,
  drawingDeleteCommandSchema,
  drawingUpdateCommandSchema,
  fogClearCommandSchema,
  fogOperationCommitCommandSchema,
  fogUndoCommandSchema,
  gridSetCommandSchema,
  initiativeAdvanceCommandSchema,
  initiativeEntryAddCommandSchema,
  initiativeEntryRemoveCommandSchema,
  initiativeEntryUpdateCommandSchema,
  initiativeReorderCommandSchema,
  initiativeStartCommandSchema,
  initiativeStopCommandSchema,
  mapSetCommandSchema,
  playerMovementSetCommandSchema,
  playerDrawingSetCommandSchema,
  playerPerspectiveViewSetCommandSchema,
  structureCreateCommandSchema,
  structureDeleteCommandSchema,
  structureUpdateCommandSchema,
  tokenCreateCommandSchema,
  tokenDeleteCommandSchema,
  tokenDetailsUpdateCommandSchema,
  tokenMoveCommitSchema,
  tokenTransformCommitSchema,
  tokenTransformPreviewSchema,
  wallCreateCommandSchema,
  wallDeleteCommandSchema,
  wallUpdateCommandSchema,
  type MultiplayerCommandName,
} from '@hearth/domain';
import { findNavigationPath, navigationCellCenter, worldToNavigationCell } from '@hearth/movement';
import { RoomDrawing, RoomFog, RoomFogOperation, RoomGrid, RoomGridPoint, RoomInitiative, RoomInitiativeEntry, RoomMap, RoomPoint, RoomSize, RoomStructure, RoomToken, RoomTokenMovement, RoomWall, type RoomScene } from '@hearth/room-schema';
import { cloneScene, createTokenMovementState, parseSceneV2, polygonArea, type DrawingRecord, type FogOperation, type InitiativeEntry, type JsonValue, type SceneV2, type StructureRecord, type TokenRecord, type WallRecord } from '@hearth/scene';
import type { Actor, Persistence } from './contracts.js';

export class CommandError extends Error {
  constructor(public readonly code: 'forbidden' | 'not_found' | 'conflict' | 'rate_limited', message: string) {
    super(message);
  }
}

/** Shared command authorization predicates used by both execution and projection. */
export function canMoveToken(actor: Actor, scene: SceneV2, token: TokenRecord): boolean {
  return actor.role === 'dm' || scene.permissions.playerMovement === 'all' || token.ownerId === actor.userId;
}

export function canEditToken(actor: Actor, token: TokenRecord): boolean {
  return actor.role === 'dm' || token.ownerId === actor.userId;
}

export function canCreateDrawing(actor: Actor, scene: SceneV2): boolean {
  return actor.role === 'dm' || (scene.permissions.playerDrawing ?? 'own') !== 'none';
}

export function canEditDrawing(actor: Actor, scene: SceneV2, drawing: DrawingRecord): boolean {
  if (actor.role === 'dm') return true;
  const permission = scene.permissions.playerDrawing ?? 'own';
  return permission === 'all' || (permission === 'own' && drawing.ownerId === actor.userId);
}

export function canEditInitiativeEntry(actor: Actor, scene: SceneV2, entry: InitiativeEntry): boolean {
  if (actor.role === 'dm') return true;
  const token = scene.tokens[entry.tokenId];
  return token !== undefined && token.ownerId === actor.userId;
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
  'permissions.playerDrawing.set': playerDrawingSetCommandSchema,
  'permissions.playerPerspectiveView.set': playerPerspectiveViewSetCommandSchema,
  'token.create': tokenCreateCommandSchema,
  'token.transform.commit': tokenTransformCommitSchema,
  'token.move.commit': tokenMoveCommitSchema,
  'token.details.update': tokenDetailsUpdateCommandSchema,
  'token.delete': tokenDeleteCommandSchema,
  'initiative.entry.add': initiativeEntryAddCommandSchema,
  'initiative.entry.update': initiativeEntryUpdateCommandSchema,
  'initiative.entry.remove': initiativeEntryRemoveCommandSchema,
  'initiative.reorder': initiativeReorderCommandSchema,
  'initiative.start': initiativeStartCommandSchema,
  'initiative.advance': initiativeAdvanceCommandSchema,
  'initiative.stop': initiativeStopCommandSchema,
  'fog.operation.commit': fogOperationCommitCommandSchema,
  'fog.undo': fogUndoCommandSchema,
  'fog.clear': fogClearCommandSchema,
  'drawing.create': drawingCreateCommandSchema,
  'drawing.update': drawingUpdateCommandSchema,
  'drawing.delete': drawingDeleteCommandSchema,
  'wall.create': wallCreateCommandSchema,
  'wall.update': wallUpdateCommandSchema,
  'wall.delete': wallDeleteCommandSchema,
  'structure.create': structureCreateCommandSchema,
  'structure.update': structureUpdateCommandSchema,
  'structure.delete': structureDeleteCommandSchema,
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
    if (type === 'wall.create' || type === 'wall.update' || type === 'wall.delete'
      || type === 'permissions.playerPerspectiveView.set'
      || type === 'structure.create' || type === 'structure.update' || type === 'structure.delete') this.requireDm(actor);
    const fingerprint = JSON.stringify({ type, command });
    const receipt = this.receipts.get(command.commandId);
    if (receipt) {
      if (receipt.fingerprint !== fingerprint) throw new CommandError('conflict', 'Command ID was already used with different input.');
      return { ...receipt.outcome, duplicate: true };
    }

    if (type === 'token.transform.commit' || type === 'token.move.commit') {
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
      if (type === 'token.transform.commit' || type === 'token.move.commit') this.clearPreview(command.payload.tokenId as string, false);
      if (type === 'token.delete') this.clearPreview(command.payload.tokenId as string, false);
      const outcome = { commandId: command.commandId, sceneRevision: this.sceneRevision, result: committed };
      this.receipts.set(command.commandId, { fingerprint, outcome });
      return outcome;
    } catch (error) {
      if (type === 'token.transform.commit' || type === 'token.move.commit') this.revertPreview(command.payload.tokenId as string);
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
    let eventPayload = payload;
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
        scene.navigationRevision = (scene.navigationRevision ?? 0) + 1;
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
        scene.navigationRevision = (scene.navigationRevision ?? 0) + 1;
        break;
      case 'permissions.playerMovement.set':
        this.requireDm(actor);
        scene.permissions.playerMovement = payload.playerMovement;
        break;
      case 'permissions.playerDrawing.set':
        this.requireDm(actor);
        scene.permissions.playerDrawing = payload.playerDrawing;
        break;
      case 'permissions.playerPerspectiveView.set':
        this.requireDm(actor);
        scene.permissions.playerPerspectiveView = payload.enabled;
        break;
      case 'token.create': {
        const token = { ...payload.token, movement: payload.token.movement ?? createTokenMovementState(), revision: 0 } as TokenRecord;
        if (scene.tokens[token.id]) throw new CommandError('conflict', 'Token already exists.');
        if (actor.role !== 'dm' && token.ownerId !== actor.userId) throw new CommandError('forbidden', 'Players may only create their own tokens.');
        await this.requireReadyAsset(token.assetId, 'token');
        scene.tokens[token.id] = token;
        scene.navigationRevision = (scene.navigationRevision ?? 0) + 1;
        break;
      }
      case 'token.transform.commit': {
        const token = this.requireToken(scene, payload.tokenId);
        this.requireTokenMovement(actor, token);
        this.requireTokenRevision(token, payload.expectedTokenRevision);
        if (actor.role !== 'dm' && scene.initiative.active && (token.movement?.allowanceCells ?? null) !== null) {
          throw new CommandError('conflict', 'Budgeted encounter movement must use an authoritative destination command.');
        }
        token.position = payload.position;
        token.rotation = payload.rotation;
        const movement = token.movement ?? createTokenMovementState();
        token.movement = {
          ...movement,
          activePath: [],
          pathCostCells: 0,
          pathStartedAtServerMs: null,
          status: movement.status === 'moving' ? 'interrupted' : 'idle',
          revision: movement.revision + 1,
        };
        token.revision++;
        scene.navigationRevision = (scene.navigationRevision ?? 0) + 1;
        break;
      }
      case 'token.move.commit': {
        const token = this.requireToken(scene, payload.tokenId);
        this.requireTokenMovement(actor, token);
        this.requireTokenRevision(token, payload.expectedTokenRevision);
        if (scene.initiative.active) {
          const activeTokenId = scene.initiative.turnIndex === null ? undefined : scene.initiative.entries[scene.initiative.turnIndex]?.tokenId;
          if (activeTokenId !== token.id) throw new CommandError('conflict', 'Token does not have the active initiative turn.');
        }
        const movement = token.movement ?? createTokenMovementState();
        if ((scene.navigationRevision ?? 0) !== payload.expectedNavigationRevision) {
          throw new CommandError('conflict', `Navigation revision conflict: expected ${payload.expectedNavigationRevision}, current ${scene.navigationRevision ?? 0}.`);
        }
        if (movement.revision !== payload.expectedMovementRevision) {
          throw new CommandError('conflict', `Movement revision conflict: expected ${payload.expectedMovementRevision}, current ${movement.revision}.`);
        }
        if (!scene.map) throw new CommandError('conflict', 'A map is required for grid movement.');
        const path = findNavigationPath(scene, token.id, worldToNavigationCell(scene, token.position), payload.destination);
        if (!path) throw new CommandError('conflict', 'Destination is not reachable.');
        const remaining = movement.allowanceCells === null ? Number.POSITIVE_INFINITY : movement.allowanceCells - movement.spentCells;
        if (path.costCells > remaining + Number.EPSILON) throw new CommandError('conflict', 'Destination exceeds the remaining movement allowance.');
        token.position = navigationCellCenter(scene, payload.destination);
        token.movement = {
          ...movement,
          spentCells: movement.spentCells + path.costCells,
          activePath: path.path,
          pathCostCells: path.costCells,
          pathStartedAtServerMs: this.now(),
          status: path.costCells === 0 ? 'idle' : 'moving',
          revision: movement.revision + 1,
        };
        token.revision++;
        scene.navigationRevision = (scene.navigationRevision ?? 0) + 1;
        eventPayload = { ...payload, acceptedPath: path.path, pathCostCells: path.costCells };
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
        if (payload.details.size !== undefined) scene.navigationRevision = (scene.navigationRevision ?? 0) + 1;
        break;
      }
      case 'token.delete': {
        const token = this.requireToken(scene, payload.tokenId);
        this.requireTokenOwner(actor, token);
        this.requireTokenRevision(token, payload.expectedTokenRevision);
        if (scene.initiative.active && scene.initiative.entries.some((entry) => entry.tokenId === token.id)) {
          throw new CommandError('conflict', 'Remove the token from active initiative before deleting it.');
        }
        delete scene.tokens[payload.tokenId];
        scene.navigationRevision = (scene.navigationRevision ?? 0) + 1;
        break;
      }
      case 'wall.create': {
        this.requireDm(actor);
        this.requireWallRevision(scene, payload.expectedWallRevision);
        const input = payload.wall as Omit<WallRecord, 'revision'>;
        if (scene.walls[input.id]) throw new CommandError('conflict', 'Wall already exists.');
        const wall = { ...input, revision: 0 } as WallRecord;
        scene.walls[wall.id] = wall;
        this.invalidateMovement(scene);
        scene.wallRevision = (scene.wallRevision ?? 0) + 1;
        scene.navigationRevision = (scene.navigationRevision ?? 0) + 1;
        eventPayload = { wall, expectedWallRevision: payload.expectedWallRevision };
        break;
      }
      case 'wall.update': {
        this.requireDm(actor);
        this.requireWallRevision(scene, payload.expectedWallRevision);
        const input = payload.wall as Omit<WallRecord, 'revision'>;
        const current = this.requireWall(scene, input.id);
        if (current.revision !== payload.expectedRecordRevision) {
          throw new CommandError('conflict', `Wall revision conflict: expected ${payload.expectedRecordRevision}, current ${current.revision}.`);
        }
        const wall = { ...input, revision: current.revision + 1 } as WallRecord;
        scene.walls[wall.id] = wall;
        this.invalidateMovement(scene);
        scene.wallRevision = (scene.wallRevision ?? 0) + 1;
        scene.navigationRevision = (scene.navigationRevision ?? 0) + 1;
        eventPayload = { wall, expectedWallRevision: payload.expectedWallRevision, expectedRecordRevision: payload.expectedRecordRevision };
        break;
      }
      case 'wall.delete': {
        this.requireDm(actor);
        this.requireWallRevision(scene, payload.expectedWallRevision);
        const wall = this.requireWall(scene, payload.wallId);
        if (wall.revision !== payload.expectedRecordRevision) {
          throw new CommandError('conflict', `Wall revision conflict: expected ${payload.expectedRecordRevision}, current ${wall.revision}.`);
        }
        delete scene.walls[wall.id];
        this.invalidateMovement(scene);
        scene.wallRevision = (scene.wallRevision ?? 0) + 1;
        scene.navigationRevision = (scene.navigationRevision ?? 0) + 1;
        eventPayload = { wallId: wall.id, expectedWallRevision: payload.expectedWallRevision, expectedRecordRevision: payload.expectedRecordRevision };
        break;
      }
      case 'structure.create': {
        this.requireDm(actor);
        this.requireStructureRevision(scene, payload.expectedStructureRevision);
        const input = payload.structure as Omit<StructureRecord, 'revision'>;
        if (scene.structures[input.id]) throw new CommandError('conflict', 'Structure already exists.');
        const structure = { ...input, revision: 0 } as StructureRecord;
        scene.structures[structure.id] = structure;
        scene.structureRevision = (scene.structureRevision ?? 0) + 1;
        eventPayload = { structure, expectedStructureRevision: payload.expectedStructureRevision };
        break;
      }
      case 'structure.update': {
        this.requireDm(actor);
        this.requireStructureRevision(scene, payload.expectedStructureRevision);
        const input = payload.structure as Omit<StructureRecord, 'revision'>;
        const current = this.requireStructure(scene, input.id);
        if (current.revision !== payload.expectedRecordRevision) {
          throw new CommandError('conflict', `Structure revision conflict: expected ${payload.expectedRecordRevision}, current ${current.revision}.`);
        }
        const structure = { ...input, revision: current.revision + 1 } as StructureRecord;
        scene.structures[structure.id] = structure;
        scene.structureRevision = (scene.structureRevision ?? 0) + 1;
        eventPayload = { structure, expectedStructureRevision: payload.expectedStructureRevision, expectedRecordRevision: payload.expectedRecordRevision };
        break;
      }
      case 'structure.delete': {
        this.requireDm(actor);
        this.requireStructureRevision(scene, payload.expectedStructureRevision);
        const structure = this.requireStructure(scene, payload.structureId);
        if (structure.revision !== payload.expectedRecordRevision) {
          throw new CommandError('conflict', `Structure revision conflict: expected ${payload.expectedRecordRevision}, current ${structure.revision}.`);
        }
        delete scene.structures[structure.id];
        scene.structureRevision = (scene.structureRevision ?? 0) + 1;
        eventPayload = { structureId: structure.id, expectedStructureRevision: payload.expectedStructureRevision, expectedRecordRevision: payload.expectedRecordRevision };
        break;
      }
      case 'fog.operation.commit': {
        this.requireDm(actor);
        this.requireFogRevision(scene, payload.expectedFogRevision);
        if (!scene.map) throw new CommandError('conflict', 'A map is required for fog editing.');
        const input = payload.operation as Pick<FogOperation, 'id' | 'kind' | 'points'>;
        if (scene.fog.operations.some((operation) => operation.id === input.id)) {
          throw new CommandError('conflict', 'Fog operation already exists.');
        }
        if (polygonArea(input.points) <= 1e-6) throw new CommandError('conflict', 'Fog polygon must enclose an area.');
        if (input.points.some((point) => point.x < 0 || point.y < 0 || point.x > scene.map!.width || point.y > scene.map!.height)) {
          throw new CommandError('conflict', 'Fog polygon must stay within the map.');
        }
        const revision = (scene.fog.revision ?? 0) + 1;
        const operation: FogOperation = { ...input, playerId: null, revision };
        if (!(scene.fog.enabled ?? false)) {
          scene.fog.enabled = true;
          scene.fog.base = operation.kind === 'reveal' ? 'concealed' : 'revealed';
        }
        scene.fog.operations.push(operation);
        scene.fog.revision = revision;
        eventPayload = { operation, expectedFogRevision: payload.expectedFogRevision };
        break;
      }
      case 'fog.undo': {
        this.requireDm(actor);
        this.requireFogRevision(scene, payload.expectedFogRevision);
        const operation = scene.fog.operations.at(-1);
        if (!operation) throw new CommandError('conflict', 'There is no fog operation to undo.');
        if (payload.expectedOperationId !== undefined && payload.expectedOperationId !== operation.id) {
          throw new CommandError('conflict', 'The latest fog operation changed before undo.');
        }
        scene.fog.operations.pop();
        scene.fog.revision = (scene.fog.revision ?? 0) + 1;
        if (!scene.fog.operations.length) {
          scene.fog.enabled = false;
          scene.fog.base = 'revealed';
        }
        eventPayload = { expectedFogRevision: payload.expectedFogRevision, operationId: operation.id };
        break;
      }
      case 'fog.clear':
        this.requireDm(actor);
        this.requireFogRevision(scene, payload.expectedFogRevision);
        if (!(scene.fog.enabled ?? false) && !scene.fog.operations.length) throw new CommandError('conflict', 'Fog is already clear.');
        scene.fog.operations = [];
        scene.fog.enabled = false;
        scene.fog.base = 'revealed';
        scene.fog.revision = (scene.fog.revision ?? 0) + 1;
        break;
      case 'drawing.create': {
        this.requireDrawingRevision(scene, payload.expectedDrawingRevision);
        this.requireDrawingCreation(actor, scene);
        if (!scene.map) throw new CommandError('conflict', 'A map is required for drawing.');
        const input = payload.drawing as Omit<DrawingRecord, 'ownerId' | 'revision'>;
        if (scene.drawings[input.id]) throw new CommandError('conflict', 'Drawing already exists.');
        this.validateDrawingGeometry(input, scene.map);
        const drawing: DrawingRecord = { ...input, ownerId: actor.userId, revision: 0 };
        scene.drawings[drawing.id] = drawing;
        scene.drawingRevision = (scene.drawingRevision ?? 0) + 1;
        eventPayload = { drawing, expectedDrawingRevision: payload.expectedDrawingRevision };
        break;
      }
      case 'drawing.update': {
        this.requireDrawingRevision(scene, payload.expectedDrawingRevision);
        const drawing = this.requireDrawing(scene, payload.drawingId);
        this.requireDrawingControl(actor, scene, drawing);
        if (drawing.revision !== payload.expectedRecordRevision) {
          throw new CommandError('conflict', `Drawing revision conflict: expected ${payload.expectedRecordRevision}, current ${drawing.revision}.`);
        }
        Object.assign(drawing, payload.details);
        drawing.revision++;
        scene.drawingRevision = (scene.drawingRevision ?? 0) + 1;
        break;
      }
      case 'drawing.delete': {
        this.requireDrawingRevision(scene, payload.expectedDrawingRevision);
        const drawing = this.requireDrawing(scene, payload.drawingId);
        this.requireDrawingControl(actor, scene, drawing);
        if (drawing.revision !== payload.expectedRecordRevision) {
          throw new CommandError('conflict', `Drawing revision conflict: expected ${payload.expectedRecordRevision}, current ${drawing.revision}.`);
        }
        delete scene.drawings[drawing.id];
        scene.drawingRevision = (scene.drawingRevision ?? 0) + 1;
        break;
      }
      case 'initiative.entry.add': {
        this.requireInitiativeRevision(scene, payload.expectedInitiativeRevision);
        const entry = payload.entry as InitiativeEntry;
        if (scene.initiative.entries.some((candidate) => candidate.id === entry.id)) {
          throw new CommandError('conflict', 'Initiative entry already exists.');
        }
        this.requireInitiativeEntryControl(scene, actor, entry);
        scene.initiative.entries.push(entry);
        scene.initiative.revision = (scene.initiative.revision ?? 0) + 1;
        break;
      }
      case 'initiative.entry.update': {
        this.requireInitiativeRevision(scene, payload.expectedInitiativeRevision);
        const entry = this.requireInitiativeEntry(scene, payload.entryId);
        this.requireInitiativeEntryControl(scene, actor, entry);
        Object.assign(entry, payload.details);
        scene.initiative.revision = (scene.initiative.revision ?? 0) + 1;
        break;
      }
      case 'initiative.entry.remove': {
        this.requireInitiativeRevision(scene, payload.expectedInitiativeRevision);
        const entry = this.requireInitiativeEntry(scene, payload.entryId);
        this.requireInitiativeEntryControl(scene, actor, entry);
        const removedIndex = scene.initiative.entries.indexOf(entry);
        const activeEntryId = scene.initiative.turnIndex === null
          ? undefined
          : scene.initiative.entries[scene.initiative.turnIndex]?.id;
        if (actor.role !== 'dm' && scene.initiative.active && activeEntryId === entry.id) {
          throw new CommandError('forbidden', 'Only the DM may remove the active initiative entry.');
        }
        scene.initiative.entries.splice(removedIndex, 1);
        if (!scene.initiative.entries.length) {
          scene.initiative.active = false;
          scene.initiative.turnIndex = null;
        } else if (scene.initiative.active && activeEntryId === entry.id) {
          if (removedIndex >= scene.initiative.entries.length) scene.initiative.round++;
          scene.initiative.turnIndex = removedIndex % scene.initiative.entries.length;
          this.resetActiveTokenMovement(scene);
        } else if (scene.initiative.active && activeEntryId) {
          scene.initiative.turnIndex = scene.initiative.entries.findIndex((candidate) => candidate.id === activeEntryId);
        }
        scene.initiative.revision = (scene.initiative.revision ?? 0) + 1;
        break;
      }
      case 'initiative.reorder': {
        this.requireDm(actor);
        this.requireInitiativeRevision(scene, payload.expectedInitiativeRevision);
        const entryIds = payload.entryIds as string[];
        const byId = new Map(scene.initiative.entries.map((entry) => [entry.id, entry]));
        if (entryIds.length !== byId.size || new Set(entryIds).size !== entryIds.length || entryIds.some((id) => !byId.has(id))) {
          throw new CommandError('conflict', 'Initiative reorder must contain every entry exactly once.');
        }
        const activeEntryId = scene.initiative.turnIndex === null ? undefined : scene.initiative.entries[scene.initiative.turnIndex]?.id;
        scene.initiative.entries = entryIds.map((id) => byId.get(id)!);
        if (activeEntryId) scene.initiative.turnIndex = scene.initiative.entries.findIndex((entry) => entry.id === activeEntryId);
        scene.initiative.revision = (scene.initiative.revision ?? 0) + 1;
        break;
      }
      case 'initiative.start':
        this.requireDm(actor);
        this.requireInitiativeRevision(scene, payload.expectedInitiativeRevision);
        if (!scene.initiative.entries.length) throw new CommandError('conflict', 'Initiative requires at least one entry.');
        if (scene.initiative.active) throw new CommandError('conflict', 'Initiative is already active.');
        scene.initiative.active = true;
        scene.initiative.round = 1;
        scene.initiative.turnIndex = 0;
        this.resetActiveTokenMovement(scene);
        scene.initiative.revision = (scene.initiative.revision ?? 0) + 1;
        break;
      case 'initiative.advance':
        this.requireDm(actor);
        this.requireInitiativeRevision(scene, payload.expectedInitiativeRevision);
        if (!scene.initiative.active || scene.initiative.turnIndex === null || !scene.initiative.entries.length) {
          throw new CommandError('conflict', 'Initiative is not active.');
        }
        scene.initiative.turnIndex++;
        if (scene.initiative.turnIndex >= scene.initiative.entries.length) {
          scene.initiative.turnIndex = 0;
          scene.initiative.round++;
        }
        this.resetActiveTokenMovement(scene);
        scene.initiative.revision = (scene.initiative.revision ?? 0) + 1;
        break;
      case 'initiative.stop':
        this.requireDm(actor);
        this.requireInitiativeRevision(scene, payload.expectedInitiativeRevision);
        scene.initiative.active = false;
        scene.initiative.turnIndex = null;
        scene.initiative.revision = (scene.initiative.revision ?? 0) + 1;
        break;
    }
    return { ...eventPayload } as Record<string, JsonValue>;
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
      case 'permissions.playerDrawing.set':
        this.state.permissions.playerDrawing = scene.permissions.playerDrawing ?? 'own';
        break;
      case 'permissions.playerPerspectiveView.set':
        this.state.permissions.playerPerspectiveView = scene.permissions.playerPerspectiveView ?? false;
        break;
      case 'token.create': {
        const token = scene.tokens[payload.token.id]!;
        this.state.tokens.set(token.id, this.toRoomToken(token));
        break;
      }
      case 'token.transform.commit':
      case 'token.move.commit':
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
      case 'fog.operation.commit':
      case 'fog.undo':
      case 'fog.clear':
        this.state.fog = this.toRoomFog(scene);
        break;
      case 'drawing.create': {
        const drawing = scene.drawings[payload.drawing.id]!;
        this.state.drawings.set(drawing.id, this.toRoomDrawing(drawing));
        this.state.drawingRevision = scene.drawingRevision ?? 0;
        break;
      }
      case 'drawing.update': {
        const drawing = scene.drawings[payload.drawingId]!;
        this.state.drawings.set(drawing.id, this.toRoomDrawing(drawing));
        this.state.drawingRevision = scene.drawingRevision ?? 0;
        break;
      }
      case 'drawing.delete':
        this.state.drawings.delete(payload.drawingId);
        this.state.drawingRevision = scene.drawingRevision ?? 0;
        break;
      case 'wall.create':
      case 'wall.update': {
        for (const token of Object.values(scene.tokens)) this.state.tokens.set(token.id, this.toRoomToken(token));
        const wall = scene.walls[payload.wall.id]!;
        this.state.walls.set(wall.id, this.toRoomWall(wall));
        break;
      }
      case 'wall.delete':
        for (const token of Object.values(scene.tokens)) this.state.tokens.set(token.id, this.toRoomToken(token));
        this.state.walls.delete(payload.wallId);
        break;
      case 'structure.create':
      case 'structure.update': {
        const structure = scene.structures[payload.structure.id]!;
        this.state.structures.set(structure.id, this.toRoomStructure(structure));
        break;
      }
      case 'structure.delete':
        this.state.structures.delete(payload.structureId);
        break;
      case 'initiative.entry.add':
      case 'initiative.entry.update':
      case 'initiative.entry.remove':
      case 'initiative.reorder':
      case 'initiative.start':
      case 'initiative.advance':
      case 'initiative.stop': {
        this.state.initiative = this.toRoomInitiative(scene);
        if (scene.initiative.turnIndex !== null) {
          const tokenId = scene.initiative.entries[scene.initiative.turnIndex]?.tokenId;
          const token = tokenId ? scene.tokens[tokenId] : undefined;
          const live = tokenId ? this.state.tokens.get(tokenId) : undefined;
          if (token && live) Object.assign(live, this.toRoomToken(token));
        }
        break;
      }
    }
    this.state.navigationRevision = scene.navigationRevision ?? 0;
    this.state.wallRevision = scene.wallRevision ?? 0;
    this.state.structureRevision = scene.structureRevision ?? 0;
  }

  private toRoomToken(token: TokenRecord): RoomToken {
    const movement = token.movement ?? createTokenMovementState();
    const roomMovement = new RoomTokenMovement({
      allowanceCells: movement.allowanceCells ?? 0,
      unlimited: movement.allowanceCells === null,
      spentCells: movement.spentCells,
      pathCostCells: movement.pathCostCells,
      pathStartedAtServerMs: movement.pathStartedAtServerMs ?? -1,
      millisecondsPerCell: movement.millisecondsPerCell,
      status: movement.status,
      revision: movement.revision,
    });
    roomMovement.activePath.push(...movement.activePath.map((point) => new RoomGridPoint(point)));
    return new RoomToken({ ...token, position: new RoomPoint(token.position), size: new RoomSize(token.size), movement: roomMovement });
  }

  private toRoomInitiative(scene: SceneV2): RoomInitiative {
    const initiative = new RoomInitiative({
      version: scene.initiative.version,
      active: scene.initiative.active,
      round: scene.initiative.round,
      turnIndex: scene.initiative.turnIndex ?? -1,
      revision: scene.initiative.revision ?? 0,
    });
    initiative.entries.push(...scene.initiative.entries.map((entry) => new RoomInitiativeEntry(entry)));
    return initiative;
  }

  private toRoomFog(scene: SceneV2): RoomFog {
    const fog = new RoomFog({
      version: scene.fog.version,
      mode: scene.fog.mode,
      enabled: scene.fog.enabled ?? false,
      base: scene.fog.base ?? 'revealed',
      revision: scene.fog.revision ?? 0,
    });
    for (const operation of scene.fog.operations) {
      const roomOperation = new RoomFogOperation({
        id: operation.id,
        kind: operation.kind,
        playerId: operation.playerId ?? '',
        revision: operation.revision,
      });
      roomOperation.points.push(...operation.points.map((point) => new RoomPoint(point)));
      fog.operations.push(roomOperation);
    }
    return fog;
  }

  private toRoomDrawing(drawing: DrawingRecord): RoomDrawing {
    const roomDrawing = new RoomDrawing({
      id: drawing.id,
      kind: drawing.kind,
      color: drawing.color,
      width: drawing.width,
      fill: drawing.fill ?? '',
      hidden: drawing.hidden ?? false,
      ownerId: drawing.ownerId ?? '',
      z: drawing.z,
      revision: drawing.revision,
    });
    roomDrawing.points.push(...drawing.points.map((point) => new RoomPoint(point)));
    return roomDrawing;
  }

  private toRoomWall(wall: WallRecord): RoomWall {
    return new RoomWall({
      ...wall,
      start: new RoomPoint(wall.start),
      end: new RoomPoint(wall.end),
      doorState: wall.type === 'door' ? wall.doorState : '',
    });
  }

  private toRoomStructure(structure: StructureRecord): RoomStructure {
    return new RoomStructure({
      ...structure,
      position: new RoomPoint(structure.position),
      size: new RoomSize(structure.size),
    });
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

  private requireInitiativeRevision(scene: SceneV2, expectedRevision: number): void {
    const revision = scene.initiative.revision ?? 0;
    if (revision !== expectedRevision) {
      throw new CommandError('conflict', `Initiative revision conflict: expected ${expectedRevision}, current ${revision}.`);
    }
  }

  private requireFogRevision(scene: SceneV2, expectedRevision: number): void {
    const revision = scene.fog.revision ?? 0;
    if (revision !== expectedRevision) {
      throw new CommandError('conflict', `Fog revision conflict: expected ${expectedRevision}, current ${revision}.`);
    }
  }

  private requireDrawingRevision(scene: SceneV2, expectedRevision: number): void {
    const revision = scene.drawingRevision ?? 0;
    if (revision !== expectedRevision) {
      throw new CommandError('conflict', `Drawing collection revision conflict: expected ${expectedRevision}, current ${revision}.`);
    }
  }

  private requireWallRevision(scene: SceneV2, expectedRevision: number): void {
    const revision = scene.wallRevision ?? 0;
    if (revision !== expectedRevision) {
      throw new CommandError('conflict', `Wall collection revision conflict: expected ${expectedRevision}, current ${revision}.`);
    }
  }

  private requireStructureRevision(scene: SceneV2, expectedRevision: number): void {
    const revision = scene.structureRevision ?? 0;
    if (revision !== expectedRevision) {
      throw new CommandError('conflict', `Structure collection revision conflict: expected ${expectedRevision}, current ${revision}.`);
    }
  }

  private requireDrawing(scene: SceneV2, drawingId: string): DrawingRecord {
    const drawing = scene.drawings[drawingId];
    if (!drawing) throw new CommandError('not_found', 'Drawing not found.');
    return drawing;
  }

  private requireWall(scene: SceneV2, wallId: string): WallRecord {
    const wall = scene.walls[wallId];
    if (!wall) throw new CommandError('not_found', 'Wall not found.');
    return wall;
  }

  private requireStructure(scene: SceneV2, structureId: string): StructureRecord {
    const structure = scene.structures[structureId];
    if (!structure) throw new CommandError('not_found', 'Structure not found.');
    return structure;
  }

  private requireDrawingCreation(actor: Actor, scene: SceneV2): void {
    if (!canCreateDrawing(actor, scene)) {
      throw new CommandError('forbidden', 'Player drawing is disabled.');
    }
  }

  private requireDrawingControl(actor: Actor, scene: SceneV2, drawing: DrawingRecord): void {
    if (!canEditDrawing(actor, scene, drawing)) {
      throw new CommandError('forbidden', 'Drawing ownership required.');
    }
  }

  private validateDrawingGeometry(drawing: Pick<DrawingRecord, 'kind' | 'points'>, map: NonNullable<SceneV2['map']>): void {
    if (drawing.points.some((point) => point.x < 0 || point.y < 0 || point.x > map.width || point.y > map.height)) {
      throw new CommandError('conflict', 'Drawing must stay within the map.');
    }
    if (drawing.kind === 'polygon') {
      if (drawing.points.length < 3 || polygonArea(drawing.points) <= 1e-6) {
        throw new CommandError('conflict', 'Drawing polygon must enclose an area.');
      }
      return;
    }
    const length = drawing.points.slice(1).reduce((total, point, index) => {
      const previous = drawing.points[index]!;
      return total + Math.hypot(point.x - previous.x, point.y - previous.y);
    }, 0);
    if (length <= 1e-6) throw new CommandError('conflict', 'Drawing line must have length.');
  }

  private requireInitiativeEntry(scene: SceneV2, entryId: string): InitiativeEntry {
    const entry = scene.initiative.entries.find((candidate) => candidate.id === entryId);
    if (!entry) throw new CommandError('not_found', 'Initiative entry not found.');
    return entry;
  }

  private requireInitiativeEntryControl(scene: SceneV2, actor: Actor, entry: InitiativeEntry): void {
    if (!canEditInitiativeEntry(actor, scene, entry)) {
      throw new CommandError('forbidden', 'Initiative entry ownership required.');
    }
  }

  private resetActiveTokenMovement(scene: SceneV2): void {
    if (scene.initiative.turnIndex === null) return;
    const tokenId = scene.initiative.entries[scene.initiative.turnIndex]?.tokenId;
    const token = tokenId ? scene.tokens[tokenId] : undefined;
    if (!token) return;
    const movement = token.movement ?? createTokenMovementState();
    token.movement = {
      ...movement,
      spentCells: 0,
      activePath: [],
      pathCostCells: 0,
      pathStartedAtServerMs: null,
      status: 'idle',
      revision: movement.revision + 1,
    };
    token.revision++;
  }

  private invalidateMovement(scene: SceneV2): void {
    for (const token of Object.values(scene.tokens)) {
      const movement = token.movement ?? createTokenMovementState();
      const hasPlayback = movement.status === 'moving'
        || movement.activePath.length > 0
        || movement.pathCostCells > 0
        || movement.pathStartedAtServerMs !== null;
      if (!hasPlayback) continue;
      token.movement = {
        ...movement,
        activePath: [],
        pathCostCells: 0,
        pathStartedAtServerMs: null,
        status: movement.status === 'moving' ? 'interrupted' : movement.status,
        revision: movement.revision + 1,
      };
      token.revision++;
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
    if (!canEditToken(actor, token)) throw new CommandError('forbidden', 'Token ownership required.');
  }

  private requireTokenMovement(actor: Actor, token: TokenRecord): void {
    if (!canMoveToken(actor, this.canonical, token)) {
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
