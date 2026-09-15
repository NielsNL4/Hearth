import { z } from 'zod';

/**
 * Projection values deliberately have their own vocabulary. These schemas do
 * not reuse SceneV2 records: a projection is a presentation boundary, not a
 * second canonical state container.
 */
const MAX_ID_LENGTH = 128;
const MAX_STRING_LENGTH = 256;
const MAX_COORDINATE = 1_000_000;
const MAX_DIMENSION = 1_000_000;
const MAX_TOKEN_RECORDS = 512;
const MAX_DRAWING_RECORDS = 512;
const MAX_INITIATIVE_ENTRIES = 512;
const MAX_LIGHT_RECORDS = 512;
const MAX_SIGHT_POLYGONS = 128;
const MAX_FOG_POLYGONS = 128;
const MAX_WALL_MESH_SEGMENTS = 512;
const MAX_EDITABLE_WALLS = 512;
const MAX_EDITABLE_STRUCTURES = 512;
const MAX_CONTROLLABLE_TOKENS = 512;
const MAX_DRAWING_POINTS = 512;
const MAX_POLYGON_POINTS = 512;
const MAX_WALL_OPENINGS_PER_SEGMENT = 16;
const MAX_REVISION = 0xffff_ffff;

/** Whole-message limits, including optional DM editor data. */
export const PROJECTION_BUDGETS = {
  maxTotalRecords: 2_048,
  maxPolygonPoints: 16_384,
  maxStringPayload: 128_000,
  maxWallOpenings: 1_024,
  maxWallSegments: 512,
} as const;

/** Purpose-specific parser limits run before whole-message budget checks. */
export const PROJECTION_LIMITS = {
  maxTokenRecords: MAX_TOKEN_RECORDS,
  maxDrawingRecords: MAX_DRAWING_RECORDS,
  maxInitiativeEntries: MAX_INITIATIVE_ENTRIES,
  maxLightRecords: MAX_LIGHT_RECORDS,
  maxSightPolygons: MAX_SIGHT_POLYGONS,
  maxFogPolygons: MAX_FOG_POLYGONS,
  maxWallMeshSegments: MAX_WALL_MESH_SEGMENTS,
  maxEditableWalls: MAX_EDITABLE_WALLS,
  maxEditableStructures: MAX_EDITABLE_STRUCTURES,
  maxControllableTokens: MAX_CONTROLLABLE_TOKENS,
  maxDrawingPoints: MAX_DRAWING_POINTS,
  maxPolygonPoints: MAX_POLYGON_POINTS,
  maxWallOpeningsPerSegment: MAX_WALL_OPENINGS_PER_SEGMENT,
} as const;

const id = z.string().min(1).max(MAX_ID_LENGTH);
const finite = z.number().finite().min(-MAX_COORDINATE).max(MAX_COORDINATE);
const positive = finite.positive();
const dimension = z.number().finite().positive().max(MAX_DIMENSION);
const revision = z.number().int().min(0).max(MAX_REVISION);
const boundedText = z.string().max(MAX_STRING_LENGTH);

export const projectionPointSchema = z.object({ x: finite, y: finite }).strict();
export const projectionSizeSchema = z.object({ width: dimension, height: dimension }).strict();

// Point sequence order is presentation-significant. Winding/start
// canonicalization is intentionally deferred to geometry, not this wire DTO.
const polygonSchema = z.object({
  points: z.array(projectionPointSchema).min(3).max(MAX_POLYGON_POINTS),
}).strict();

const mapPresentationSchema = z.object({
  assetId: id,
  width: dimension,
  height: dimension,
}).strict();

const gridPresentationSchema = z.object({
  type: z.literal('square'),
  visible: z.boolean(),
  cellSize: dimension,
  offset: projectionPointSchema,
  distancePerCell: dimension,
  unit: z.enum(['ft', 'm']),
  snap: z.boolean(),
}).strict();

