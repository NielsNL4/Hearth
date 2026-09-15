import { describe, expect, it } from 'vitest';
import {
  canCloseDoor,
  canOpenDoor,
  cloneScene,
  createEmptyScene,
  createTokenMovementState,
  deserializeScene,
  isDoorLocked,
  migrateSceneV1ToV2,
  normalizeRotation,
  parseScene,
  parseSceneV2,
  serializeScene,
  snapCoordinate,
  snapPoint,
  wallBlocksMovement,
  wallBlocksVision,
  type DoorWall,
  type SceneV1,
  type WallRecord,
} from '../packages/scene/src/index.js';

describe('SceneV2 parsing and migration', () => {
  it('creates a complete empty SceneV2', () => {
    const scene = createEmptyScene();
    expect(parseSceneV2(scene)).toEqual(scene);
    expect(scene).toEqual({
      version: 2,
      coordinateSystem: { origin: 'top-left', axes: 'x-right-y-down', worldUnit: 'map-pixel' },
      map: null,
      grid: {
        type: 'square', visible: true, cellSize: 1, offset: { x: 0, y: 0 },
        distancePerCell: 5, unit: 'ft', snap: true,
      },
      permissions: { playerMovement: 'owned', playerDrawing: 'own', playerPerspectiveView: false },
      navigationRevision: 0,
      wallRevision: 0,
      tokens: {}, walls: {},
      fog: { version: 1, mode: 'shared', enabled: false, base: 'revealed', operations: [], revision: 0 },
      drawings: {}, structures: {}, structureRevision: 0, lights: {}, effects: {},
      drawingRevision: 0,
      initiative: { version: 1, active: false, round: 0, turnIndex: null, entries: [], revision: 0 },
      extensions: {},
    });
  });

  it('explicitly migrates V1 grid settings and extensions without aliasing', () => {
    const v1: SceneV1 = {
      version: 1,
      grid: { type: 'square', cellSize: 70, offset: { x: -5, y: 8 }, distancePerCell: 1.5, unit: 'm' },
      extensions: { module: { enabled: true } },
    };
    const migrated = migrateSceneV1ToV2(v1);
    expect(parseScene(v1)).toEqual(migrated);
    expect(migrated.grid).toEqual({ ...v1.grid, visible: true, snap: true });
    expect(migrated.extensions).toEqual(v1.extensions);
    expect(migrated.extensions).not.toBe(v1.extensions);
  });

  it('defaults wallRevision for older SceneV2 snapshots', () => {
    const older = createEmptyScene();
    delete older.wallRevision;
    expect(parseSceneV2(older).wallRevision).toBe(0);
    expect(parseSceneV2(JSON.parse(serializeScene(older)))).toMatchObject({ wallRevision: 0 });
  });

  it('normalizes legacy structures and defaults new permission state', () => {
    const older = createEmptyScene();
    delete older.permissions.playerPerspectiveView;
    delete older.structureRevision;
    older.structures.crate = {
      id: 'crate', position: { x: 1, y: 2 }, size: { width: 2, height: 2 }, rotation: 0,
      label: 'Crate', z: 1, revision: 0,
    } as never;
    const parsed = parseSceneV2(older);
    expect(parsed.permissions.playerPerspectiveView).toBe(false);
    expect(parsed.structureRevision).toBe(0);
    expect(parsed.structures.crate).toMatchObject({ kind: 'block', material: 'default', baseElevation: 0, slabHeight: 1 });
  });

  it('rejects malformed records, mismatched keys, invalid versions, and non-JSON extensions', () => {
    const scene = createEmptyScene();
    scene.tokens.goblin = {
      id: 'other', assetId: 'goblin.png', position: { x: 0, y: 0 }, size: { width: 1, height: 1 },
      rotation: 0, label: 'Goblin', ownerId: '', hpCurrent: 1, hpMaximum: 1, hpHidden: true, z: 0, revision: 0,
    };
    expect(() => parseSceneV2(scene)).toThrow(/Record id must match its key/);
    expect(() => parseScene({ version: 3 })).toThrow();
    expect(() => parseSceneV2({ ...createEmptyScene(), extensions: { bad: undefined } })).toThrow();
  });

  it('validates every wall type and rejects invalid door combinations', () => {
    for (const type of ['blocking', 'terrain', 'ethereal'] as const) {
      const scene = createEmptyScene();
      scene.walls[type] = { id: type, type, start: { x: 0, y: 0 }, end: { x: 1, y: 0 }, height: 10, thickness: 1, elevation: 0, material: 'default', openings: [], revision: 0 };
      expect(parseSceneV2(scene).walls[type]?.type).toBe(type);
    }
    for (const doorState of ['open', 'closed', 'locked'] as const) {
      const scene = createEmptyScene();
      scene.walls.door = { id: 'door', type: 'door', doorState, start: { x: 0, y: 0 }, end: { x: 1, y: 0 }, height: 10, thickness: 1, elevation: 0, material: 'default', openings: [], revision: 0 };
      expect(parseSceneV2(scene).walls.door).toMatchObject({ type: 'door', doorState });
    }
    const base = { id: 'wall', start: { x: 0, y: 0 }, end: { x: 1, y: 0 }, height: 10, thickness: 1, elevation: 0, revision: 0 };
    expect(() => parseSceneV2({ ...createEmptyScene(), walls: { wall: { ...base, type: 'blocking', doorState: 'open' } } })).toThrow();
    expect(() => parseSceneV2({ ...createEmptyScene(), walls: { wall: { ...base, type: 'door', doorState: 'ajar' } } })).toThrow();
    expect(() => parseSceneV2({ ...createEmptyScene(), walls: { wall: { ...base, type: 'blocking', end: { x: 0, y: 0 } } } })).toThrow(/must have length/);
    expect(() => parseSceneV2({ ...createEmptyScene(), walls: { different: { ...base, type: 'terrain' } } })).toThrow(/Record id must match its key/);
  });

  it('defaults wall material and openings while rejecting invalid window openings', () => {
    const legacyWall = {
      id: 'legacy', type: 'blocking', start: { x: 0, y: 0 }, end: { x: 10, y: 0 },
      height: 10, thickness: 1, elevation: 0, revision: 0,
    };
    expect(parseSceneV2({ ...createEmptyScene(), walls: { legacy: legacyWall } }).walls.legacy).toMatchObject({ material: 'default', openings: [] });
    const base = { ...createEmptyScene(), walls: { wall: { ...legacyWall } } };
    const invalid = [
      [{ type: 'window', start: .5, end: .5, bottom: 1, height: 2 }],
      [{ type: 'window', start: .6, end: .9, bottom: 1, height: 2 }, { type: 'window', start: .4, end: .5, bottom: 1, height: 2 }],
      [{ type: 'window', start: .1, end: .2, bottom: 0, height: 2 }],
      [{ type: 'window', start: .1, end: .2, bottom: 8, height: 3 }],
      Array.from({ length: 33 }, () => ({ type: 'window', start: 0, end: .01, bottom: 1, height: 2 })),
    ];
    for (const openings of invalid) expect(() => parseSceneV2({ ...base, walls: { wall: { ...legacyWall, openings } } })).toThrow();
    expect(() => parseSceneV2({ ...base, walls: { wall: { ...legacyWall, type: 'door', doorState: 'closed', openings: [{ type: 'window', start: .1, end: .2, bottom: 1, height: 2 }] } } })).toThrow();
  });

  it('migrates deterministically through serialization while preserving nested extensions', () => {
    const input: SceneV1 = {
      version: 1,
      grid: { type: 'square', cellSize: 50, offset: { x: -25, y: 75 }, distancePerCell: 5, unit: 'ft' },
      extensions: { module: { nested: [{ enabled: true }, null, 3] } },
    };
    const first = parseScene(JSON.parse(JSON.stringify(input)));
    const second = deserializeScene(serializeScene(first));
    expect(second).toEqual(first);
    expect(migrateSceneV1ToV2(input)).toEqual(migrateSceneV1ToV2(input));
  });
});

