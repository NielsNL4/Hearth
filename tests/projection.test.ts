import { describe, expect, it } from 'vitest';
import {
  actorProjectionV1Schema,
  createActorProjectionV1,
  createPresentedDrawing,
  createPresentedHp,
  createPresentedInitiativeEntry,
  createPresentedToken,
  parseActorProjectionV1,
  PROJECTION_BUDGETS,
  PROJECTION_LIMITS,
  type ActorProjectionV1,
} from '../packages/domain/src/index.js';

const point = (x = 0, y = 0) => ({ x, y });
const polygon = (offset = 0) => ({ points: [point(offset, 0), point(offset + 1, 0), point(offset + 1, 1)] });
const token = (id: string) => ({
  id, assetId: `${id}-asset`, position: point(), size: { width: 1, height: 1 }, rotation: 0, label: id, z: 0,
});
const drawing = (id: string) => ({
  id, kind: 'line' as const, points: [point(), point(1, 1)], color: '#fff', width: 1, fill: null, z: 0,
});
const meshSegment = (id: string) => ({
  id, start: point(), end: point(10, 0), height: 10, thickness: 1, elevation: 0, material: 'default' as const, openings: [],
});
const editableWall = (wallId: string) => ({
  wallId, wallKind: 'blocking' as const, start: point(), end: point(10, 0), height: 10, thickness: 1,
  elevation: 0, material: 'default' as const, openings: [], recordRevision: 2,
});
const editableStructure = (structureId: string) => ({
  structureId, structureKind: 'block' as const, position: point(), size: { width: 2, height: 2 }, rotation: 0,
  label: structureId, z: 0, material: 'default' as const, baseElevation: 0, slabHeight: 1, recordRevision: 2,
});

const projection = (overrides: Partial<ActorProjectionV1> = {}): ActorProjectionV1 => ({
  protocolVersion: 1,
  kind: 'full',
  streamId: 'opaque-stream-a',
  sceneRevision: 4,
  projectionRevision: 9,
  scene: {
    map: { assetId: 'map', width: 100, height: 100 },
    grid: { type: 'square', visible: true, cellSize: 10, offset: point(), distancePerCell: 5, unit: 'ft', snap: true },
    tokens: [],
    drawings: [],
    initiative: { active: false, round: 0, turnIndex: null, entries: [] },
  },
  sight: { mode: 'unrestricted' },
  fog: { mode: 'disabled' },
  wallMesh: { segments: [] },
  lights: [],
  controls: {
    movement: { canMove: true, canSetPolicy: false, policy: 'owned', expectedNavigationRevision: 2 },
    tokens: { canCreate: false, records: [] },
    drawings: { canCreate: true, canSetPolicy: false, policy: 'own', expectedDrawingRevision: 4, records: [] },
    initiative: { canAdd: true, canReorder: true, canStart: true, canAdvance: true, canStop: true, expectedInitiativeRevision: 5, records: [] },
    fog: { canCommit: true, canUndo: true, canClear: true, expectedFogRevision: 6, latestOperationId: null },
    geometry: { canCreateWall: false, canUpdateWall: false, canDeleteWall: false, canCreateStructure: false, canUpdateStructure: false, canDeleteStructure: false, expectedWallRevision: 7, expectedStructureRevision: 8 },
    perspective: { canUse: false, canSet: false, enabled: false },
  },
  ...overrides,
});

const parseRejects = (value: unknown, previous?: unknown): void => {
  expect(() => parseActorProjectionV1(value, previous)).toThrow();
};