export const presentedHpV1Schema = z.object({
  current: finite.nonnegative(),
  maximum: finite.nonnegative(),
}).strict().superRefine((hp, context) => {
  if (hp.current > hp.maximum) {
    context.addIssue({ code: 'custom', path: ['current'], message: 'Current HP cannot exceed maximum HP.' });
  }
});

export const presentedTokenV1Schema = z.object({
  id,
  assetId: id,
  position: projectionPointSchema,
  size: projectionSizeSchema,
  rotation: finite,
  label: boundedText,
  z: finite,
  hp: presentedHpV1Schema.optional(),
}).strict();

const visibleDrawingSchema = z.object({
  id,
  kind: z.enum(['line', 'polygon']),
  points: z.array(projectionPointSchema).min(2).max(MAX_DRAWING_POINTS),
  color: z.string().min(1).max(64),
  width: positive,
  fill: z.string().min(1).max(64).nullable(),
  z: finite,
}).strict().superRefine((drawing, context) => {
  if (drawing.kind === 'polygon' && drawing.points.length < 3) {
    context.addIssue({ code: 'custom', path: ['points'], message: 'Polygon drawings require at least three points.' });
  }
});

// Hidden drawings are absent. There is intentionally no hidden drawing
// placeholder because even its canonical ID would disclose private state.
export const presentedDrawingV1Schema = visibleDrawingSchema;

const visibleInitiativeEntrySchema = z.object({
  id,
  tokenId: id,
  label: boundedText,
  score: finite,
}).strict();

// Anonymous slots preserve presentation shape without leaking canonical IDs.
const hiddenInitiativePlaceholderSchema = z.object({
  placeholder: z.literal(true),
}).strict();

export const presentedInitiativeEntryV1Schema = z.union([
  visibleInitiativeEntrySchema,
  hiddenInitiativePlaceholderSchema,
]);

const presentedInitiativeSchema = z.object({
  active: z.boolean(),
  round: revision,
  turnIndex: revision.nullable(),
  entries: z.array(presentedInitiativeEntryV1Schema).max(MAX_INITIATIVE_ENTRIES),
}).strict().superRefine((initiative, context) => {
  if (initiative.turnIndex !== null && initiative.turnIndex >= initiative.entries.length) {
    context.addIssue({ code: 'custom', path: ['turnIndex'], message: 'Turn index is outside the presented entries.' });
  }
});

/** The redacted scene portion contains no canonical version, permissions, or revisions. */
export const presentedSceneV1Schema = z.object({
  map: mapPresentationSchema.nullable(),
  grid: gridPresentationSchema,
  tokens: z.array(presentedTokenV1Schema).max(MAX_TOKEN_RECORDS),
  drawings: z.array(presentedDrawingV1Schema).max(MAX_DRAWING_RECORDS),
  initiative: presentedInitiativeSchema,
}).strict();

const wallMeshOpeningSchema = z.object({
  start: z.number().finite().min(0).max(1),
  end: z.number().finite().min(0).max(1),
  bottom: positive,
  height: positive,
}).strict();

const wallMeshSegmentSchema = z.object({
  // This is a stable derived mesh ID, not a canonical wall record.
  id,
  start: projectionPointSchema,
  end: projectionPointSchema,
  height: finite.nonnegative(),
  thickness: positive,
  elevation: finite,
  material: z.enum(['default', 'masonry', 'wood', 'metal']),
  openings: z.array(wallMeshOpeningSchema).max(MAX_WALL_OPENINGS_PER_SEGMENT),
}).strict().superRefine((segment, context) => {
  if (segment.start.x === segment.end.x && segment.start.y === segment.end.y) {
    context.addIssue({ code: 'custom', path: ['end'], message: 'Mesh segments must have length.' });
  }
  let previousEnd = 0;
  segment.openings.forEach((opening, index) => {
    if (opening.start >= opening.end) {
      context.addIssue({ code: 'custom', path: ['openings', index, 'end'], message: 'Mesh opening start must be before end.' });
    }
    if (index > 0 && opening.start < previousEnd) {
      context.addIssue({ code: 'custom', path: ['openings', index, 'start'], message: 'Mesh openings must be sorted and non-overlapping.' });
    }
    if (opening.bottom + opening.height > segment.height) {
      context.addIssue({ code: 'custom', path: ['openings', index, 'height'], message: 'Mesh opening must fit within the segment height.' });
    }
    previousEnd = opening.end;
  });
});

