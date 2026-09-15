import { ArraySchema, schema, t, type SchemaType } from '@colyseus/schema';
export { ArraySchema, MapSchema } from '@colyseus/schema';
import {
  createTokenMovementState,
  parseSceneV2,
  type DrawingRecord,
  type EffectRecord,
  type FogOperation,
  type InitiativeEntry,
  type LightRecord,
  type Point,
  type SceneV2,
  type StructureRecord,
  type TokenRecord,
  type WallMaterial,
  type WallOpening,
  type WallRecord,
} from '@hearth/scene';

export const RoomPoint = schema({
  x: t.float64().default(0),
  y: t.float64().default(0),
}, 'RoomPoint');
export type RoomPoint = SchemaType<typeof RoomPoint>;

export const RoomSize = schema({
  width: t.float64().default(1),
  height: t.float64().default(1),
}, 'RoomSize');
export type RoomSize = SchemaType<typeof RoomSize>;

export const RoomCoordinateSystem = schema({
  origin: t.string().default('top-left'),
  axes: t.string().default('x-right-y-down'),
  worldUnit: t.string().default('map-pixel'),
}, 'RoomCoordinateSystem');
export type RoomCoordinateSystem = SchemaType<typeof RoomCoordinateSystem>;

export const RoomMap = schema({
  assetId: t.string(),
  width: t.float64().default(1),
  height: t.float64().default(1),
}, 'RoomMap');
export type RoomMap = SchemaType<typeof RoomMap>;

export const RoomGrid = schema({
  type: t.string().default('square'),
  visible: t.boolean().default(true),
  cellSize: t.float64().default(1),
  offset: RoomPoint,
  distancePerCell: t.float64().default(5),
  unit: t.string().default('ft'),
  snap: t.boolean().default(true),
}, 'RoomGrid');
export type RoomGrid = SchemaType<typeof RoomGrid>;

export const RoomPermissions = schema({
  playerMovement: t.string().default('owned'),
  playerDrawing: t.string().default('own'),
  playerPerspectiveView: t.boolean().default(false),
}, 'RoomPermissions');
export type RoomPermissions = SchemaType<typeof RoomPermissions>;

export const RoomGridPoint = schema({
  column: t.int32().default(0),
  row: t.int32().default(0),
}, 'RoomGridPoint');
export type RoomGridPoint = SchemaType<typeof RoomGridPoint>;

export const RoomTokenMovement = schema({
  allowanceCells: t.float64().default(0),
  unlimited: t.boolean().default(true),
  spentCells: t.float64().default(0),
  activePath: t.array(RoomGridPoint),
  pathCostCells: t.float64().default(0),
  pathStartedAtServerMs: t.float64().default(-1),
  millisecondsPerCell: t.float64().default(250),
  status: t.string().default('idle'),
  revision: t.uint32().default(0),
}, 'RoomTokenMovement');
export type RoomTokenMovement = SchemaType<typeof RoomTokenMovement>;

export const RoomToken = schema({
  id: t.string(),
  assetId: t.string(),
  position: RoomPoint,
  size: RoomSize,
  rotation: t.float64().default(0),
  label: t.string().default(''),
  ownerId: t.string().default(''),
  hpCurrent: t.float64().default(0),
  hpMaximum: t.float64().default(0),
  hpHidden: t.boolean().default(false),
  z: t.float64().default(0),
  movement: RoomTokenMovement,
  revision: t.uint32().default(0),
}, 'RoomToken');
export type RoomToken = SchemaType<typeof RoomToken>;

export const RoomWallOpening = schema({
  type: t.string().default('window'),
  start: t.float64().default(0),
  end: t.float64().default(1),
  bottom: t.float64().default(1),
  height: t.float64().default(1),
}, 'RoomWallOpening');
export type RoomWallOpening = SchemaType<typeof RoomWallOpening>;

