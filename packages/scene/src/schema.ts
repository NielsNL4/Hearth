import { z } from 'zod';
import type { JsonValue } from './types.js';

const finite = z.number().finite();
const nonNegativeInteger = z.number().int().min(0).max(0xffff_ffff);
const id = z.string().min(1);
export const wallIdSchema = z.string().min(1).max(128);
export const structureIdSchema = z.string().min(1).max(128);
const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() => z.union([
  z.null(), z.boolean(), finite, z.string(), z.array(jsonValueSchema), z.record(z.string(), jsonValueSchema),
]));

export const pointSchema = z.object({ x: finite, y: finite }).strict();
export const sizeSchema = z.object({ width: finite.positive(), height: finite.positive() }).strict();
export const gridPointSchema = z.object({ column: z.number().int(), row: z.number().int() }).strict();
export const tokenMovementStateSchema = z.object({
  allowanceCells: finite.nonnegative().nullable(),
  spentCells: finite.nonnegative(),
  activePath: z.array(gridPointSchema),
  pathCostCells: finite.nonnegative(),
  pathStartedAtServerMs: finite.nonnegative().nullable(),
  millisecondsPerCell: finite.positive(),
  status: z.enum(['idle', 'moving', 'interrupted']),
  revision: nonNegativeInteger,
}).strict();

export const sceneV1Schema = z.object({
  version: z.literal(1),
  grid: z.object({
    type: z.literal('square'),
    cellSize: finite.positive(),
    offset: pointSchema,
    distancePerCell: finite.positive(),
    unit: z.enum(['ft', 'm']),
  }).strict(),
  extensions: z.record(z.string(), jsonValueSchema),
}).strict();

export const tokenRecordSchema = z.object({
  id,
  assetId: id,
  position: pointSchema,
  size: sizeSchema,
  rotation: finite,
  label: z.string(),
  ownerId: z.string(),
  hpCurrent: finite.nonnegative(),
  hpMaximum: finite.nonnegative(),
  hpHidden: z.boolean(),
  z: finite,
  revision: nonNegativeInteger,
  movement: tokenMovementStateSchema.default(() => ({
    allowanceCells: null, spentCells: 0, activePath: [], pathCostCells: 0,
    pathStartedAtServerMs: null, millisecondsPerCell: 250, status: 'idle' as const, revision: 0,
  })),
}).strict();

export const wallMaterialSchema = z.enum(['default', 'masonry', 'wood', 'metal']);
export const wallOpeningSchema = z.object({
  type: z.literal('window'),
  start: finite.min(0).max(1),
  end: finite.min(0).max(1),
  bottom: finite.positive(),
  height: finite.positive(),
}).strict();
const wallOpeningsSchema = z.array(wallOpeningSchema).max(32).default(() => []);

const wallBase = {
  id: wallIdSchema,
  start: pointSchema,
  end: pointSchema,
  height: finite.nonnegative(),
  thickness: finite.positive(),
  elevation: finite,
  revision: nonNegativeInteger,
  material: wallMaterialSchema.default('default'),
  openings: wallOpeningsSchema,
};

const wallInputBase = {
  id: wallIdSchema,
  start: pointSchema,
  end: pointSchema,
  height: finite.nonnegative(),
  thickness: finite.positive(),
  elevation: finite,
  material: wallMaterialSchema.default('default'),
  openings: wallOpeningsSchema,
};

const validateWall = (wall: {
  type: 'blocking' | 'terrain' | 'ethereal' | 'door';
  start: { x: number; y: number };
  end: { x: number; y: number };
  height: number;
  openings: Array<{ start: number; end: number; bottom: number; height: number }>;
}, context: z.RefinementCtx): void => {
  if (wall.start.x === wall.end.x && wall.start.y === wall.end.y) {
    context.addIssue({ code: 'custom', path: ['end'], message: 'Wall segments must have length.' });
  }
  if (wall.type === 'door' && wall.openings.length) {
    context.addIssue({ code: 'custom', path: ['openings'], message: 'Door walls cannot contain window openings.' });
  }
  let previousEnd = 0;
  wall.openings.forEach((opening, index) => {
    if (opening.start >= opening.end) {
      context.addIssue({ code: 'custom', path: ['openings', index], message: 'Opening start must be before opening end.' });
    }
    if (index > 0 && opening.start < previousEnd) {
      context.addIssue({ code: 'custom', path: ['openings', index], message: 'Wall openings must be sorted and non-overlapping.' });
    }
    if (opening.bottom + opening.height > wall.height) {
      context.addIssue({ code: 'custom', path: ['openings', index, 'height'], message: 'Opening must fit within the wall height.' });
    }
    previousEnd = opening.end;
  });
};

export const wallRecordSchema = z.discriminatedUnion('type', [
  z.object({ ...wallBase, type: z.literal('blocking') }).strict(),
  z.object({ ...wallBase, type: z.literal('terrain') }).strict(),
  z.object({ ...wallBase, type: z.literal('ethereal') }).strict(),
  z.object({ ...wallBase, type: z.literal('door'), doorState: z.enum(['open', 'closed', 'locked']) }).strict(),
]).superRefine(validateWall);

export const wallRecordInputSchema = z.discriminatedUnion('type', [
  z.object({ ...wallInputBase, type: z.literal('blocking') }).strict(),
  z.object({ ...wallInputBase, type: z.literal('terrain') }).strict(),
  z.object({ ...wallInputBase, type: z.literal('ethereal') }).strict(),
  z.object({ ...wallInputBase, type: z.literal('door'), doorState: z.enum(['open', 'closed', 'locked']) }).strict(),
]).superRefine(validateWall);

