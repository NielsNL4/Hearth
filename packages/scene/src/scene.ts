import { sceneV1Schema, sceneV2Schema } from './schema.js';
import type { SceneV1, SceneV2 } from './types.js';

export function createEmptySceneV1(): SceneV1 {
  return {
    version: 1,
    grid: { type: 'square', cellSize: 1, offset: { x: 0, y: 0 }, distancePerCell: 5, unit: 'ft' },
    extensions: {},
  };
}

export function createEmptyScene(): SceneV2 {
  return {
    version: 2,
    coordinateSystem: { origin: 'top-left', axes: 'x-right-y-down', worldUnit: 'map-pixel' },
    map: null,
    grid: { type: 'square', visible: true, cellSize: 1, offset: { x: 0, y: 0 }, distancePerCell: 5, unit: 'ft', snap: true },
    permissions: { playerMovement: 'owned' },
    tokens: {},
    walls: {},
    fog: { version: 1, mode: 'shared', operations: [] },
    initiative: { version: 1, active: false, round: 0, turnIndex: null, entries: [] },
    drawings: {},
    structures: {},
    lights: {},
    effects: {},
    extensions: {},
  };
}

export function migrateSceneV1ToV2(input: SceneV1): SceneV2 {
  const scene = createEmptyScene();
  scene.grid = { ...input.grid, visible: true, snap: true, offset: { ...input.grid.offset } };
  scene.extensions = structuredClone(input.extensions);
  return scene;
}

export function parseSceneV1(input: unknown): SceneV1 {
  return sceneV1Schema.parse(input) as SceneV1;
}

export function parseSceneV2(input: unknown): SceneV2 {
  return sceneV2Schema.parse(input) as SceneV2;
}

export function parseScene(input: unknown): SceneV2 {
  if (typeof input !== 'object' || input === null || !('version' in input)) {
    return parseSceneV2(input);
  }
  if (input.version === 1) return migrateSceneV1ToV2(parseSceneV1(input));
  return parseSceneV2(input);
}

export function serializeScene(scene: SceneV2): string {
  return JSON.stringify(parseSceneV2(scene));
}

export function deserializeScene(serialized: string): SceneV2 {
  return parseScene(JSON.parse(serialized) as unknown);
}

export function cloneScene(scene: SceneV2): SceneV2 {
  return deserializeScene(serializeScene(scene));
}
