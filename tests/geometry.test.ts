import { describe, expect, it } from 'vitest';
import {
  circleFootprint,
  castRayAgainstSegments,
  coneFootprint,
  connectedWallComponents,
  ellipsePolygon,
  gridToWorld,
  hitTestWallSegments,
  hitTestRotatedToken,
  measureGridDistance,
  normalizeOpeningIntervals,
  pointInPolygon,
  polygonArea,
  rectangleFootprint,
  rectanglePolygon,
  raySegmentIntersection,
  screenToWorld,
  segmentIntersection,
  segmentPartsOutsideOpenings,
  simplifyPolyline,
  ellipseFootprint,
  snapPointToCellCenter,
  wallToShapeInput,
  wallToMeshInputs,
  sceneToMeshInputs,
  snapWallEndpoint,
  worldToGrid,
  worldToScreen,
  zoomViewAtScreenPoint,
  type WallRecord,
} from '../packages/scene/src/index.js';

const wall = (id: string, start: { x: number; y: number }, end: { x: number; y: number }): WallRecord => ({
  id, type: 'blocking', start, end, height: 10, thickness: 2, elevation: 3, material: 'default', openings: [], revision: 0,
});

describe('coordinate spaces', () => {
  it('round-trips world and screen coordinates', () => {
    const view = { x: -20, y: 40, zoom: 2.5 };
    const viewport = { width: 1000, height: 600 };
    const world = { x: 130, y: -75 };
    expect(screenToWorld(worldToScreen(world, view, viewport), view, viewport)).toEqual(world);
  });

  it('preserves the world point below the cursor while zooming', () => {
    const viewport = { width: 800, height: 500 };
    const pointer = { x: 125, y: 410 };
    const before = { x: 300, y: 200, zoom: 0.75 };
    const anchor = screenToWorld(pointer, before, viewport);
    const after = zoomViewAtScreenPoint(before, pointer, 3, viewport);
    expect(screenToWorld(pointer, after, viewport)).toEqual(anchor);
  });

  it('round-trips fractional grid coordinates and snaps to cell centers', () => {
    const offset = { x: -10, y: 5 };
    const world = { x: 65, y: -20 };
    expect(gridToWorld(worldToGrid(world, 25, offset), 25, offset)).toEqual(world);
    expect(snapPointToCellCenter({ x: 1, y: 1 }, 50)).toEqual({ x: 25, y: 25 });
    expect(snapPointToCellCenter({ x: -1, y: -1 }, 50)).toEqual({ x: -25, y: -25 });
    expect(snapPointToCellCenter({ x: 14, y: 19 }, 10, { x: 4, y: -1 })).toEqual({ x: 19, y: 24 });
  });
});

describe('drawing and ruler geometry', () => {
  it('normalizes rectangles and ellipses to canonical polygons', () => {
    expect(rectanglePolygon({ x: 2, y: 3 }, { x: 8, y: 9 })).toEqual([
      { x: 2, y: 3 }, { x: 8, y: 3 }, { x: 8, y: 9 }, { x: 2, y: 9 },
    ]);
    const ellipse = ellipsePolygon({ x: 0, y: 0 }, { x: 20, y: 10 }, 32);
    expect(ellipse).toHaveLength(32);
    expect(Math.abs(polygonArea(ellipse) - Math.PI * 10 * 5)).toBeLessThan(1.1);
  });

  it('simplifies paths and applies explicit diagonal distance rules', () => {
    expect(simplifyPolyline([{ x: 0, y: 0 }, { x: 5, y: .1 }, { x: 10, y: 0 }], .2)).toEqual([{ x: 0, y: 0 }, { x: 10, y: 0 }]);
    expect(measureGridDistance({ x: 0, y: 0 }, { x: 20, y: 20 }, 10, 5, 'five-ten-five')).toEqual({ cells: 3, distance: 15 });
    expect(measureGridDistance({ x: 0, y: 0 }, { x: 30, y: 40 }, 10, 5, 'euclidean')).toEqual({ cells: 5, distance: 25 });
    expect(measureGridDistance({ x: 0, y: 0 }, { x: 30, y: 40 }, 10, 5, 'manhattan')).toEqual({ cells: 7, distance: 35 });
  });
});