export const fogOperationSchema = z.object({
  id,
  kind: z.enum(['reveal', 'conceal']),
  points: z.array(pointSchema).min(3),
  playerId: id.nullable(),
  revision: nonNegativeInteger,
}).strict();

export const initiativeEntrySchema = z.object({
  id,
  tokenId: id,
  label: z.string(),
  score: finite,
  hidden: z.boolean(),
}).strict();

export const drawingRecordSchema = z.object({
  id,
  kind: z.enum(['line', 'polygon']),
  points: z.array(pointSchema).min(2),
  color: z.string().min(1),
  width: finite.positive(),
  fill: z.string().min(1).nullable().default(null),
  hidden: z.boolean().default(false),
  ownerId: z.string().default(''),
  z: finite,
  revision: nonNegativeInteger,
}).strict().superRefine((drawing, context) => {
  if (drawing.kind === 'polygon' && drawing.points.length < 3) {
    context.addIssue({ code: 'custom', path: ['points'], message: 'Polygon drawings require at least three points.' });
  }
});

const structurePersistedBase = {
  id: structureIdSchema,
  position: pointSchema,
  size: sizeSchema,
  rotation: finite,
  label: z.string(),
  z: finite,
  material: wallMaterialSchema.default('default'),
  baseElevation: finite.default(0),
  slabHeight: finite.positive().default(1),
  revision: nonNegativeInteger,
};
const { revision: _structureRevision, ...structureInputBase } = structurePersistedBase;

const structureUnion = (base: Record<string, z.ZodTypeAny>) => z.discriminatedUnion('kind', [
  z.object({ ...base, kind: z.literal('block') }).strict(),
  z.object({ ...base, kind: z.literal('floor') }).strict(),
  z.object({ ...base, kind: z.literal('roof') }).strict(),
]);
const normalizeLegacyStructure = (value: unknown): unknown => {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || 'kind' in value) return value;
  return { kind: 'block', ...value };
};

export const structureRecordSchema = z.preprocess(normalizeLegacyStructure, structureUnion(structurePersistedBase));
export const structureRecordInputSchema = z.preprocess(normalizeLegacyStructure, structureUnion(structureInputBase));

export const lightRecordSchema = z.object({
  id,
  position: pointSchema,
  radius: finite.positive(),
  color: z.string().min(1),
  intensity: finite.nonnegative(),
  enabled: z.boolean(),
  revision: nonNegativeInteger,
}).strict();

export const effectRecordSchema = z.object({
  id,
  position: pointSchema,
  radius: finite.nonnegative(),
  label: z.string(),
  duration: finite.nonnegative(),
  z: finite,
  revision: nonNegativeInteger,
}).strict();

const keyed = <T extends z.ZodTypeAny>(value: T) => z.record(z.string().min(1), value)
  .superRefine((records, context) => {
    for (const [key, record] of Object.entries(records)) {
      if ((record as { id: string }).id !== key) {
        context.addIssue({ code: 'custom', path: [key, 'id'], message: 'Record id must match its key.' });
      }
    }
  });

export const sceneV2Schema = z.object({
  version: z.literal(2),
  coordinateSystem: z.object({
    origin: z.literal('top-left'),
    axes: z.literal('x-right-y-down'),
    worldUnit: z.literal('map-pixel'),
  }).strict(),
  map: z.object({
    assetId: id,
    width: finite.positive(),
    height: finite.positive(),
  }).strict().nullable(),
  grid: z.object({
    type: z.literal('square'),
    visible: z.boolean(),
    cellSize: finite.positive(),
    offset: pointSchema,
    distancePerCell: finite.positive(),
    unit: z.enum(['ft', 'm']),
    snap: z.boolean(),
  }).strict(),
  permissions: z.object({
    playerMovement: z.enum(['owned', 'all']),
    playerDrawing: z.enum(['none', 'own', 'all']).default('own'),
    playerPerspectiveView: z.boolean().default(false),
  }).strict(),
  navigationRevision: nonNegativeInteger.default(0),
  wallRevision: nonNegativeInteger.default(0),
  tokens: keyed(tokenRecordSchema),
  walls: keyed(wallRecordSchema),
  fog: z.object({
    version: z.literal(1),
    mode: z.enum(['shared', 'per-player']),
    enabled: z.boolean().default(false),
    base: z.enum(['revealed', 'concealed']).default('revealed'),
    operations: z.array(fogOperationSchema),
    revision: nonNegativeInteger.default(0),
  }).strict(),
  initiative: z.object({
    version: z.literal(1),
    active: z.boolean(),
    round: nonNegativeInteger,
    turnIndex: nonNegativeInteger.nullable(),
    entries: z.array(initiativeEntrySchema),
    revision: nonNegativeInteger.default(0),
  }).strict(),
  drawings: keyed(drawingRecordSchema),
  drawingRevision: nonNegativeInteger.default(0),
  structures: keyed(structureRecordSchema),
  structureRevision: nonNegativeInteger.default(0),
  lights: keyed(lightRecordSchema),
  effects: keyed(effectRecordSchema),
  extensions: z.record(z.string(), jsonValueSchema),
}).strict().superRefine((scene, context) => {
  if (scene.initiative.turnIndex !== null && scene.initiative.turnIndex >= scene.initiative.entries.length) {
    context.addIssue({ code: 'custom', path: ['initiative', 'turnIndex'], message: 'Turn index is outside the initiative entries.' });
  }
});