export const projectionWallMeshV1Schema = z.object({
  segments: z.array(wallMeshSegmentSchema).max(MAX_WALL_MESH_SEGMENTS),
}).strict();

export const projectionLightInputV1Schema = z.object({
  id,
  position: projectionPointSchema,
  radius: positive,
  color: z.string().min(1).max(64),
  intensity: finite.nonnegative(),
  enabled: z.boolean(),
}).strict();

export const projectionSightV1Schema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('unrestricted') }).strict(),
  z.object({ mode: z.literal('restricted'), polygons: z.array(polygonSchema).max(MAX_SIGHT_POLYGONS) }).strict(),
]);

export const projectionFogV1Schema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('disabled') }).strict(),
  z.object({ mode: z.literal('visible-regions'), polygons: z.array(polygonSchema).max(MAX_FOG_POLYGONS) }).strict(),
  z.object({ mode: z.literal('concealed-regions'), polygons: z.array(polygonSchema).max(MAX_FOG_POLYGONS) }).strict(),
]);

const editableOpeningSchema = z.object({
  start: z.number().finite().min(0).max(1),
  end: z.number().finite().min(0).max(1),
  bottom: positive,
  height: positive,
}).strict();

const editableWallBase = {
  wallId: id,
  start: projectionPointSchema,
  end: projectionPointSchema,
  height: finite.nonnegative(),
  thickness: positive,
  elevation: finite,
  material: z.enum(['default', 'masonry', 'wood', 'metal']),
  openings: z.array(editableOpeningSchema).max(MAX_WALL_OPENINGS_PER_SEGMENT),
  recordRevision: revision,
};
const editableWallSchema = z.discriminatedUnion('wallKind', [
  z.object({ ...editableWallBase, wallKind: z.literal('blocking') }).strict(),
  z.object({ ...editableWallBase, wallKind: z.literal('terrain') }).strict(),
  z.object({ ...editableWallBase, wallKind: z.literal('ethereal') }).strict(),
  z.object({ ...editableWallBase, wallKind: z.literal('door'), doorState: z.enum(['open', 'closed', 'locked']) }).strict(),
]).superRefine((wall, context) => {
  if (wall.start.x === wall.end.x && wall.start.y === wall.end.y) {
    context.addIssue({ code: 'custom', path: ['end'], message: 'Editable walls must have length.' });
  }
  if (wall.wallKind === 'door' && wall.openings.length > 0) {
    context.addIssue({ code: 'custom', path: ['openings'], message: 'Editable door walls cannot contain window openings.' });
  }
  let previousEnd = 0;
  wall.openings.forEach((opening, index) => {
    if (opening.start >= opening.end) {
      context.addIssue({ code: 'custom', path: ['openings', index, 'end'], message: 'Editable opening start must be before end.' });
    }
    if (index > 0 && opening.start < previousEnd) {
      context.addIssue({ code: 'custom', path: ['openings', index, 'start'], message: 'Editable openings must be sorted and non-overlapping.' });
    }
    if (opening.bottom + opening.height > wall.height) {
      context.addIssue({ code: 'custom', path: ['openings', index, 'height'], message: 'Editable opening must fit within the wall height.' });
    }
    previousEnd = opening.end;
  });
});