describe('intersection and containment', () => {
  it('finds crossing, touching, overlapping, and separate segments', () => {
    expect(segmentIntersection({ start: { x: 0, y: 0 }, end: { x: 10, y: 10 } }, { start: { x: 0, y: 10 }, end: { x: 10, y: 0 } }))
      .toEqual({ kind: 'point', point: { x: 5, y: 5 } });
    expect(segmentIntersection({ start: { x: 0, y: 0 }, end: { x: 10, y: 0 } }, { start: { x: 10, y: 0 }, end: { x: 10, y: 4 } }))
      .toEqual({ kind: 'point', point: { x: 10, y: 0 } });
    expect(segmentIntersection({ start: { x: 0, y: 0 }, end: { x: 10, y: 0 } }, { start: { x: 4, y: 0 }, end: { x: 12, y: 0 } }))
      .toEqual({ kind: 'overlap', start: { x: 4, y: 0 }, end: { x: 10, y: 0 } });
    expect(segmentIntersection({ start: { x: 0, y: 0 }, end: { x: 1, y: 0 } }, { start: { x: 2, y: 0 }, end: { x: 3, y: 0 } }))
      .toEqual({ kind: 'none' });
  });

  it('handles polygon boundaries and concave regions', () => {
    const polygon = [{ x: 0, y: 0 }, { x: 8, y: 0 }, { x: 8, y: 8 }, { x: 4, y: 4 }, { x: 0, y: 8 }];
    expect(pointInPolygon({ x: 2, y: 2 }, polygon)).toBe(true);
    expect(pointInPolygon({ x: 4, y: 4 }, polygon)).toBe(true);
    expect(pointInPolygon({ x: 4, y: 6 }, polygon)).toBe(false);
    expect(polygonArea(polygon)).toBe(48);
    expect(polygonArea([...polygon].reverse())).toBe(48);
  });

  it('hit-tests rectangular tokens after rotation', () => {
    const token = { position: { x: 10, y: 10 }, size: { width: 8, height: 2 }, rotation: 90 };
    expect(hitTestRotatedToken({ x: 10, y: 13.5 }, token)).toBe(true);
    expect(hitTestRotatedToken({ x: 13.5, y: 10 }, token)).toBe(false);
  });

  it('returns the nearest geometric ray/segment intersection', () => {
    expect(raySegmentIntersection({ x: 0, y: 0 }, { x: 2, y: 0 }, { start: { x: 5, y: -2 }, end: { x: 5, y: 2 } }))
      .toEqual({ point: { x: 5, y: 0 }, distance: 5 });
    expect(raySegmentIntersection({ x: 0, y: 0 }, { x: 1, y: 0 }, { start: { x: -5, y: -2 }, end: { x: -5, y: 2 } })).toBeNull();
    expect(castRayAgainstSegments({ x: 0, y: 0 }, { x: 1, y: 0 }, [
      { start: { x: 8, y: -1 }, end: { x: 8, y: 1 } },
      { start: { x: 3, y: -1 }, end: { x: 3, y: 1 } },
    ])).toEqual({ point: { x: 3, y: 0 }, distance: 3, segmentIndex: 1 });
  });
});