const RoomWallSchema = schema({
  id: t.string(),
  type: t.string(),
  start: RoomPoint,
  end: RoomPoint,
  height: t.float64().default(0),
  thickness: t.float64().default(1),
  elevation: t.float64().default(0),
  material: t.string().default('default'),
  openings: t.array(RoomWallOpening),
  doorState: t.string().default(''),
  revision: t.uint32().default(0),
}, 'RoomWall');

// Phase 1 engine projections construct RoomWall from canonical plain records;
// normalize nested opening instances at this schema boundary without changing
// the canonical scene representation.
export class RoomWall extends RoomWallSchema {
  constructor(props?: Record<string, unknown>) {
    if (props === undefined) { super(); return; }
    const openings = props?.openings;
    const normalized = openings instanceof ArraySchema
      ? props
      : props && Array.isArray(openings)
        ? { ...props, openings: openings.map((opening) => opening instanceof RoomWallOpening ? opening : new RoomWallOpening(opening as Record<string, unknown>)) }
        : props;
    super(normalized as never);
  }
}

export const RoomFogOperation = schema({
  id: t.string(),
  kind: t.string(),
  points: t.array(RoomPoint),
  playerId: t.string().default(''),
  revision: t.uint32().default(0),
}, 'RoomFogOperation');
export type RoomFogOperation = SchemaType<typeof RoomFogOperation>;

export const RoomFog = schema({
  version: t.uint8().default(1),
  mode: t.string().default('shared'),
  enabled: t.boolean().default(false),
  base: t.string().default('revealed'),
  operations: t.array(RoomFogOperation),
  revision: t.uint32().default(0),
}, 'RoomFog');
export type RoomFog = SchemaType<typeof RoomFog>;

export const RoomInitiativeEntry = schema({
  id: t.string(),
  tokenId: t.string(),
  label: t.string().default(''),
  score: t.float64().default(0),
  hidden: t.boolean().default(false),
}, 'RoomInitiativeEntry');
export type RoomInitiativeEntry = SchemaType<typeof RoomInitiativeEntry>;

export const RoomInitiative = schema({
  version: t.uint8().default(1),
  active: t.boolean().default(false),
  round: t.uint32().default(0),
  // Colyseus integer fields cannot carry null; -1 maps to the persisted null value.
  turnIndex: t.int32().default(-1),
  entries: t.array(RoomInitiativeEntry),
  revision: t.uint32().default(0),
}, 'RoomInitiative');
export type RoomInitiative = SchemaType<typeof RoomInitiative>;

export const RoomDrawing = schema({
  id: t.string(), kind: t.string(), points: t.array(RoomPoint), color: t.string(),
  width: t.float64(), fill: t.string().default(''), hidden: t.boolean().default(false), ownerId: t.string().default(''),
  z: t.float64().default(0), revision: t.uint32().default(0),
}, 'RoomDrawing');
export type RoomDrawing = SchemaType<typeof RoomDrawing>;

export const RoomStructure = schema({
  id: t.string(), kind: t.string().default('block'), position: RoomPoint, size: RoomSize, rotation: t.float64().default(0),
  label: t.string().default(''), z: t.float64().default(0), material: t.string().default('default'),
  baseElevation: t.float64().default(0), slabHeight: t.float64().default(1), revision: t.uint32().default(0),
}, 'RoomStructure');
export type RoomStructure = SchemaType<typeof RoomStructure>;

export const RoomLight = schema({
  id: t.string(), position: RoomPoint, radius: t.float64(), color: t.string(),
  intensity: t.float64(), enabled: t.boolean().default(true), revision: t.uint32().default(0),
}, 'RoomLight');
export type RoomLight = SchemaType<typeof RoomLight>;

export const RoomEffect = schema({
  id: t.string(), position: RoomPoint, radius: t.float64().default(0), label: t.string().default(''),
  duration: t.float64().default(0), z: t.float64().default(0), revision: t.uint32().default(0),
}, 'RoomEffect');
export type RoomEffect = SchemaType<typeof RoomEffect>;