const editableStructureSchema = z.object({
  structureId: id,
  structureKind: z.enum(['block', 'floor', 'roof']),
  position: projectionPointSchema,
  size: projectionSizeSchema,
  rotation: finite,
  label: boundedText,
  z: finite,
  material: z.enum(['default', 'masonry', 'wood', 'metal']),
  baseElevation: finite,
  slabHeight: positive,
  recordRevision: revision,
}).strict();

/** Optional DM/editor-only data, explicitly projected and never a SceneV2 value. */
export const editableGeometryProjectionV1Schema = z.object({
  walls: z.array(editableWallSchema).max(MAX_EDITABLE_WALLS),
  structures: z.array(editableStructureSchema).max(MAX_EDITABLE_STRUCTURES),
}).strict();

const tokenControlSchema = z.object({
  canCreate: z.boolean(),
  records: z.array(z.object({
    tokenId: id,
    canTransform: z.boolean(),
    canUpdateDetails: z.boolean(),
    canDelete: z.boolean(),
    expectedTokenRevision: revision,
    expectedMovementRevision: revision,
  }).strict()).max(MAX_CONTROLLABLE_TOKENS),
}).strict();

const movementControlSchema = z.object({
  canMove: z.boolean(),
  canSetPolicy: z.boolean(),
  policy: z.enum(['owned', 'all']),
  expectedNavigationRevision: revision,
}).strict();

const drawingControlSchema = z.object({
  canCreate: z.boolean(),
  canSetPolicy: z.boolean(),
  policy: z.enum(['none', 'own', 'all']),
  expectedDrawingRevision: revision,
  records: z.array(z.object({
    drawingId: id,
    canUpdate: z.boolean(),
    canDelete: z.boolean(),
    expectedRecordRevision: revision,
  }).strict()).max(MAX_DRAWING_RECORDS),
}).strict();

const initiativeControlSchema = z.object({
  canAdd: z.boolean(),
  canReorder: z.boolean(),
  canStart: z.boolean(),
  canAdvance: z.boolean(),
  canStop: z.boolean(),
  expectedInitiativeRevision: revision,
  records: z.array(z.object({
    entryId: id,
    canUpdate: z.boolean(),
    canRemove: z.boolean(),
  }).strict()).max(MAX_INITIATIVE_ENTRIES),
}).strict();

const fogControlSchema = z.object({
  canCommit: z.boolean(),
  canUndo: z.boolean(),
  canClear: z.boolean(),
  expectedFogRevision: revision,
  latestOperationId: id.nullable(),
}).strict();

const geometryControlSchema = z.object({
  canCreateWall: z.boolean(),
  canUpdateWall: z.boolean(),
  canDeleteWall: z.boolean(),
  canCreateStructure: z.boolean(),
  canUpdateStructure: z.boolean(),
  canDeleteStructure: z.boolean(),
  expectedWallRevision: revision,
  expectedStructureRevision: revision,
  editableGeometry: editableGeometryProjectionV1Schema.optional(),
}).strict().superRefine((geometry, context) => {
  const hasEditorAction = geometry.canCreateWall || geometry.canUpdateWall || geometry.canDeleteWall ||
    geometry.canCreateStructure || geometry.canUpdateStructure || geometry.canDeleteStructure;
  if (geometry.editableGeometry && !hasEditorAction) {
    context.addIssue({ code: 'custom', path: ['editableGeometry'], message: 'Editable geometry requires an editor action capability.' });
  }
});

const perspectiveControlSchema = z.object({
  canUse: z.boolean(),
  canSet: z.boolean(),
  enabled: z.boolean(),
}).strict();

export const projectionControlsV1Schema = z.object({
  movement: movementControlSchema,
  tokens: tokenControlSchema,
  drawings: drawingControlSchema,
  initiative: initiativeControlSchema,
  fog: fogControlSchema,
  geometry: geometryControlSchema,
  perspective: perspectiveControlSchema,
}).strict();