describe('scene geometry and wall helpers', () => {
  const wall = (type: WallRecord['type']): WallRecord => ({
    id: type, type, start: { x: 0, y: 0 }, end: { x: 1, y: 1 },
    height: 10, thickness: 1, elevation: 0, revision: 0,
    ...(type === 'door' ? { doorState: 'closed' as const } : {}),
  } as WallRecord);

  it('normalizes rotations to [0, 360)', () => {
    expect(normalizeRotation(725)).toBe(5);
    expect(normalizeRotation(-90)).toBe(270);
    expect(normalizeRotation(-720)).toBe(0);
    expect(() => normalizeRotation(Number.NaN)).toThrow(RangeError);
  });

  it('snaps positive and negative coordinates symmetrically with offsets', () => {
    expect(snapCoordinate(14, 10)).toBe(10);
    expect(snapCoordinate(-14, 10)).toBe(-10);
    expect(snapCoordinate(-5, 10)).toBe(-10);
    expect(snapPoint({ x: -16, y: 26 }, 10, { x: 4, y: 6 })).toEqual({ x: -16, y: 26 });
    expect(() => snapCoordinate(1, 0)).toThrow(RangeError);
  });

  it('models blocking, terrain, and ethereal behavior', () => {
    expect([wallBlocksMovement(wall('blocking')), wallBlocksVision(wall('blocking'))]).toEqual([true, true]);
    expect([wallBlocksMovement(wall('terrain')), wallBlocksVision(wall('terrain'))]).toEqual([false, true]);
    expect([wallBlocksMovement(wall('ethereal')), wallBlocksVision(wall('ethereal'))]).toEqual([true, false]);
  });

  it('models open, closed, and locked door semantics', () => {
    const door = (doorState: DoorWall['doorState']): DoorWall => ({
      id: doorState, type: 'door', doorState, start: { x: 0, y: 0 }, end: { x: 1, y: 0 },
      height: 10, thickness: 1, elevation: 0, material: 'default', openings: [], revision: 0,
    });
    expect([wallBlocksMovement(door('open')), wallBlocksVision(door('open'))]).toEqual([false, false]);
    expect([wallBlocksMovement(door('closed')), wallBlocksVision(door('locked'))]).toEqual([true, true]);
    expect(canOpenDoor(door('closed'))).toBe(true);
    expect(canOpenDoor(door('locked'))).toBe(false);
    expect(canCloseDoor(door('open'))).toBe(true);
    expect(isDoorLocked(door('locked'))).toBe(true);
  });
});

describe('scene serialization', () => {
  it('round-trips and deeply clones scene state', () => {
    const scene = createEmptyScene();
    scene.tokens.hero = {
      id: 'hero', assetId: 'hero-asset', position: { x: -10, y: 20 }, size: { width: 2, height: 2 }, rotation: 45,
      label: 'Hero', ownerId: 'player-1', hpCurrent: 8, hpMaximum: 10, hpHidden: false, z: 3,
      movement: createTokenMovementState(), revision: 4,
    };
    const serialized = serializeScene(scene);
    expect(deserializeScene(serialized)).toEqual(scene);
    const clone = cloneScene(scene);
    clone.tokens.hero.position.x = 99;
    expect(scene.tokens.hero.position.x).toBe(-10);
  });
});