export const RoomConnection = schema({
  userId: t.string(),
  displayName: t.string(),
  role: t.string(),
  connected: t.boolean().default(true),
}, 'RoomConnection');
export type RoomConnection = SchemaType<typeof RoomConnection>;

// Shared room state is deliberately presence-only. Canonical scene data is
// retained by the authoritative server engine and delivered via targeted
// actor projections, never through this schema.
export const RoomPresenceState = schema({
  protocolVersion: t.uint8().default(1),
  kind: t.string().default('presence'),
  connections: t.map(RoomConnection),
}, 'RoomPresenceState');
export type RoomPresenceState = SchemaType<typeof RoomPresenceState>;

export const RoomScene = schema({
  version: t.uint8().default(2),
  coordinateSystem: RoomCoordinateSystem,
  map: t.ref(RoomMap).optional(),
  grid: RoomGrid,
  permissions: RoomPermissions,
  navigationRevision: t.uint32().default(0),
  wallRevision: t.uint32().default(0),
  structureRevision: t.uint32().default(0),
  tokens: t.map(RoomToken),
  walls: t.map(RoomWall),
  fog: RoomFog,
  drawings: t.map(RoomDrawing),
  drawingRevision: t.uint32().default(0),
  structures: t.map(RoomStructure),
  lights: t.map(RoomLight),
  effects: t.map(RoomEffect),
  initiative: RoomInitiative,
  extensions: t.string().default('{}'),
  connections: t.map(RoomConnection),
}, 'RoomScene');
export type RoomScene = SchemaType<typeof RoomScene>;

const pointToRoom = (point: Point) => new RoomPoint(point);
const sizeToRoom = (size: { width: number; height: number }) => new RoomSize(size);

function tokenToRoom(token: TokenRecord): RoomToken {
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
  return new RoomToken({
    ...token,
    position: pointToRoom(token.position),
    size: sizeToRoom(token.size),
    movement: roomMovement,
  });
}

function wallToRoom(wall: WallRecord): RoomWall {
  const { openings, ...wallWithoutOpenings } = wall;
  const result = new RoomWall({
    ...wallWithoutOpenings,
    start: pointToRoom(wall.start),
    end: pointToRoom(wall.end),
    doorState: wall.type === 'door' ? wall.doorState : '',
  });
  result.openings.push(...openings.map((opening) => new RoomWallOpening(opening)));
  return result;
}

function fogOperationToRoom(operation: FogOperation): RoomFogOperation {
  const result = new RoomFogOperation({
    id: operation.id,
    kind: operation.kind,
    playerId: operation.playerId ?? '',
    revision: operation.revision,
  });
  result.points.push(...operation.points.map(pointToRoom));
  return result;
}

const initiativeEntryToRoom = (entry: InitiativeEntry) => new RoomInitiativeEntry(entry);

function drawingToRoom(drawing: DrawingRecord): RoomDrawing {
  const result = new RoomDrawing({
    id: drawing.id, kind: drawing.kind, color: drawing.color, width: drawing.width,
    fill: drawing.fill ?? '', hidden: drawing.hidden ?? false, ownerId: drawing.ownerId ?? '',
    z: drawing.z, revision: drawing.revision,
  });
  result.points.push(...drawing.points.map(pointToRoom));
  return result;
}

const structureToRoom = (value: StructureRecord) => new RoomStructure({
  ...value, position: pointToRoom(value.position), size: sizeToRoom(value.size),
});
const lightToRoom = (value: LightRecord) => new RoomLight({ ...value, position: pointToRoom(value.position) });
const effectToRoom = (value: EffectRecord) => new RoomEffect({ ...value, position: pointToRoom(value.position) });

function fillMap<T, U>(target: { set(key: string, value: U): unknown }, source: Record<string, T>, convert: (value: T) => U): void {
  for (const [key, value] of Object.entries(source)) target.set(key, convert(value));
}