/** Opaque stream/epoch metadata used to validate projection ordering. */
export const projectionStreamMetadataSchema = z.object({
  streamId: id,
  sceneRevision: revision,
  projectionRevision: revision,
}).strict();

export const projectionStreamResetSchema = z.object({
  kind: z.literal('initial'),
}).strict();

const projectionShapeSchema = z.object({
  protocolVersion: z.literal(1),
  kind: z.literal('full'),
  streamId: id,
  sceneRevision: revision,
  projectionRevision: revision,
  streamReset: projectionStreamResetSchema.optional(),
  scene: presentedSceneV1Schema,
  sight: projectionSightV1Schema,
  fog: projectionFogV1Schema,
  wallMesh: projectionWallMeshV1Schema,
  lights: z.array(projectionLightInputV1Schema).max(MAX_LIGHT_RECORDS),
  controls: projectionControlsV1Schema,
}).strict();

const collectStrings = (value: unknown): number => {
  if (typeof value === 'string') return value.length;
  if (Array.isArray(value)) return value.reduce((total, item) => total + collectStrings(item), 0);
  if (typeof value === 'object' && value !== null) {
    return Object.values(value).reduce((total, item) => total + collectStrings(item), 0);
  }
  return 0;
};

const compareNumber = (left: number, right: number): number => left < right ? -1 : left > right ? 1 : 0;
const compareString = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;
const compareIds = (left: { id: string }, right: { id: string }): number => compareString(left.id, right.id);

const comparePoints = (left: Array<{ x: number; y: number }>, right: Array<{ x: number; y: number }>): number => {
  const lengthResult = compareNumber(left.length, right.length);
  if (lengthResult) return lengthResult;
  for (let index = 0; index < left.length; index += 1) {
    const leftPoint = left[index]!;
    const rightPoint = right[index]!;
    const xResult = compareNumber(leftPoint.x, rightPoint.x);
    if (xResult) return xResult;
    const yResult = compareNumber(leftPoint.y, rightPoint.y);
    if (yResult) return yResult;
  }
  return 0;
};

const comparePolygons = (left: { points: Array<{ x: number; y: number }> }, right: { points: Array<{ x: number; y: number }> }): number =>
  comparePoints(left.points, right.points);

const compareSegments = (left: { id: string }, right: { id: string }): number => compareString(left.id, right.id);
const compareTokenRecords = (left: { tokenId: string }, right: { tokenId: string }): number => compareString(left.tokenId, right.tokenId);
const compareDrawingRecords = (left: { drawingId: string }, right: { drawingId: string }): number => compareString(left.drawingId, right.drawingId);

const uniqueIds = (items: Array<{ id: string }>, path: Array<string | number>, context: z.RefinementCtx): void => {
  const seen = new Set<string>();
  items.forEach((item, index) => {
    if (seen.has(item.id)) context.addIssue({ code: 'custom', path: [...path, index, 'id'], message: 'Collection IDs must be unique.' });
    seen.add(item.id);
  });
};

