import { describe, expect, it } from 'vitest';
import {
  DEFAULT_VISION_RADIUS_CELLS,
  MAX_VISIBILITY_BLOCKERS,
  MAX_VISIBILITY_EVENTS,
  MAX_VISIBILITY_OPENINGS_PER_WALL,
  MAX_VISIBILITY_WALLS,
  computeVisibilityPolygon,
  pointInPolygon,
  segmentIntersection,
  type Point,
  type WallRecord,
} from '../packages/scene/src/index.js';

const baseWall = (id: string, start: Point, end: Point, extra: Partial<WallRecord> = {}): WallRecord => ({
  id, start, end, height: 10, thickness: 1, elevation: 0, revision: 0, material: 'default', openings: [], type: 'blocking', ...extra,
} as WallRecord);

const input = (walls: WallRecord[] = [], rangeCells = DEFAULT_VISION_RADIUS_CELLS) => ({
  source: { x: 20, y: 50 }, mapBounds: { width: 100, height: 100 }, cellSize: 1, walls, rangeCells,
});

describe('deterministic 2D visibility', () => {
  it('uses wall and door vision semantics', () => {
    const visible = (wall: WallRecord) => pointInPolygon({ x: 80, y: 50 }, computeVisibilityPolygon(input([wall], 100)));
    expect(visible(baseWall('ethereal', { x: 50, y: 0 }, { x: 50, y: 100 }, { type: 'ethereal' }))).toBe(true);
    expect(visible(baseWall('terrain', { x: 50, y: 0 }, { x: 50, y: 100 }, { type: 'terrain' }))).toBe(false);
    expect(visible(baseWall('open', { x: 50, y: 0 }, { x: 50, y: 100 }, { type: 'door', doorState: 'open' }))).toBe(true);
    expect(visible(baseWall('closed', { x: 50, y: 0 }, { x: 50, y: 100 }, { type: 'door', doorState: 'closed' }))).toBe(false);
    expect(visible(baseWall('locked', { x: 50, y: 0 }, { x: 50, y: 100 }, { type: 'door', doorState: 'locked' }))).toBe(false);
  });

  it('leaves a window interior open but keeps both jamb endpoints opaque', () => {
    const wall = baseWall('window', { x: 50, y: 20 }, { x: 50, y: 80 }, {
      openings: [{ type: 'window', start: 0.25, end: 0.75, bottom: 1, height: 5 }],
    });
    const polygon = computeVisibilityPolygon(input([wall], 100));
    expect(pointInPolygon({ x: 60, y: 50 }, polygon)).toBe(true);
    expect(polygon.some((point) => point.x === 50 && point.y === 35)).toBe(true);
    expect(polygon.some((point) => point.x === 50 && point.y === 65)).toBe(true);
    // This ray passes exactly through the lower jamb and must not see past it.
    expect(pointInPolygon({ x: 80, y: 20 }, polygon)).toBe(false);
  });

  it('bounds the default/ranged result and clips it to the map', () => {
    const polygon = computeVisibilityPolygon(input([], 20));
    expect(polygon.length).toBeGreaterThan(3);
    expect(polygon.every((point) => point.x >= 0 && point.x <= 100 && point.y >= 0 && point.y <= 100)).toBe(true);
    expect(polygon.every((point) => Math.hypot(point.x - 20, point.y - 50) <= 20 + 1 / 1024)).toBe(true);
    expect(computeVisibilityPolygon({ source: { x: 0, y: 50 }, mapBounds: { width: 100, height: 100 }, cellSize: 1, walls: [], rangeCells: 20 }).length).toBeGreaterThan(3);
  });

  it('is invariant under shuffled wall insertion, including corners and T junctions', () => {
    const walls = [
      baseWall('corner', { x: 50, y: 50 }, { x: 90, y: 50 }),
      baseWall('t-vertical', { x: 50, y: 20 }, { x: 50, y: 80 }),
      baseWall('t-top', { x: 50, y: 20 }, { x: 90, y: 20 }),
    ];
    expect(computeVisibilityPolygon(input(walls, 100))).toEqual(computeVisibilityPolygon(input([...walls].reverse(), 100)));
  });

  it('handles collinear walls, shared endpoints, crossings, and offset map edges', () => {
    const walls = [
      baseWall('cross-a', { x: 140, y: 230 }, { x: 190, y: 280 }),
      baseWall('cross-b', { x: 140, y: 280 }, { x: 190, y: 230 }),
      baseWall('shared-a', { x: 145, y: 220 }, { x: 170, y: 220 }),
      baseWall('shared-b', { x: 170, y: 220 }, { x: 190, y: 220 }),
      baseWall('collinear', { x: 145, y: 220 }, { x: 190, y: 220 }),
    ];
    const polygon = computeVisibilityPolygon({
      source: { x: 110, y: 250 }, mapBounds: { x: 100, y: 200, width: 100, height: 100 }, cellSize: 1, walls, rangeCells: 100,
    });
    expect(polygon.length).toBeGreaterThan(3);
    expect(polygon.every((point) => point.x >= 100 && point.x <= 200 && point.y >= 200 && point.y <= 300)).toBe(true);
    expect(computeVisibilityPolygon({
      source: { x: 110, y: 250 }, mapBounds: { x: 100, y: 200, width: 100, height: 100 }, cellSize: 1, walls: [...walls].reverse(), rangeCells: 100,
    })).toEqual(polygon);
  });

  it('has a stable canonical golden ring for a simple blocker', () => {
    const polygon = computeVisibilityPolygon({ source: { x: 0, y: 0 }, mapBounds: { width: 100, height: 100 }, cellSize: 1, walls: [baseWall('wall', { x: 10, y: 0 }, { x: 10, y: 20 })], rangeCells: 20 });
    expect(polygon).toEqual([
      { x: 0, y: 19.9755859375 }, { x: 10, y: 0 }, { x: 10, y: 0.2451171875 }, { x: 10, y: 0.4912109375 }, { x: 10, y: 0.9853515625 },
      { x: 10, y: 1.4833984375 }, { x: 10, y: 1.9892578125 }, { x: 10, y: 2.5048828125 }, { x: 10, y: 3.033203125 }, { x: 10, y: 3.578125 },
      { x: 10, y: 4.142578125 }, { x: 10, y: 4.7294921875 }, { x: 10, y: 5.3447265625 }, { x: 10, y: 5.994140625 }, { x: 10, y: 6.681640625 },
      { x: 10, y: 7.4169921875 }, { x: 10, y: 8.20703125 }, { x: 10, y: 9.0634765625 }, { x: 10, y: 10 }, { x: 10, y: 11.033203125 },
      { x: 10, y: 12.1845703125 }, { x: 10, y: 13.4833984375 }, { x: 10, y: 14.9658203125 }, { x: 10, y: 16.68359375 }, { x: 10, y: 16.998046875 },
      { x: 9.9931640625, y: 17.30859375 }, { x: 9.2724609375, y: 17.6943359375 }, { x: 8.55078125, y: 18.080078125 }, { x: 7.64453125, y: 18.455078125 },
      { x: 6.73828125, y: 18.8310546875 }, { x: 5.798828125, y: 19.1162109375 }, { x: 4.859375, y: 19.400390625 }, { x: 3.8974609375, y: 19.591796875 },
      { x: 2.9345703125, y: 19.783203125 }, { x: 1.9580078125, y: 19.8798828125 }, { x: 0.9814453125, y: 19.9755859375 }, { x: 0.490234375, y: 19.9755859375 },
    ]);
  });

  it('fails closed for origin, malformed input, quantization collapse, and budgets', () => {
    expect(computeVisibilityPolygon(input([baseWall('origin', { x: 20, y: 20 }, { x: 20, y: 80 })], 100))).toEqual([]);
    const tooManyWalls = Array.from({ length: MAX_VISIBILITY_WALLS + 1 }, (_, index) => baseWall(`w-${index}`, { x: 0, y: 0 }, { x: 1, y: 0 }));
    expect(computeVisibilityPolygon(input(tooManyWalls, 100))).toEqual([]);
    const derivedOverflow = Array.from({ length: 64 }, (_, wallIndex) => baseWall(`split-${wallIndex}`, { x: 40, y: 10 + wallIndex }, { x: 90, y: 10 + wallIndex }, {
      openings: Array.from({ length: MAX_VISIBILITY_OPENINGS_PER_WALL }, (_, index) => ({ type: 'window' as const, start: index * 0.06, end: index * 0.06 + 0.04, bottom: 1, height: 5 })),
    }));
    expect(computeVisibilityPolygon(input(derivedOverflow, 100))).toEqual([]);
    const outputOverflow = Array.from({ length: 130 }, (_, index) => baseWall(`output-${index}`, { x: 40, y: 10 + index * 0.3 }, { x: 90, y: 10 + index * 0.3 }));
    expect(computeVisibilityPolygon(input(outputOverflow, 100))).toEqual([]);
    expect(MAX_VISIBILITY_BLOCKERS).toBeGreaterThan(0);
    expect(MAX_VISIBILITY_EVENTS).toBeGreaterThan(0);
    expect(computeVisibilityPolygon(input([baseWall('collapsed', { x: 1, y: 1 }, { x: 1.0001, y: 1.0001 })], 100))).toEqual([]);
    expect(computeVisibilityPolygon(input([baseWall('door-window', { x: 50, y: 0 }, { x: 50, y: 100 }, {
      type: 'door', doorState: 'open', openings: [{ type: 'window', start: 0.2, end: 0.8, bottom: 1, height: 5 }],
    })], 100))).toEqual([]);
    expect(computeVisibilityPolygon(input([baseWall('bad', { x: Number.NaN, y: 0 }, { x: 1, y: 0 })], 100))).toEqual([]);
  });

  it('ignores out-of-range walls after clipping and preserves a finite simple ring', () => {
    const irrelevant = Array.from({ length: MAX_VISIBILITY_WALLS - 1 }, (_, index) => baseWall(`far-${index}`, { x: 500, y: index }, { x: 600, y: index }));
    const polygon = computeVisibilityPolygon(input([baseWall('near', { x: 40, y: 0 }, { x: 40, y: 100 }), ...irrelevant], 20));
    expect(polygon.length).toBeGreaterThan(3);
    expect(polygon.every((point) => Number.isFinite(point.x) && Number.isFinite(point.y) && !Object.is(point.x, -0) && !Object.is(point.y, -0))).toBe(true);
    for (let first = 0; first < polygon.length; first++) {
      for (let second = first + 1; second < polygon.length; second++) {
        if (second === first + 1 || first === 0 && second === polygon.length - 1) continue;
        expect(segmentIntersection(
          { start: polygon[first]!, end: polygon[(first + 1) % polygon.length]! },
          { start: polygon[second]!, end: polygon[(second + 1) % polygon.length]! },
        ).kind).toBe('none');
      }
    }
  });

  it('adding blockers cannot reveal targets that were not visible before', () => {
    const targets = [{ x: 80, y: 50 }, { x: 80, y: 35 }, { x: 80, y: 65 }];
    const without = computeVisibilityPolygon(input([], 100));
    const withBlockers = computeVisibilityPolygon(input([
      baseWall('wall', { x: 50, y: 0 }, { x: 50, y: 100 }),
      baseWall('crossing', { x: 40, y: 30 }, { x: 90, y: 80 }),
    ], 100));
    for (const target of targets) {
      expect(pointInPolygon(target, without)).toBe(true);
      expect(pointInPolygon(target, withBlockers)).toBe(false);
    }
  });

  it('keeps the fixed 64-edge range boundary monotonic around event rays', () => {
    const target = { x: 35.8346, y: 64.1160 };
    const blocker = baseWall('non-occluding', { x: 35, y: 52 }, { x: 35, y: 58 });
    const empty = computeVisibilityPolygon({ source: { x: 50, y: 50 }, mapBounds: { width: 100, height: 100 }, cellSize: 1, walls: [], rangeCells: 20 });
    const withBlocker = computeVisibilityPolygon({ source: { x: 50, y: 50 }, mapBounds: { width: 100, height: 100 }, cellSize: 1, walls: [blocker], rangeCells: 20 });
    expect(pointInPolygon(target, empty)).toBe(false);
    expect(pointInPolygon(target, withBlocker)).toBe(false);

    const boundaryDirection = Math.PI * 3 / 4;
    const inside = { x: 50 + Math.cos(boundaryDirection) * 19.97, y: 50 + Math.sin(boundaryDirection) * 19.97 };
    const outside = { x: 50 + Math.cos(boundaryDirection) * 19.98, y: 50 + Math.sin(boundaryDirection) * 19.98 };
    expect(pointInPolygon(inside, empty)).toBe(true);
    expect(pointInPolygon(outside, empty)).toBe(false);
    expect(pointInPolygon(inside, withBlocker)).toBe(true);
    expect(pointInPolygon(outside, withBlocker)).toBe(false);
  });
});