export function sceneToRoomSchema(input: SceneV2): RoomScene {
  const scene = parseSceneV2(input);
  const result = new RoomScene({
    version: scene.version,
    coordinateSystem: new RoomCoordinateSystem(scene.coordinateSystem),
    map: scene.map ? new RoomMap(scene.map) : undefined,
    grid: new RoomGrid({ ...scene.grid, offset: pointToRoom(scene.grid.offset) }),
    permissions: new RoomPermissions(scene.permissions),
    drawingRevision: scene.drawingRevision ?? 0,
    navigationRevision: scene.navigationRevision ?? 0,
    wallRevision: scene.wallRevision ?? 0,
    structureRevision: scene.structureRevision ?? 0,
    fog: new RoomFog({
      version: scene.fog.version,
      mode: scene.fog.mode,
      enabled: scene.fog.enabled ?? false,
      base: scene.fog.base ?? 'revealed',
      revision: scene.fog.revision ?? 0,
    }),
    initiative: new RoomInitiative({
      version: scene.initiative.version,
      active: scene.initiative.active,
      round: scene.initiative.round,
      turnIndex: scene.initiative.turnIndex ?? -1,
      revision: scene.initiative.revision ?? 0,
    }),
    extensions: JSON.stringify(scene.extensions),
  });
  fillMap(result.tokens, scene.tokens, tokenToRoom);
  fillMap(result.walls, scene.walls, wallToRoom);
  result.fog.operations.push(...scene.fog.operations.map(fogOperationToRoom));
  result.initiative.entries.push(...scene.initiative.entries.map(initiativeEntryToRoom));
  fillMap(result.drawings, scene.drawings, drawingToRoom);
  fillMap(result.structures, scene.structures, structureToRoom);
  fillMap(result.lights, scene.lights, lightToRoom);
  fillMap(result.effects, scene.effects, effectToRoom);
  return result;
}

const roomPointToDto = (point: RoomPoint): Point => ({ x: point.x, y: point.y });

function mapToRecord<T, U extends { id: string }>(source: { forEach(callback: (value: T, key: string) => void): void }, convert: (value: T) => U): Record<string, U> {
  const result: Record<string, U> = {};
  source.forEach((value, key) => { result[key] = convert(value); });
  return result;
}

function roomWallToDto(wall: RoomWall): WallRecord {
  const base = {
    id: wall.id,
    start: roomPointToDto(wall.start),
    end: roomPointToDto(wall.end),
    height: wall.height,
    thickness: wall.thickness,
    elevation: wall.elevation,
    material: wall.material as WallMaterial,
    openings: Array.from(wall.openings, (opening): WallOpening => ({
      type: opening.type as 'window',
      start: opening.start,
      end: opening.end,
      bottom: opening.bottom,
      height: opening.height,
    })),
    revision: wall.revision,
  };
  if (wall.type === 'door') {
    return { ...base, type: 'door', doorState: wall.doorState as 'open' | 'closed' | 'locked' };
  }
  return { ...base, type: wall.type as 'blocking' | 'terrain' | 'ethereal' };
}