const validateAggregateBudget = (projection: z.infer<typeof projectionShapeSchema>, context: z.RefinementCtx): void => {
  const editable = projection.controls.geometry.editableGeometry;
  const polygons = [
    ...(projection.sight.mode === 'restricted' ? projection.sight.polygons : []),
    ...(projection.fog.mode === 'visible-regions' || projection.fog.mode === 'concealed-regions' ? projection.fog.polygons : []),
    ...projection.scene.drawings.map((drawing) => ({ points: drawing.points })),
  ];
  const polygonPoints = polygons.reduce((total, polygon) => total + polygon.points.length, 0);
  const allRecordCount = projection.scene.tokens.length + projection.scene.drawings.length +
    projection.scene.initiative.entries.length + projection.lights.length +
    (projection.sight.mode === 'restricted' ? projection.sight.polygons.length : 0) +
    (projection.fog.mode === 'visible-regions' || projection.fog.mode === 'concealed-regions' ? projection.fog.polygons.length : 0) +
    projection.wallMesh.segments.length + projection.controls.tokens.records.length +
    projection.controls.drawings.records.length + projection.controls.initiative.records.length +
    (editable?.walls.length ?? 0) + (editable?.structures.length ?? 0);
  const wallSegments = projection.wallMesh.segments.length + (editable?.walls.length ?? 0);
  const wallOpenings = projection.wallMesh.segments.reduce((total, segment) => total + segment.openings.length, 0) +
    (editable?.walls.reduce((total, wall) => total + wall.openings.length, 0) ?? 0);

  const checks: Array<[boolean, string]> = [
    [allRecordCount <= PROJECTION_BUDGETS.maxTotalRecords, 'Projection record budget exceeded.'],
    [polygonPoints <= PROJECTION_BUDGETS.maxPolygonPoints, 'Projection polygon-point budget exceeded.'],
    [collectStrings(projection) <= PROJECTION_BUDGETS.maxStringPayload, 'Projection string budget exceeded.'],
    [wallOpenings <= PROJECTION_BUDGETS.maxWallOpenings, 'Projection wall-opening budget exceeded.'],
    [wallSegments <= PROJECTION_BUDGETS.maxWallSegments, 'Projection wall-segment budget exceeded.'],
  ];
  checks.forEach(([valid, message]) => {
    if (!valid) context.addIssue({ code: 'custom', message });
  });
};

const actorProjectionV1Schema = projectionShapeSchema.superRefine((projection, context) => {
  if (projection.streamReset && projection.projectionRevision !== 0) {
    context.addIssue({ code: 'custom', path: ['projectionRevision'], message: 'A stream reset must start at projection revision 0.' });
  }
  uniqueIds(projection.scene.tokens, ['scene', 'tokens'], context);
  uniqueIds(projection.scene.drawings, ['scene', 'drawings'], context);
  uniqueIds(projection.lights, ['lights'], context);
  uniqueIds(projection.wallMesh.segments, ['wallMesh', 'segments'], context);
  uniqueIds(projection.controls.tokens.records.map(({ tokenId }) => ({ id: tokenId })), ['controls', 'tokens', 'records'], context);
  uniqueIds(projection.controls.drawings.records.map(({ drawingId }) => ({ id: drawingId })), ['controls', 'drawings', 'records'], context);
  uniqueIds(projection.controls.initiative.records.map(({ entryId }) => ({ id: entryId })), ['controls', 'initiative', 'records'], context);

  const visibleTokenIds = new Set(projection.scene.tokens.map(({ id: tokenId }) => tokenId));
  projection.controls.tokens.records.forEach((record, index) => {
    if (!visibleTokenIds.has(record.tokenId)) {
      context.addIssue({ code: 'custom', path: ['controls', 'tokens', 'records', index, 'tokenId'], message: 'Token control must reference a presented token.' });
    }
  });
  const visibleDrawingIds = new Set(projection.scene.drawings.map(({ id: drawingId }) => drawingId));
  projection.controls.drawings.records.forEach((record, index) => {
    if (!visibleDrawingIds.has(record.drawingId)) {
      context.addIssue({ code: 'custom', path: ['controls', 'drawings', 'records', index, 'drawingId'], message: 'Drawing control must reference a presented drawing.' });
    }
  });

  const editable = projection.controls.geometry.editableGeometry;
  if (editable) {
    uniqueIds(editable.walls.map(({ wallId }) => ({ id: wallId })), ['controls', 'editableGeometry', 'walls'], context);
    uniqueIds(editable.structures.map(({ structureId }) => ({ id: structureId })), ['controls', 'editableGeometry', 'structures'], context);
  }
  const visibleInitiative = projection.scene.initiative.entries
    .filter((entry) => 'id' in entry)
    .map((entry) => ({ id: entry.id }));
  uniqueIds(visibleInitiative, ['scene', 'initiative', 'entries'], context);
  const visibleInitiativeIds = new Set(visibleInitiative.map(({ id: entryId }) => entryId));
  projection.controls.initiative.records.forEach((record, index) => {
    if (!visibleInitiativeIds.has(record.entryId)) {
      context.addIssue({ code: 'custom', path: ['controls', 'initiative', 'records', index, 'entryId'], message: 'Initiative control must reference a visible presented entry.' });
    }
  });
  validateAggregateBudget(projection, context);
});

