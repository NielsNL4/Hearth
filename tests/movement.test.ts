import { describe, expect, it } from 'vitest';
import { findNavigationPath, navigationKey, reachableNavigationCells } from '../packages/movement/src/index.js';
import { createEmptyScene, createTokenMovementState, type DoorWall, type SceneV2, type WallRecord } from '../packages/scene/src/index.js';

function sceneWithGrid(): SceneV2 {
  const scene = createEmptyScene();
  scene.map = { assetId: 'map', width: 40, height: 30 };
  scene.grid.cellSize = 10;
  scene.tokens.mover = {
    id: 'mover', assetId: 'token', position: { x: 5, y: 5 }, size: { width: 10, height: 10 }, rotation: 0,
    label: 'Mover', ownerId: 'player', hpCurrent: 1, hpMaximum: 1, hpHidden: false, z: 0,
    movement: createTokenMovementState(), revision: 0,
  };
  return scene;
}

function wall(type: WallRecord['type'], doorState?: DoorWall['doorState']): WallRecord {
  const base = {
    id: 'wall', type, start: { x: 20, y: 0 }, end: { x: 20, y: 30 },
    height: 10, thickness: 1, elevation: 0, material: 'default' as const, openings: [], revision: 0,
  };
  return (type === 'door' ? { ...base, type, doorState: doorState ?? 'closed' } : base) as WallRecord;
}

describe('grid navigation', () => {
  it('uses A* for deterministic orthogonal paths and bounded reachability', () => {
    const scene = sceneWithGrid();
    expect(findNavigationPath(scene, 'mover', { column: 0, row: 0 }, { column: 2, row: 0 }))
      .toEqual({ path: [{ column: 0, row: 0 }, { column: 1, row: 0 }, { column: 2, row: 0 }], costCells: 2 });
    const reachable = reachableNavigationCells(scene, 'mover', { column: 0, row: 0 }, 1);
    expect([...reachable.keys()].sort()).toEqual([navigationKey({ column: 0, row: 0 }), navigationKey({ column: 0, row: 1 }), navigationKey({ column: 1, row: 0 })].sort());
  });

  it('derives traversal from canonical wall and door semantics', () => {
    const scene = sceneWithGrid();
    scene.walls.wall = wall('blocking');
    expect(findNavigationPath(scene, 'mover', { column: 0, row: 0 }, { column: 2, row: 0 })).toBeNull();
    scene.walls.wall = wall('ethereal');
    expect(findNavigationPath(scene, 'mover', { column: 0, row: 0 }, { column: 2, row: 0 })).toBeNull();
    scene.walls.wall = wall('terrain');
    expect(findNavigationPath(scene, 'mover', { column: 0, row: 0 }, { column: 2, row: 0 })?.costCells).toBe(2);
    scene.walls.wall = wall('door', 'locked');
    expect(findNavigationPath(scene, 'mover', { column: 0, row: 0 }, { column: 2, row: 0 })).toBeNull();
    scene.walls.wall = wall('door', 'open');
    expect(findNavigationPath(scene, 'mover', { column: 0, row: 0 }, { column: 2, row: 0 })?.costCells).toBe(2);
  });

  it('blocks cells occupied by another token without blocking the moving token itself', () => {
    const scene = sceneWithGrid();
    scene.tokens.blocker = {
      ...scene.tokens.mover!, id: 'blocker', ownerId: 'other', position: { x: 15, y: 5 }, movement: createTokenMovementState(),
    };
    expect(findNavigationPath(scene, 'mover', { column: 0, row: 0 }, { column: 1, row: 0 })).toBeNull();
    expect(findNavigationPath(scene, 'mover', { column: 0, row: 0 }, { column: 2, row: 0 })?.costCells).toBe(4);
  });

  it('applies the moving token footprint to occupancy and map boundaries', () => {
    const scene = sceneWithGrid();
    scene.tokens.mover!.position = { x: 15, y: 15 };
    scene.tokens.mover!.size = { width: 18, height: 10 };
    scene.tokens.blocker = {
      ...scene.tokens.mover!, id: 'blocker', position: { x: 35, y: 15 }, size: { width: 10, height: 10 },
    };
    expect(findNavigationPath(scene, 'mover', { column: 1, row: 1 }, { column: 2, row: 1 })).toBeNull();
    expect(findNavigationPath(scene, 'mover', { column: 1, row: 1 }, { column: 0, row: 1 })).toBeNull();
  });
});