export function roomSchemaToScene(room: RoomScene): SceneV2 {
  let extensions: unknown;
  try {
    extensions = JSON.parse(room.extensions) as unknown;
  } catch (error) {
    throw new TypeError('Room scene extensions is not valid JSON.', { cause: error });
  }

  return parseSceneV2({
    version: room.version,
    coordinateSystem: {
      origin: room.coordinateSystem.origin,
      axes: room.coordinateSystem.axes,
      worldUnit: room.coordinateSystem.worldUnit,
    },
    map: room.map ? { assetId: room.map.assetId, width: room.map.width, height: room.map.height } : null,
    grid: {
      type: room.grid.type,
      visible: room.grid.visible,
      cellSize: room.grid.cellSize,
      offset: roomPointToDto(room.grid.offset),
      distancePerCell: room.grid.distancePerCell,
      unit: room.grid.unit,
      snap: room.grid.snap,
    },
    permissions: {
      playerMovement: room.permissions.playerMovement,
      playerDrawing: room.permissions.playerDrawing as 'none' | 'own' | 'all',
      playerPerspectiveView: room.permissions.playerPerspectiveView ?? false,
    },
    navigationRevision: room.navigationRevision,
    wallRevision: room.wallRevision,
    structureRevision: room.structureRevision,
    tokens: mapToRecord(room.tokens, (token) => ({
      id: token.id,
      assetId: token.assetId,
      position: roomPointToDto(token.position),
      size: { width: token.size.width, height: token.size.height },
      rotation: token.rotation,
      label: token.label,
      ownerId: token.ownerId,
      hpCurrent: token.hpCurrent,
      hpMaximum: token.hpMaximum,
      hpHidden: token.hpHidden,
      z: token.z,
      movement: {
        allowanceCells: token.movement.unlimited ? null : token.movement.allowanceCells,
        spentCells: token.movement.spentCells,
        activePath: Array.from(token.movement.activePath, (point) => ({ column: point.column, row: point.row })),
        pathCostCells: token.movement.pathCostCells,
        pathStartedAtServerMs: token.movement.pathStartedAtServerMs < 0 ? null : token.movement.pathStartedAtServerMs,
        millisecondsPerCell: token.movement.millisecondsPerCell,
        status: token.movement.status as 'idle' | 'moving' | 'interrupted',
        revision: token.movement.revision,
      },
      revision: token.revision,
    })),
    walls: mapToRecord(room.walls, roomWallToDto),
    fog: {
      version: room.fog.version,
      mode: room.fog.mode,
      enabled: room.fog.enabled,
      base: room.fog.base as 'revealed' | 'concealed',
      operations: Array.from(room.fog.operations, (operation) => ({
        id: operation.id,
        kind: operation.kind,
        points: Array.from(operation.points, roomPointToDto),
        playerId: operation.playerId || null,
        revision: operation.revision,
      })),
      revision: room.fog.revision,
    },
    initiative: {
      version: room.initiative.version,
      active: room.initiative.active,
      round: room.initiative.round,
      turnIndex: room.initiative.turnIndex === -1 ? null : room.initiative.turnIndex,
      entries: Array.from(room.initiative.entries, (entry) => ({
        id: entry.id, tokenId: entry.tokenId, label: entry.label, score: entry.score, hidden: entry.hidden,
      })),
      revision: room.initiative.revision,
    },
    drawings: mapToRecord(room.drawings, (drawing) => ({
      id: drawing.id, kind: drawing.kind as DrawingRecord['kind'],
      points: Array.from(drawing.points, roomPointToDto), color: drawing.color,
      width: drawing.width, fill: drawing.fill || null, hidden: drawing.hidden, ownerId: drawing.ownerId,
      z: drawing.z, revision: drawing.revision,
    })),
    drawingRevision: room.drawingRevision,
    structures: mapToRecord(room.structures, (value) => ({
      id: value.id, kind: value.kind as StructureRecord['kind'], position: roomPointToDto(value.position),
      size: { width: value.size.width, height: value.size.height }, rotation: value.rotation,
      label: value.label, z: value.z, material: value.material as StructureRecord['material'],
      baseElevation: value.baseElevation, slabHeight: value.slabHeight, revision: value.revision,
    })),
    lights: mapToRecord(room.lights, (value) => ({
      id: value.id, position: roomPointToDto(value.position), radius: value.radius,
      color: value.color, intensity: value.intensity, enabled: value.enabled, revision: value.revision,
    })),
    effects: mapToRecord(room.effects, (value) => ({
      id: value.id, position: roomPointToDto(value.position), radius: value.radius,
      label: value.label, duration: value.duration, z: value.z, revision: value.revision,
    })),
    extensions,
  });
}