describe('ActorProjectionV1 privacy boundary', () => {
  it('round-trips the versioned projection and preserves meaningful empty fail-closed states', () => {
    const restricted = projection({ sight: { mode: 'restricted', polygons: [] }, fog: { mode: 'visible-regions', polygons: [] } });
    const parsed = parseActorProjectionV1(restricted);
    expect(parsed).toEqual(restricted);
    expect(parsed.sight).toEqual({ mode: 'restricted', polygons: [] });
    expect(parsed.fog).toEqual({ mode: 'visible-regions', polygons: [] });
    expect(parseActorProjectionV1(projection()).sight).toEqual({ mode: 'unrestricted' });
    expect(parseActorProjectionV1(projection()).fog).toEqual({ mode: 'disabled' });
  });

  it.each([
    ['root extra', (value: ActorProjectionV1) => ({ ...value, extra: true })],
    ['scene extra', (value: ActorProjectionV1) => ({ ...value, scene: { ...value.scene, extra: true } })],
    ['grid extra', (value: ActorProjectionV1) => ({ ...value, scene: { ...value.scene, grid: { ...value.scene.grid, extra: true } } })],
    ['token extra', (value: ActorProjectionV1) => ({ ...value, scene: { ...value.scene, tokens: [ { ...token('hero'), extra: true } ] } })],
    ['sight mode extra', (value: ActorProjectionV1) => ({ ...value, sight: { mode: 'unrestricted', polygons: [] } })],
    ['wall mesh segment extra', (value: ActorProjectionV1) => ({ ...value, wallMesh: { segments: [{ ...meshSegment('mesh-a'), extra: true }] } })],
    ['light extra', (value: ActorProjectionV1) => ({ ...value, lights: [{ id: 'lamp', position: point(), radius: 1, color: '#fff', intensity: 1, enabled: true, extra: true }] })],
    ['controls extra', (value: ActorProjectionV1) => ({ ...value, controls: { ...value.controls, extra: true } })],
  ])('rejects unknown fields at the %s level', (_name, mutate) => {
    parseRejects(mutate(projection()));
  });

  it('rejects an actual SceneV2-shaped payload and canonical fog/player data', () => {
    const canonicalShape = {
      ...projection(),
      version: 2,
      coordinateSystem: { origin: 'top-left', axes: 'x-right-y-down', worldUnit: 'map-pixel' },
      permissions: { playerMovement: 'owned', playerDrawing: 'own', playerPerspectiveView: false },
      walls: {},
      structures: {},
      scene: { ...projection().scene, version: 2, walls: {}, structures: {}, fog: { version: 1, operations: [] } },
    };
    parseRejects(canonicalShape);
    parseRejects({ ...projection(), fog: { mode: 'visible-regions', polygons: [], playerId: 'private-player' } });
    parseRejects({ ...projection(), scene: { ...projection().scene, tokens: [{ ...token('hero'), ownerId: 'private-player' }] } });
  });

  it('redacts token HP/owner data and never preserves hidden canonical IDs', () => {
    const source = {
      ...token('hero'), ownerId: 'private-player', hpCurrent: 2, hpMaximum: 10, hpHidden: true,
    };
    expect(createPresentedToken(source)).toEqual(token('hero'));
    expect(createPresentedToken(source)).not.toHaveProperty('ownerId');
    expect(createPresentedToken(source)).not.toHaveProperty('hpCurrent');
    expect(createPresentedToken(source, createPresentedHp(2, 10))).toMatchObject({ hp: { current: 2, maximum: 10 } });

    const hiddenInitiative = { id: 'secret-entry', tokenId: 'secret-token', label: 'Secret', score: 20, hidden: true };
    const hiddenDrawing = { ...drawing('secret-drawing'), hidden: true, ownerId: 'private-player' };
    expect(createPresentedInitiativeEntry(hiddenInitiative)).toBeNull();
    expect(createPresentedInitiativeEntry(hiddenInitiative, { includeHiddenPlaceholder: true })).toEqual({ placeholder: true });
    expect(createPresentedDrawing(hiddenDrawing)).toBeNull();
    expect(createPresentedDrawing(hiddenDrawing)).not.toEqual(expect.objectContaining({ id: 'secret-drawing' }));
  });

  it('projects controls without leaking non-controllable token revisions and keeps DM geometry opt-in', () => {
    const player = parseActorProjectionV1(projection({ scene: { ...projection().scene, tokens: [token('hero'), token('npc')] }, controls: {
      ...projection().controls,
      tokens: { ...projection().controls.tokens, records: [
        { tokenId: 'hero', canTransform: true, canUpdateDetails: false, canDelete: true, expectedTokenRevision: 3, expectedMovementRevision: 4 },
        { tokenId: 'npc', canTransform: false, canUpdateDetails: true, canDelete: false, expectedTokenRevision: 8, expectedMovementRevision: 9 },
      ] },
    } }));
    expect(player.controls.geometry.editableGeometry).toBeUndefined();
    expect(player.controls.tokens.records).toEqual([
      { tokenId: 'hero', canTransform: true, canUpdateDetails: false, canDelete: true, expectedTokenRevision: 3, expectedMovementRevision: 4 },
      { tokenId: 'npc', canTransform: false, canUpdateDetails: true, canDelete: false, expectedTokenRevision: 8, expectedMovementRevision: 9 },
    ]);

    const dm = parseActorProjectionV1(projection({ controls: {
      ...projection().controls,
      geometry: {
        ...projection().controls.geometry,
        canCreateWall: true,
        canUpdateWall: true,
        editableGeometry: { walls: [editableWall('wall-a')], structures: [editableStructure('crate-a')] },
      },
    } }));
    expect(dm.controls.geometry.editableGeometry?.walls[0].wallId).toBe('wall-a');
    parseRejects(projection({ controls: {
      ...projection().controls,
      geometry: { ...projection().controls.geometry, editableGeometry: { walls: [], structures: [] } },
    } }));
  });

  it('uses action-specific command control shapes and rejects invented collection revisions', () => {
    const controls = projection().controls;
    expect(Object.keys(controls)).toEqual(['movement', 'tokens', 'drawings', 'initiative', 'fog', 'geometry', 'perspective']);
    expect(controls.movement).toMatchObject({ canMove: true, canSetPolicy: false, policy: 'owned', expectedNavigationRevision: 2 });
    expect(controls.tokens).toMatchObject({ canCreate: false, records: [] });
    expect(controls.drawings).toMatchObject({ canSetPolicy: false, policy: 'own', expectedDrawingRevision: 4, records: [] });
    expect(controls.initiative).toMatchObject({ canAdd: true, canReorder: true, canStart: true, canAdvance: true, canStop: true, records: [] });
    expect(controls.fog).toMatchObject({ canCommit: true, canUndo: true, canClear: true, expectedFogRevision: 6, latestOperationId: null });
    expect(controls.geometry).toMatchObject({ expectedWallRevision: 7, expectedStructureRevision: 8 });
    expect(controls.perspective).toEqual({ canUse: false, canSet: false, enabled: false });

    const looseControls = controls as unknown as Record<string, unknown>;
    parseRejects({ ...projection(), controls: { ...looseControls, expectedCollectionRevisions: {} } });
    parseRejects({ ...projection(), controls: { ...looseControls, movement: { ...controls.movement, expectedNavigationRevision: undefined } } });
    parseRejects({ ...projection(), controls: { ...looseControls, drawings: { ...controls.drawings, records: [{ drawingId: 'd', expectedRecordRevision: undefined }] } } });
    parseRejects({ ...projection(), controls: { ...looseControls, fog: { ...controls.fog, latestOperationId: 3 } } });
    parseRejects({ ...projection(), controls: { ...looseControls, geometry: { ...controls.geometry, editableGeometry: { walls: [], structures: [], wallRevision: 1 } } } });
  });

  it('keeps per-record permissions and exact command revisions tied to presented records', () => {
    const value = projection({
      scene: {
        ...projection().scene,
        tokens: [token('hero'), token('npc')],
        drawings: [drawing('map-note')],
        initiative: {
          active: true,
          round: 1,
          turnIndex: 0,
          entries: [
            { id: 'hero-turn', tokenId: 'hero', label: 'Hero', score: 18 },
            { id: 'npc-turn', tokenId: 'npc', label: 'NPC', score: 12 },
            { placeholder: true },
          ],
        },
      },
      controls: {
        ...projection().controls,
        tokens: { canCreate: false, records: [
          { tokenId: 'hero', canTransform: true, canUpdateDetails: false, canDelete: false, expectedTokenRevision: 11, expectedMovementRevision: 21 },
          { tokenId: 'npc', canTransform: false, canUpdateDetails: true, canDelete: true, expectedTokenRevision: 12, expectedMovementRevision: 22 },
        ] },
        drawings: { ...projection().controls.drawings, records: [{ drawingId: 'map-note', canUpdate: true, canDelete: false, expectedRecordRevision: 7 }] },
        initiative: { ...projection().controls.initiative, records: [
          { entryId: 'hero-turn', canUpdate: true, canRemove: false },
          { entryId: 'npc-turn', canUpdate: false, canRemove: true },
        ] },
      },
    });
    const parsed = parseActorProjectionV1(value);
    expect(parsed.controls.tokens.records).toEqual([
      { tokenId: 'hero', canTransform: true, canUpdateDetails: false, canDelete: false, expectedTokenRevision: 11, expectedMovementRevision: 21 },
      { tokenId: 'npc', canTransform: false, canUpdateDetails: true, canDelete: true, expectedTokenRevision: 12, expectedMovementRevision: 22 },
    ]);
    expect(parsed.controls.drawings.records).toEqual([{ drawingId: 'map-note', canUpdate: true, canDelete: false, expectedRecordRevision: 7 }]);
    expect(parsed.controls.initiative.records).toEqual([
      { entryId: 'hero-turn', canUpdate: true, canRemove: false },
      { entryId: 'npc-turn', canUpdate: false, canRemove: true },
    ]);

    parseRejects({ ...value, controls: { ...value.controls, tokens: { ...value.controls.tokens, records: [{ ...value.controls.tokens.records[0], tokenId: 'not-present' }] } } });
    parseRejects({ ...value, controls: { ...value.controls, drawings: { ...value.controls.drawings, records: [{ ...value.controls.drawings.records[0], drawingId: 'hidden-drawing' }] } } });
    parseRejects({ ...value, controls: { ...value.controls, initiative: { ...value.controls.initiative, records: [{ entryId: 'hidden-initiative', canUpdate: true, canRemove: true }] } } });
    parseRejects({ ...value, controls: { ...value.controls, tokens: { ...value.controls.tokens, records: [value.controls.tokens.records[0], value.controls.tokens.records[0]] } } });
    parseRejects({ ...value, controls: { ...value.controls, drawings: { ...value.controls.drawings, records: [value.controls.drawings.records[0], value.controls.drawings.records[0]] } } });
    parseRejects({ ...value, controls: { ...value.controls, initiative: { ...value.controls.initiative, records: [value.controls.initiative.records[0], value.controls.initiative.records[0]] } } });
  });

  it.each([
    ['editable wall has zero length', { ...editableWall('zero'), end: point() }],
    ['editable door has window openings', { ...editableWall('door'), wallKind: 'door' as const, doorState: 'closed' as const, openings: [{ start: .1, end: .2, bottom: 1, height: 1 }] }],
    ['editable wall openings overlap', { ...editableWall('overlap'), openings: [{ start: .1, end: .8, bottom: 1, height: 1 }, { start: .7, end: .9, bottom: 1, height: 1 }] }],
    ['editable wall opening exceeds height', { ...editableWall('height'), openings: [{ start: .1, end: .2, bottom: 9, height: 2 }] }],
  ])('rejects when %s', (_name, wall) => {
    parseRejects({ ...projection(), controls: { ...projection().controls, geometry: { ...projection().controls.geometry, canUpdateWall: true, editableGeometry: { walls: [wall], structures: [] } } } });
  });

  it('enforces purpose-specific maxima before aggregate traversal', () => {
    parseRejects({ ...projection(), scene: { ...projection().scene, tokens: Array.from({ length: PROJECTION_LIMITS.maxTokenRecords + 1 }, (_, index) => token(`token-${index}`)) } });
    parseRejects({ ...projection(), sight: { mode: 'restricted', polygons: Array.from({ length: PROJECTION_LIMITS.maxSightPolygons + 1 }, (_, index) => polygon(index)) } });
    parseRejects({ ...projection(), wallMesh: { segments: Array.from({ length: PROJECTION_LIMITS.maxWallMeshSegments + 1 }, (_, index) => meshSegment(`mesh-${index}`)) } });
    parseRejects({ ...projection(), wallMesh: { segments: [{ ...meshSegment('mesh'), openings: Array.from({ length: PROJECTION_LIMITS.maxWallOpeningsPerSegment + 1 }, (_, index) => ({ start: index / 18, end: (index + .5) / 18, bottom: 1, height: 1 })) }] } });
  });

  it('rejects duplicate IDs, non-finite values, and malformed wall openings', () => {
    parseRejects(projection({ scene: { ...projection().scene, tokens: [token('same'), token('same')] } }));
    parseRejects(projection({ lights: [{ id: 'same', position: point(), radius: 1, color: '#fff', intensity: 1, enabled: true }, { id: 'same', position: point(), radius: 1, color: '#fff', intensity: 1, enabled: true }] }));
    parseRejects(projection({ scene: { ...projection().scene, grid: { ...projection().scene.grid, offset: point(Number.NaN) } } }));
    for (const openings of [
      [{ start: .5, end: .5, bottom: 1, height: 1 }],
      [{ start: .1, end: .8, bottom: 1, height: 1 }, { start: .7, end: .9, bottom: 1, height: 1 }],
      [{ start: .1, end: .2, bottom: 9, height: 2 }],
    ]) parseRejects(projection({ wallMesh: { segments: [{ ...meshSegment('mesh-a'), openings }] } }));
  });

  it('rejects aggregate budgets at the whole-projection boundary', () => {
    const longTokens = Array.from({ length: PROJECTION_LIMITS.maxTokenRecords }, (_, index) => ({ ...token(`token-${index}`), label: 'x'.repeat(256) }));
    expect(() => actorProjectionV1Schema.parse(projection({ scene: { ...projection().scene, tokens: longTokens } }))).toThrow(/string budget/);

    const tooManyPoints = Array.from({ length: 33 }, (_, index) => ({ points: Array.from({ length: 512 }, (_, pointIndex) => point(index + pointIndex, pointIndex)) }));
    expect(() => actorProjectionV1Schema.parse(projection({ sight: { mode: 'restricted', polygons: tooManyPoints } }))).toThrow(/polygon-point budget/);

    const tooManyRecords = Array.from({ length: PROJECTION_LIMITS.maxTokenRecords }, (_, index) => token(`token-${index}`));
    const manyDrawings = Array.from({ length: PROJECTION_LIMITS.maxDrawingRecords }, (_, index) => drawing(`drawing-${index}`));
    const manyEntries = Array.from({ length: PROJECTION_LIMITS.maxInitiativeEntries }, (_, index) => ({ id: `entry-${index}`, tokenId: `token-${index}`, label: 'entry', score: index }));
    expect(() => actorProjectionV1Schema.parse(projection({ scene: { ...projection().scene, tokens: tooManyRecords, drawings: manyDrawings, initiative: { active: true, round: 1, turnIndex: null, entries: manyEntries } }, wallMesh: { segments: [meshSegment('extra-record')] }, lights: tooManyRecords.map((item) => ({ id: `light-${item.id}`, position: point(), radius: 1, color: '#fff', intensity: 1, enabled: true })) }))).toThrow(/record budget/);

    const openings = Array.from({ length: 16 }, (_, index) => ({ start: index / 16, end: (index + 1) / 16, bottom: 1, height: 1 }));
    const tooManyOpenings = Array.from({ length: 65 }, (_, index) => ({ ...meshSegment(`opening-${index}`), openings }));
    expect(() => actorProjectionV1Schema.parse(projection({ wallMesh: { segments: tooManyOpenings } }))).toThrow(/wall-opening budget/);

    const tooManySegments = Array.from({ length: PROJECTION_LIMITS.maxWallMeshSegments }, (_, index) => meshSegment(`segment-${index}`));
    expect(() => actorProjectionV1Schema.parse(projection({
      wallMesh: { segments: tooManySegments },
      controls: { ...projection().controls, geometry: { ...projection().controls.geometry, canCreateWall: true, editableGeometry: { walls: [editableWall('editable-one')], structures: [] } } },
    }))).toThrow(/wall-segment budget/);
  });

  it('normalizes every unordered collection through the public parser without reordering polygon points', () => {
    const value = projection({
      scene: {
        ...projection().scene,
        tokens: [token('z'), token('a')],
        drawings: [drawing('z'), drawing('a')],
        initiative: { active: true, round: 1, turnIndex: 0, entries: [
          { id: 'z-turn', tokenId: 'z', label: 'Z', score: 2 },
          { id: 'a-turn', tokenId: 'a', label: 'A', score: 1 },
        ] },
      },
      sight: { mode: 'restricted', polygons: [polygon(2), polygon(0)] },
      fog: { mode: 'concealed-regions', polygons: [polygon(2), polygon(0)] },
      wallMesh: { segments: [meshSegment('z'), meshSegment('a')] },
      lights: [
        { id: 'z', position: point(), radius: 1, color: '#fff', intensity: 1, enabled: true },
        { id: 'a', position: point(), radius: 1, color: '#fff', intensity: 1, enabled: true },
      ],
      controls: {
        ...projection().controls,
        tokens: { ...projection().controls.tokens, records: [{ tokenId: 'z', canTransform: true, canUpdateDetails: true, canDelete: true, expectedTokenRevision: 1, expectedMovementRevision: 1 }, { tokenId: 'a', canTransform: true, canUpdateDetails: true, canDelete: true, expectedTokenRevision: 1, expectedMovementRevision: 1 }] },
        drawings: { ...projection().controls.drawings, records: [{ drawingId: 'z', canUpdate: true, canDelete: true, expectedRecordRevision: 1 }, { drawingId: 'a', canUpdate: true, canDelete: true, expectedRecordRevision: 1 }] },
        initiative: { ...projection().controls.initiative, records: [{ entryId: 'z-turn', canUpdate: true, canRemove: true }, { entryId: 'a-turn', canUpdate: true, canRemove: true }] },
        geometry: { ...projection().controls.geometry, canCreateWall: true, editableGeometry: { walls: [editableWall('z'), editableWall('a')], structures: [editableStructure('z'), editableStructure('a')] } },
      },
    });
    const parsed = parseActorProjectionV1(value);
    expect(parsed.scene.tokens.map(({ id }) => id)).toEqual(['a', 'z']);
    expect(parsed.scene.drawings.map(({ id }) => id)).toEqual(['a', 'z']);
    expect(parsed.sight.mode === 'restricted' && parsed.sight.polygons[0]).toEqual(polygon(0));
    expect(parsed.sight.mode === 'restricted' && parsed.sight.polygons[0].points).toEqual(polygon(0).points);
    expect(parsed.wallMesh.segments.map(({ id }) => id)).toEqual(['a', 'z']);
    expect(parsed.controls.tokens.records.map(({ tokenId }) => tokenId)).toEqual(['a', 'z']);
    expect(parsed.controls.drawings.records.map(({ drawingId }) => drawingId)).toEqual(['a', 'z']);
    expect(parsed.controls.initiative.records.map(({ entryId }) => entryId)).toEqual(['a-turn', 'z-turn']);
    expect(parsed.controls.geometry.editableGeometry?.walls.map(({ wallId }) => wallId)).toEqual(['a', 'z']);
    expect(parsed.controls.geometry.editableGeometry?.structures.map(({ structureId }) => structureId)).toEqual(['a', 'z']);
  });

  it.each([
    ['same stream, equal projection revision', { streamId: 'opaque-stream-a', sceneRevision: 4, projectionRevision: 9 }, 9],
    ['same stream, regressed scene revision', { streamId: 'opaque-stream-a', sceneRevision: 5, projectionRevision: 10 }, 4],
  ])('freezes %s revision semantics', (_name, previous, sceneRevision) => {
    parseRejects(projection({ sceneRevision }), previous);
  });

  it('accepts increasing revisions in-stream, treats a new stream as an initial snapshot, and validates prior metadata', () => {
    const previous = { streamId: 'opaque-stream-a', sceneRevision: 4, projectionRevision: 9 };
    expect(parseActorProjectionV1(projection({ projectionRevision: 10 }), previous).projectionRevision).toBe(10);
    parseRejects(projection({ streamId: 'opaque-stream-b', sceneRevision: 0, projectionRevision: 0 }), previous);
    expect(parseActorProjectionV1(projection({ streamId: 'opaque-stream-b', sceneRevision: 0, projectionRevision: 0, streamReset: { kind: 'initial' } }), previous).streamId).toBe('opaque-stream-b');
    parseRejects(projection({ streamId: 'opaque-stream-b', projectionRevision: 1, streamReset: { kind: 'initial' } }), previous);
    parseRejects(projection({ projectionRevision: 10, streamReset: { kind: 'initial' } }), previous);
    parseRejects(projection({ projectionRevision: 10 }), { streamId: 'opaque-stream-a', sceneRevision: 4 });
    parseRejects(projection({ projectionRevision: 10 }), { streamId: 'opaque-stream-a', sceneRevision: 4, projectionRevision: Number.NaN });
  });

  it('keeps all scalar and collection budgets bounded', () => {
    expect(PROJECTION_BUDGETS.maxTotalRecords).toBeGreaterThan(0);
    parseRejects(projection({ streamId: 'x'.repeat(129) }));
    parseRejects(projection({ scene: { ...projection().scene, map: { assetId: 'map', width: 1_000_001, height: 1 } } }));
  });
});