export { actorProjectionV1Schema };

export type PresentedHpV1 = z.infer<typeof presentedHpV1Schema>;
export type PresentedTokenV1 = z.infer<typeof presentedTokenV1Schema>;
export type PresentedDrawingV1 = z.infer<typeof presentedDrawingV1Schema>;
export type PresentedInitiativeEntryV1 = z.infer<typeof presentedInitiativeEntryV1Schema>;
export type PresentedSceneV1 = z.infer<typeof presentedSceneV1Schema>;
export type ProjectionWallMeshV1 = z.infer<typeof projectionWallMeshV1Schema>;
export type ProjectionLightInputV1 = z.infer<typeof projectionLightInputV1Schema>;
export type ProjectionSightV1 = z.infer<typeof projectionSightV1Schema>;
export type ProjectionFogV1 = z.infer<typeof projectionFogV1Schema>;
export type ProjectionControlsV1 = z.infer<typeof projectionControlsV1Schema>;
export type EditableGeometryProjectionV1 = z.infer<typeof editableGeometryProjectionV1Schema>;
export type ActorProjectionV1 = z.infer<typeof actorProjectionV1Schema>;
export type ProjectionStreamMetadata = z.infer<typeof projectionStreamMetadataSchema>;
export type ProjectionStreamReset = z.infer<typeof projectionStreamResetSchema>;

export type PresentedTokenSource = {
  id: string;
  assetId: string;
  position: { x: number; y: number };
  size: { width: number; height: number };
  rotation: number;
  label: string;
  z: number;
  hpCurrent?: number;
  hpMaximum?: number;
  hpHidden?: boolean;
  ownerId?: string;
  revision?: number;
};

export type PresentedInitiativeSource = {
  id: string;
  tokenId: string;
  label: string;
  score: number;
  hidden?: boolean;
};

export type PresentedDrawingSource = {
  id: string;
  kind: 'line' | 'polygon';
  points: Array<{ x: number; y: number }>;
  color: string;
  width: number;
  fill?: string | null;
  z: number;
  hidden?: boolean;
  ownerId?: string;
  revision?: number;
};

export type HiddenPlaceholderOptions = { includeHiddenPlaceholder?: boolean };

/** Create HP only when the caller explicitly supplies a presentation value. */
export function createPresentedHp(current: number, maximum: number): PresentedHpV1 {
  return presentedHpV1Schema.parse({ current, maximum });
}

/**
 * Copy only presenter-safe token fields. Canonical owner, revision, and hidden
 * HP flags are intentionally ignored; HP is absent unless explicitly supplied.
 */
export function createPresentedToken(source: PresentedTokenSource, hp?: PresentedHpV1): PresentedTokenV1 {
  return presentedTokenV1Schema.parse({
    id: source.id,
    assetId: source.assetId,
    position: source.position,
    size: source.size,
    rotation: source.rotation,
    label: source.label,
    z: source.z,
    ...(hp === undefined ? {} : { hp: createPresentedHp(hp.current, hp.maximum) }),
  });
}

export function redactPresentedToken(source: PresentedTokenSource): PresentedTokenV1 {
  return createPresentedToken(source);
}

