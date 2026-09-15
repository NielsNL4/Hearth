import type { ActorProjectionV1 } from '@hearth/domain';

export type Point = { x: number; y: number };
export type ProjectionToken = ActorProjectionV1['scene']['tokens'][number];
export type ProjectionDrawing = ActorProjectionV1['scene']['drawings'][number];
export type ProjectionWall = NonNullable<ActorProjectionV1['controls']['geometry']['editableGeometry']>['walls'][number];
export type ProjectionStructure = NonNullable<ActorProjectionV1['controls']['geometry']['editableGeometry']>['structures'][number];

export interface TacticalProjectionModel {
  streamId: string; sceneRevision: number; projectionRevision: number;
  map: ActorProjectionV1['scene']['map']; grid: ActorProjectionV1['scene']['grid'];
  tokens: Record<string, ProjectionToken>; drawings: Record<string, ProjectionDrawing>;
  initiative: ActorProjectionV1['scene']['initiative'];
  fog: ActorProjectionV1['fog'];
  walls: Record<string, ProjectionWall>; structures: Record<string, ProjectionStructure>;
  lights: ActorProjectionV1['lights']; wallMesh: ActorProjectionV1['wallMesh'];
  sight: ActorProjectionV1['sight'];
  controls: ActorProjectionV1['controls'];
}

/** Fail closed when a projection is incomplete or carries any privacy layer. */
export function projectionIsRestricted(scene: Pick<TacticalProjectionModel, 'sight' | 'fog'> | null | undefined): boolean {
  const value = scene as { sight?: { mode?: unknown }; fog?: { mode?: unknown } } | null | undefined;
  return value?.sight?.mode !== 'unrestricted' || value?.fog?.mode !== 'disabled';
}

/** A presentation-only view model. No canonical record is accepted here. */
export function projectionToTacticalModel(projection: ActorProjectionV1): TacticalProjectionModel {
  const { scene, controls } = projection;
  const tokenControls = new Map(controls.tokens.records.map((record) => [record.tokenId, record]));
  const tokens = Object.fromEntries(scene.tokens.map((token) => {
    const control = tokenControls.get(token.id);
    return [token.id, token];
  }));
  const drawings = Object.fromEntries(scene.drawings.map((drawing) => {
    const control = controls.drawings.records.find((record) => record.drawingId === drawing.id);
    return [drawing.id, drawing];
  }));
  const editable = controls.geometry.editableGeometry;
  const walls = Object.fromEntries((editable?.walls ?? []).map((wall) => [wall.wallId, wall]));
  const structures = Object.fromEntries((editable?.structures ?? []).map((structure) => [structure.structureId, structure]));
  return {
    streamId: projection.streamId, sceneRevision: projection.sceneRevision, projectionRevision: projection.projectionRevision,
    map: scene.map, grid: scene.grid, tokens, drawings,
    initiative: scene.initiative, fog: projection.fog,
    walls, structures,
    lights: projection.lights, wallMesh: projection.wallMesh, sight: projection.sight, controls,
  };
}

export function emptyTacticalProjectionModel(): TacticalProjectionModel {
  return { streamId: '', sceneRevision: 0, projectionRevision: 0, map: null, grid: { type: 'square', visible: false, cellSize: 50, offset: { x: 0, y: 0 }, distancePerCell: 5, unit: 'ft', snap: true }, tokens: {}, drawings: {}, initiative: { active: false, round: 0, turnIndex: null, entries: [] }, fog: { mode: 'disabled' }, walls: {}, structures: {}, lights: [], wallMesh: { segments: [] }, sight: { mode: 'unrestricted' }, controls: { movement: { canMove: false, canSetPolicy: false, policy: 'owned', expectedNavigationRevision: 0 }, tokens: { canCreate: false, records: [] }, drawings: { canCreate: false, canSetPolicy: false, policy: 'none', expectedDrawingRevision: 0, records: [] }, initiative: { canAdd: false, canReorder: false, canStart: false, canAdvance: false, canStop: false, expectedInitiativeRevision: 0, records: [] }, fog: { canCommit: false, canUndo: false, canClear: false, expectedFogRevision: 0, latestOperationId: null }, geometry: { canCreateWall: false, canUpdateWall: false, canDeleteWall: false, canCreateStructure: false, canUpdateStructure: false, canDeleteStructure: false, expectedWallRevision: 0, expectedStructureRevision: 0 }, perspective: { canUse: false, canSet: false, enabled: false } } };
}