describe('wall and area geometry', () => {
  it('normalizes openings and splits solid wall portions', () => {
    expect(normalizeOpeningIntervals([{ start: .7, end: .4 }, { start: .6, end: 1.2 }, { start: -.2, end: .1 }]))
      .toEqual([{ start: 0, end: .1 }, { start: .4, end: 1 }]);
    expect(segmentPartsOutsideOpenings({ start: { x: 0, y: 0 }, end: { x: 100, y: 0 } }, [{ start: .25, end: .75 }]))
      .toEqual([{ start: { x: 0, y: 0 }, end: { x: 25, y: 0 } }, { start: { x: 75, y: 0 }, end: { x: 100, y: 0 } }]);
  });

  it('detects connected wall components within an explicit tolerance', () => {
    expect(connectedWallComponents([
      wall('a', { x: 0, y: 0 }, { x: 10, y: 0 }),
      wall('b', { x: 10.0001, y: 0 }, { x: 20, y: 0 }),
      wall('c', { x: 50, y: 50 }, { x: 60, y: 50 }),
    ], .001)).toEqual([['a', 'b'], ['c']]);
  });

  it('snaps to eligible wall endpoints at the tolerance boundary', () => {
    const walls = [wall('wall', { x: 0, y: 0 }, { x: 10, y: 0 })];
    expect(snapWallEndpoint({ x: 0, y: 2 }, walls, 2)).toEqual({
      point: { x: 0, y: 0 }, wallId: 'wall', endpoint: 'start', distance: 2,
    });
    expect(snapWallEndpoint({ x: 0, y: 2.001 }, walls, 2)).toEqual({
      point: { x: 0, y: 2.001 }, wallId: null, endpoint: null, distance: null,
    });
  });

  it('selects start and end endpoints and resolves endpoint ties deterministically', () => {
    const walls = [wall('wall', { x: 0, y: 0 }, { x: 10, y: 0 })];
    expect(snapWallEndpoint({ x: .5, y: 0 }, walls, 1)).toMatchObject({ wallId: 'wall', endpoint: 'start' });
    expect(snapWallEndpoint({ x: 9.5, y: 0 }, walls, 1)).toMatchObject({ wallId: 'wall', endpoint: 'end' });
    expect(snapWallEndpoint({ x: 5, y: 0 }, walls, 5)).toMatchObject({ wallId: 'wall', endpoint: 'start' });
    expect(snapWallEndpoint({ x: 5, y: 0 }, [
      wall('b', { x: 0, y: 0 }, { x: 10, y: 0 }), wall('a', { x: 0, y: 0 }, { x: 10, y: 0 }),
    ], 5).wallId).toBe('a');
  });

  it('returns only the unchanged target when no endpoint is within tolerance', () => {
    const target = { x: 4, y: 7 };
    const result = snapWallEndpoint(target, [wall('wall', { x: 0, y: 0 }, { x: 10, y: 0 })], 1);
    expect(result).toEqual({ point: target, wallId: null, endpoint: null, distance: null });
    expect(result.point).not.toBe(target);
  });

  it('hit-tests wall segments at the tolerance boundary and misses outside it', () => {
    const walls = [wall('wall', { x: 0, y: 0 }, { x: 10, y: 0 })];
    expect(hitTestWallSegments({ x: 4, y: 2 }, walls, 2)).toEqual({
      wallId: 'wall', point: { x: 4, y: 0 }, distance: 2,
    });
    expect(hitTestWallSegments({ x: 4, y: 2.001 }, walls, 2)).toBeNull();
    expect(hitTestWallSegments({ x: 12, y: 0 }, walls, 1)).toBeNull();
  });

  it('returns the nearest wall hit and resolves equal-distance hits by wall ID', () => {
    expect(hitTestWallSegments({ x: 5, y: 1 }, [
      wall('b', { x: 0, y: 0 }, { x: 10, y: 0 }),
      wall('a', { x: 0, y: 2 }, { x: 10, y: 2 }),
    ], 1)).toEqual({ wallId: 'a', point: { x: 5, y: 2 }, distance: 1 });
    expect(hitTestWallSegments({ x: 5, y: .25 }, [
      wall('far', { x: 0, y: 2 }, { x: 10, y: 2 }),
      wall('near', { x: 0, y: 0 }, { x: 10, y: 0 }),
    ], 2)).toEqual({ wallId: 'near', point: { x: 5, y: 0 }, distance: .25 });
  });

  it('creates deterministic wall extrusion input without Three.js objects', () => {
    expect(wallToShapeInput(wall('a', { x: 0, y: 0 }, { x: 10, y: 0 }))).toEqual({
      contour: [{ x: 0, y: 1 }, { x: 10, y: 1 }, { x: 10, y: -1 }, { x: 0, y: -1 }],
      depth: 10,
      elevation: 3,
    });
  });

  it('projects plain, windowed, and door walls in deterministic part order', () => {
    const plain = wall('plain', { x: 0, y: 0 }, { x: 10, y: 0 });
    plain.material = 'masonry';
    const windowed: WallRecord = {
      ...plain,
      id: 'windowed',
      material: 'wood',
      openings: [{ type: 'window', start: .25, end: .75, bottom: 2, height: 5 }],
    };
    const openDoor: WallRecord = { ...plain, id: 'open-door', type: 'door', doorState: 'open' };
    const lockedDoor: WallRecord = { ...plain, id: 'locked-door', type: 'door', doorState: 'locked' };
    const before = structuredClone(windowed);
    expect(wallToMeshInputs(plain)).toEqual([{
      wallId: 'plain', partId: 'plain:wall', role: 'wall', material: 'masonry',
      contour: [{ x: 0, y: 1 }, { x: 10, y: 1 }, { x: 10, y: -1 }, { x: 0, y: -1 }], depth: 10, elevation: 3,
    }]);
    expect(wallToMeshInputs(openDoor)).toEqual([]);
    expect(wallToMeshInputs(lockedDoor)).toEqual([expect.objectContaining({ wallId: 'locked-door', partId: 'locked-door:door', role: 'door' })]);
    expect(wallToMeshInputs(windowed)).toEqual([
      { wallId: 'windowed', partId: 'windowed:segment:0', role: 'segment', material: 'wood', contour: [{ x: 0, y: 1 }, { x: 2.5, y: 1 }, { x: 2.5, y: -1 }, { x: 0, y: -1 }], depth: 10, elevation: 3 },
      { wallId: 'windowed', partId: 'windowed:opening:0:sill', role: 'window-sill', material: 'wood', contour: [{ x: 2.5, y: 1 }, { x: 7.5, y: 1 }, { x: 7.5, y: -1 }, { x: 2.5, y: -1 }], depth: 2, elevation: 3, openingIndex: 0 },
      { wallId: 'windowed', partId: 'windowed:opening:0:lintel', role: 'window-lintel', material: 'wood', contour: [{ x: 2.5, y: 1 }, { x: 7.5, y: 1 }, { x: 7.5, y: -1 }, { x: 2.5, y: -1 }], depth: 3, elevation: 10, openingIndex: 0 },
      { wallId: 'windowed', partId: 'windowed:segment:1', role: 'segment', material: 'wood', contour: [{ x: 7.5, y: 1 }, { x: 10, y: 1 }, { x: 10, y: -1 }, { x: 7.5, y: -1 }], depth: 10, elevation: 3 },
    ]);
    expect(windowed).toEqual(before);
    const scene = { walls: { z: plain, a: windowed } };
    expect(sceneToMeshInputs(scene).map((part) => part.partId)).toEqual([
      'plain:wall', 'windowed:segment:0', 'windowed:opening:0:sill',
      'windowed:opening:0:lintel', 'windowed:segment:1',
    ]);
    expect(sceneToMeshInputs(scene)).toEqual(sceneToMeshInputs(scene));
  });

  it('leaves the interior of a narrow window aperture free of prism contours', () => {
    const narrow: WallRecord = {
      ...wall('narrow', { x: 0, y: 0 }, { x: 100, y: 0 }),
      openings: [{ type: 'window', start: .49, end: .51, bottom: 2, height: 5 }],
    };
    const parts = wallToMeshInputs(narrow);
    expect(parts.map(({ partId, role }) => ({ partId, role }))).toEqual([
      { partId: 'narrow:segment:0', role: 'segment' },
      { partId: 'narrow:opening:0:sill', role: 'window-sill' },
      { partId: 'narrow:opening:0:lintel', role: 'window-lintel' },
      { partId: 'narrow:segment:1', role: 'segment' },
    ]);
    expect(parts.map((part) => ({ partId: part.partId, x: [part.contour[0].x, part.contour[1].x], elevation: part.elevation, depth: part.depth }))).toEqual([
      { partId: 'narrow:segment:0', x: [0, 49], elevation: 3, depth: 10 },
      { partId: 'narrow:opening:0:sill', x: [49, 51], elevation: 3, depth: 2 },
      { partId: 'narrow:opening:0:lintel', x: [49, 51], elevation: 10, depth: 3 },
      { partId: 'narrow:segment:1', x: [51, 100], elevation: 3, depth: 10 },
    ]);
    const apertureBottom = narrow.elevation + narrow.openings[0]!.bottom;
    const apertureTop = apertureBottom + narrow.openings[0]!.height;
    for (const part of parts) {
      const partTop = part.elevation + part.depth;
      if (part.elevation < apertureTop && partTop > apertureBottom) {
        const minX = Math.min(...part.contour.map((point) => point.x));
        const maxX = Math.max(...part.contour.map((point) => point.x));
        expect(maxX <= 49 || minX >= 51).toBe(true);
      }
    }
  });

  it('builds deterministic circle and cone footprints', () => {
    expect(circleFootprint({ x: 0, y: 0 }, 2, 4)).toEqual([
      { x: 2, y: 0 }, { x: expect.closeTo(0), y: 2 }, { x: -2, y: expect.closeTo(0) }, { x: expect.closeTo(0), y: -2 },
    ]);
    const cone = coneFootprint({ x: 0, y: 0 }, 0, 10, 90, 2);
    expect(cone).toHaveLength(4);
    expect(cone[2]).toEqual({ x: 10, y: 0 });
  });

  it('builds rotated rectangle and ellipse footprints', () => {
    expect(rectangleFootprint({ x: 0, y: 0 }, { width: 4, height: 2 }, 90)).toEqual([
      { x: expect.closeTo(1), y: -2 }, { x: expect.closeTo(1), y: 2 },
      { x: expect.closeTo(-1), y: 2 }, { x: expect.closeTo(-1), y: -2 },
    ]);
    const ellipse = ellipseFootprint({ x: 4, y: 5 }, { width: 3, height: 1 }, 0, 4);
    expect(ellipse).toHaveLength(4);
    expect(ellipse[0]).toEqual({ x: 7, y: 5 });
  });
});