export function createPresentedInitiativeEntry(
  source: PresentedInitiativeSource,
  options: HiddenPlaceholderOptions = {},
): PresentedInitiativeEntryV1 | null {
  if (source.hidden) {
    return options.includeHiddenPlaceholder ? { placeholder: true } : null;
  }
  return visibleInitiativeEntrySchema.parse({
    id: source.id,
    tokenId: source.tokenId,
    label: source.label,
    score: source.score,
  });
}

/** Hidden drawings are always omitted; no placeholder option can leak their ID. */
export function createPresentedDrawing(source: PresentedDrawingSource): PresentedDrawingV1 | null {
  if (source.hidden) return null;
  return visibleDrawingSchema.parse({
    id: source.id,
    kind: source.kind,
    points: source.points,
    color: source.color,
    width: source.width,
    fill: source.fill ?? null,
    z: source.z,
  });
}

const normalizeScene = (scene: PresentedSceneV1): PresentedSceneV1 => ({
  ...scene,
  tokens: [...scene.tokens].sort(compareIds),
  drawings: [...scene.drawings].sort(compareIds),
  initiative: {
    ...scene.initiative,
    // Initiative order is presentation-significant and must not be sorted.
    entries: [...scene.initiative.entries],
  },
});

const normalizeProjection = (projection: ActorProjectionV1): ActorProjectionV1 => ({
  ...projection,
  scene: normalizeScene(projection.scene),
  sight: projection.sight.mode === 'restricted'
    ? { ...projection.sight, polygons: [...projection.sight.polygons].sort(comparePolygons) }
    : projection.sight,
  fog: projection.fog.mode === 'disabled'
    ? projection.fog
    : { ...projection.fog, polygons: [...projection.fog.polygons].sort(comparePolygons) },
  wallMesh: { ...projection.wallMesh, segments: [...projection.wallMesh.segments].sort(compareSegments) },
  lights: [...projection.lights].sort(compareIds),
  controls: {
    ...projection.controls,
    tokens: {
      ...projection.controls.tokens,
      records: [...projection.controls.tokens.records].sort(compareTokenRecords),
    },
    drawings: {
      ...projection.controls.drawings,
      records: [...projection.controls.drawings.records].sort(compareDrawingRecords),
    },
    initiative: {
      ...projection.controls.initiative,
      records: [...projection.controls.initiative.records].sort((left, right) => compareString(left.entryId, right.entryId)),
    },
    geometry: {
      ...projection.controls.geometry,
      editableGeometry: projection.controls.geometry.editableGeometry ? {
        ...projection.controls.geometry.editableGeometry,
        walls: [...projection.controls.geometry.editableGeometry.walls].sort((left, right) => compareString(left.wallId, right.wallId)),
        structures: [...projection.controls.geometry.editableGeometry.structures].sort((left, right) => compareString(left.structureId, right.structureId)),
      } : undefined,
    },
  },
});

const validatePrevious = (current: ActorProjectionV1, previous: unknown): void => {
  if (previous === undefined) return;
  const prior = projectionStreamMetadataSchema.parse(previous);
  if (prior.streamId !== current.streamId) {
    if (!current.streamReset || current.projectionRevision !== 0) {
      throw new RangeError('A new projection stream requires an explicit initial reset at projection revision 0.');
    }
    return;
  }
  if (current.streamReset ||
      current.projectionRevision <= prior.projectionRevision || current.sceneRevision < prior.sceneRevision) {
    throw new RangeError('Projection revision must increase and scene revision must not regress within a stream.');
  }
};

/** Parse and normalize the public wire value, optionally against prior stream metadata. */
export function parseActorProjectionV1(input: unknown, previous?: unknown): ActorProjectionV1 {
  const parsed = actorProjectionV1Schema.parse(input);
  validatePrevious(parsed, previous);
  return normalizeProjection(parsed);
}

export function createActorProjectionV1(input: ActorProjectionV1, previous?: ProjectionStreamMetadata): ActorProjectionV1 {
  return parseActorProjectionV1(input, previous);
}

export const sceneProjectionV1Schema = actorProjectionV1Schema;
