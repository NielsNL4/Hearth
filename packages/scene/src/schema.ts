import { z } from 'zod';
import type { JsonValue } from './types.js';

const finite = z.number().finite();
const nonNegativeInteger = z.number().int().min(0).max(0xffff_ffff);
const id = z.string().min(1);
const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() => z.union([
  z.null(), z.boolean(), finite, z.string(), z.array(jsonValueSchema), z.record(z.string(), jsonValueSchema),
]));

export const pointSchema = z.object({ x: finite, y: finite }).strict();
export const sizeSchema = z.object({ width: finite.positive(), height: finite.positive() }).strict();

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
}).strict();

const wallBase = {
  id,
  start: pointSchema,
  end: pointSchema,
  height: finite.nonnegative(),
  thickness: finite.positive(),
  elevation: finite,
  revision: nonNegativeInteger,
};

export const wallRecordSchema = z.discriminatedUnion('type', [
  z.object({ ...wallBase, type: z.literal('blocking') }).strict(),
  z.object({ ...wallBase, type: z.literal('terrain') }).strict(),
  z.object({ ...wallBase, type: z.literal('ethereal') }).strict(),
  z.object({ ...wallBase, type: z.literal('door'), doorState: z.enum(['open', 'closed', 'locked']) }).strict(),
]);

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
  z: finite,
  revision: nonNegativeInteger,
}).strict();

export const structureRecordSchema = z.object({
  id,
  position: pointSchema,
  size: sizeSchema,
  rotation: finite,
  label: z.string(),
  z: finite,
  revision: nonNegativeInteger,
}).strict();

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
  }).strict(),
  tokens: keyed(tokenRecordSchema),
  walls: keyed(wallRecordSchema),
  fog: z.object({
    version: z.literal(1),
    mode: z.enum(['shared', 'per-player']),
    operations: z.array(fogOperationSchema),
  }).strict(),
  initiative: z.object({
    version: z.literal(1),
    active: z.boolean(),
    round: nonNegativeInteger,
    turnIndex: nonNegativeInteger.nullable(),
    entries: z.array(initiativeEntrySchema),
  }).strict(),
  drawings: keyed(drawingRecordSchema),
  structures: keyed(structureRecordSchema),
  lights: keyed(lightRecordSchema),
  effects: keyed(effectRecordSchema),
  extensions: z.record(z.string(), jsonValueSchema),
}).strict().superRefine((scene, context) => {
  if (scene.initiative.turnIndex !== null && scene.initiative.turnIndex >= scene.initiative.entries.length) {
    context.addIssue({ code: 'custom', path: ['initiative', 'turnIndex'], message: 'Turn index is outside the initiative entries.' });
  }
});
