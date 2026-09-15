import {
  pointOnSegment,
  segmentIntersection,
  segmentPartsOutsideOpenings,
  type Segment,
  type SegmentIntersection,
} from './geometry.js';
import { wallBlocksVision } from './helpers.js';
import type { Point, WallRecord } from './types.js';

/** The default sight radius used when a caller does not provide one. */
export const DEFAULT_VISION_RADIUS_CELLS = 12;

/** V1 input limits. These limits are intentionally part of the pure solver contract. */
export const MAX_VISIBILITY_WALLS = 512;
export const MAX_VISIBILITY_OPENINGS_PER_WALL = 16;

/**
 * Maximum post-split, map/range-local blocker pieces.  Pieces outside the
 * effective map/range are discarded before this budget is charged. Overflow
 * returns an empty polygon so a partial sweep can never over-reveal.
 */
export const MAX_VISIBILITY_BLOCKERS = 2048;

/** Maximum event-derived output vertices. */
export const MAX_VISIBILITY_POINTS = 512;

/** Maximum angular events retained by the bounded sweep. */
export const MAX_VISIBILITY_EVENTS = 4096;

const NORMALIZATION = 1024;
const MAX_COORDINATE = 1_000_000;
const MAX_RANGE_CELLS = 1_000_000;
const MAX_EFFECTIVE_RADIUS = 2_000_000;
const MIN_EPSILON = 1e-10;
/** Accepted fixed source-range boundary: a 64-edge regular polygon inscribed in the radius circle. */
const RANGE_EDGE_COUNT = 64;

export type VisibilityMapBounds = {
  x?: number;
  y?: number;
  width: number;
  height: number;
} | {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
} | {
  min: Point;
  max: Point;
};

export interface VisibilityInput {
  source: Point;
  mapBounds?: VisibilityMapBounds;
  bounds?: VisibilityMapBounds;
  cellSize?: number;
  gridCellSize?: number;
  walls?: readonly WallRecord[] | Readonly<Record<string, WallRecord>>;
  canonicalWalls?: readonly WallRecord[] | Readonly<Record<string, WallRecord>>;
  rangeCells?: number;
}

interface NormalizedBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

interface NormalizedWall {
  id: string;
  start: Point;
  end: Point;
  openings: WallRecord['openings'];
  type: WallRecord['type'];
  doorState?: 'open' | 'closed' | 'locked';
}

interface VisibilityBlocker {
  segment: Segment;
  key: string;
}

interface SweepEvent {
  point: Point;
  angle: number;
  key: string;
}

function emptyPolygon(): Point[] { return []; }

function normalized(value: number): number {
  const result = Math.round(value * NORMALIZATION) / NORMALIZATION;
  return Object.is(result, -0) ? 0 : result;
}

function normalizedPoint(point: Point): Point {
  return { x: normalized(point.x), y: normalized(point.y) };
}

function finiteCoordinate(value: number): boolean {
  return Number.isFinite(value) && Math.abs(value) <= MAX_COORDINATE;
}

function compareLexically(first: string, second: string): number {
  return first < second ? -1 : first > second ? 1 : 0;
}

function validPoint(point: unknown): point is Point {
  if (typeof point !== 'object' || point === null) return false;
  const candidate = point as Point;
  return finiteCoordinate(candidate.x) && finiteCoordinate(candidate.y);
}

function distanceSquared(first: Point, second: Point): number {
  const x = second.x - first.x;
  const y = second.y - first.y;
  return x * x + y * y;
}

function segmentLengthSquared(segment: Segment): number {
  return distanceSquared(segment.start, segment.end);
}

function segmentTolerance(segment: Segment, epsilon: number): number {
  return epsilon * Math.max(1, Math.sqrt(segmentLengthSquared(segment)));
}

function pairTolerance(first: Segment, second: Segment, epsilon: number): number {
  return Math.max(segmentTolerance(first, epsilon), segmentTolerance(second, epsilon));
}

function epsilonFor(...values: number[]): number {
  const scale = Math.max(1, ...values.map((value) => Math.abs(value)));
  return Math.max(MIN_EPSILON, scale * 1e-12);
}

function normalizeBounds(value: VisibilityMapBounds | undefined): NormalizedBounds | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  let x: number;
  let y: number;
  let width: number;
  let height: number;
  if ('width' in value) {
    ({ width, height } = value);
    x = value.x ?? 0;
    y = value.y ?? 0;
  } else if ('minX' in value) {
    x = value.minX;
    y = value.minY;
    width = value.maxX - value.minX;
    height = value.maxY - value.minY;
  } else {
    if (!validPoint(value.min) || !validPoint(value.max)) return null;
    x = value.min.x;
    y = value.min.y;
    width = value.max.x - value.min.x;
    height = value.max.y - value.min.y;
  }
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  if (!finiteCoordinate(x) || !finiteCoordinate(y) || !finiteCoordinate(x + width) || !finiteCoordinate(y + height)) return null;
  const minX = normalized(x);
  const minY = normalized(y);
  const maxX = normalized(x + width);
  const maxY = normalized(y + height);
  if (maxX <= minX || maxY <= minY) return null;
  return { minX, minY, maxX, maxY };
}

function normalizedWall(wall: WallRecord): NormalizedWall | null {
  if (!wall || typeof wall.id !== 'string' || wall.id.length === 0 || wall.id.length > 128) return null;
  if (wall.type !== 'blocking' && wall.type !== 'terrain' && wall.type !== 'ethereal' && wall.type !== 'door') return null;
  if (wall.type === 'door' && wall.doorState !== 'open' && wall.doorState !== 'closed' && wall.doorState !== 'locked') return null;
  if (!validPoint(wall.start) || !validPoint(wall.end)) return null;
  if (!Number.isFinite(wall.height) || wall.height < 0 || wall.height > MAX_COORDINATE
    || !Number.isFinite(wall.thickness) || wall.thickness <= 0 || wall.thickness > MAX_COORDINATE
    || !finiteCoordinate(wall.elevation) || !Array.isArray(wall.openings)
    || wall.openings.length > MAX_VISIBILITY_OPENINGS_PER_WALL
    || wall.type === 'door' && wall.openings.length > 0) return null;
  const start = normalizedPoint(wall.start);
  const end = normalizedPoint(wall.end);
  if (segmentLengthSquared({ start, end }) <= 0) return null;
  let previousEnd = 0;
  for (const opening of wall.openings) {
    if (opening.type !== 'window' || ![opening.start, opening.end, opening.bottom, opening.height].every(Number.isFinite)
      || opening.start < 0 || opening.start >= opening.end || opening.end > 1
      || opening.bottom < 0 || opening.height <= 0 || opening.height > MAX_COORDINATE
      || opening.bottom + opening.height > wall.height || opening.start < previousEnd) return null;
    const openingStart = normalizedPoint({
      x: start.x + (end.x - start.x) * opening.start,
      y: start.y + (end.y - start.y) * opening.start,
    });
    const openingEnd = normalizedPoint({
      x: start.x + (end.x - start.x) * opening.end,
      y: start.y + (end.y - start.y) * opening.end,
    });
    if (openingStart.x === openingEnd.x && openingStart.y === openingEnd.y) return null;
    previousEnd = opening.end;
  }
  return { id: wall.id, start, end, openings: wall.openings, type: wall.type, ...(wall.type === 'door' ? { doorState: wall.doorState } : {}) };
}

function canonicalWalls(value: VisibilityInput['walls']): NormalizedWall[] | null {
  if (!value) return [];
  const records = Array.isArray(value) ? [...value] : Object.values(value);
  if (records.length > MAX_VISIBILITY_WALLS) return null;
  const ids = new Set<string>();
  const walls: NormalizedWall[] = [];
  for (const record of records) {
    const wall = normalizedWall(record);
    if (!wall || ids.has(wall.id)) return null;
    ids.add(wall.id);
    walls.push(wall);
  }
  walls.sort((first, second) => compareLexically(first.id, second.id));
  return walls;
}

function interpolate(segment: Segment, amount: number): Point {
  return {
    x: segment.start.x + (segment.end.x - segment.start.x) * amount,
    y: segment.start.y + (segment.end.y - segment.start.y) * amount,
  };
}

function clipSegmentToEffective(
  segment: Segment,
  source: Point,
  radius: number,
  bounds: NormalizedBounds,
  epsilon: number,
): Segment | null {
  const dx = segment.end.x - segment.start.x;
  const dy = segment.end.y - segment.start.y;
  let low = 0;
  let high = 1;
  const clipLinear = (coefficient: number, constant: number): boolean => {
    if (Math.abs(coefficient) <= epsilon) return constant >= -epsilon;
    const amount = -constant / coefficient;
    if (coefficient > 0) low = Math.max(low, amount);
    else high = Math.min(high, amount);
    return low <= high + epsilon;
  };
  if (!clipLinear(dx, segment.start.x - bounds.minX)
    || !clipLinear(-dx, bounds.maxX - segment.start.x)
    || !clipLinear(dy, segment.start.y - bounds.minY)
    || !clipLinear(-dy, bounds.maxY - segment.start.y)) return null;

  const offset = { x: segment.start.x - source.x, y: segment.start.y - source.y };
  const a = dx * dx + dy * dy;
  if (a <= epsilon * epsilon) return null;
  const b = 2 * (offset.x * dx + offset.y * dy);
  const c = offset.x * offset.x + offset.y * offset.y - radius * radius;
  const discriminant = b * b - 4 * a * c;
  if (discriminant < -epsilon) return null;
  if (discriminant < 0) {
    if (c > epsilon) return null;
  } else {
    const root = Math.sqrt(Math.max(0, discriminant));
    low = Math.max(low, (-b - root) / (2 * a));
    high = Math.min(high, (-b + root) / (2 * a));
  }
  if (low > high + epsilon) return null;
  const clipped = { start: normalizedPoint(interpolate(segment, Math.max(0, low))), end: normalizedPoint(interpolate(segment, Math.min(1, high))) };
  return segmentLengthSquared(clipped) <= epsilon * epsilon ? null : clipped;
}

function pointInEffective(point: Point, source: Point, radius: number, bounds: NormalizedBounds, epsilon: number): boolean {
  return point.x >= bounds.minX - epsilon && point.x <= bounds.maxX + epsilon
    && point.y >= bounds.minY - epsilon && point.y <= bounds.maxY + epsilon
    && distanceSquared(source, point) <= radius * radius + epsilon;
}

function addBlocker(blockers: VisibilityBlocker[], segment: Segment, key: string): boolean {
  if (!Number.isFinite(segment.start.x) || !Number.isFinite(segment.start.y) || !Number.isFinite(segment.end.x) || !Number.isFinite(segment.end.y)) return false;
  blockers.push({ segment, key });
  return blockers.length <= MAX_VISIBILITY_BLOCKERS;
}

function buildLocalBlockers(
  walls: readonly NormalizedWall[],
  source: Point,
  radius: number,
  bounds: NormalizedBounds,
  epsilon: number,
): VisibilityBlocker[] | null {
  const blockers: VisibilityBlocker[] = [];
  for (const wall of walls) {
    if (!wallBlocksVision(wall as WallRecord)) continue;
    const base: Segment = { start: wall.start, end: wall.end };
    const pieces = wall.openings.length ? segmentPartsOutsideOpenings(base, wall.openings) : [base];
    for (const [pieceIndex, piece] of pieces.entries()) {
      if (segmentLengthSquared(piece) <= epsilon * epsilon) continue;
      const clipped = clipSegmentToEffective(piece, source, radius, bounds, epsilon);
      if (clipped && !addBlocker(blockers, clipped, `${wall.id}:solid:${pieceIndex}`)) return null;
    }
    for (const [openingIndex, opening] of wall.openings.entries()) {
      const direction = { x: wall.end.x - wall.start.x, y: wall.end.y - wall.start.y };
      for (const [endpointIndex, amount] of [opening.start, opening.end].entries()) {
        const endpoint = normalizedPoint({ x: wall.start.x + direction.x * amount, y: wall.start.y + direction.y * amount });
        if (pointInEffective(endpoint, source, radius, bounds, epsilon)
          && !addBlocker(blockers, { start: endpoint, end: endpoint }, `${wall.id}:jamb:${openingIndex}:${endpointIndex}`)) return null;
      }
    }
  }
  return blockers;
}

function angleOf(source: Point, point: Point): number {
  const angle = Math.atan2(point.y - source.y, point.x - source.x);
  return angle < 0 ? angle + Math.PI * 2 : angle;
}

function rayBoundaryDistance(source: Point, direction: Point, bounds: NormalizedBounds, epsilon: number): number {
  let nearest = Number.POSITIVE_INFINITY;
  for (const x of [bounds.minX, bounds.maxX]) {
    if (Math.abs(direction.x) <= epsilon) continue;
    const distance = (x - source.x) / direction.x;
    const y = source.y + direction.y * distance;
    const outwardAtEdge = Math.abs(x - source.x) <= epsilon
      && (x === bounds.minX && direction.x < 0 || x === bounds.maxX && direction.x > 0);
    if (distance >= -epsilon && (distance > epsilon || outwardAtEdge)
      && y >= bounds.minY - epsilon && y <= bounds.maxY + epsilon) nearest = Math.min(nearest, Math.max(0, distance));
  }
  for (const y of [bounds.minY, bounds.maxY]) {
    if (Math.abs(direction.y) <= epsilon) continue;
    const distance = (y - source.y) / direction.y;
    const x = source.x + direction.x * distance;
    const outwardAtEdge = Math.abs(y - source.y) <= epsilon
      && (y === bounds.minY && direction.y < 0 || y === bounds.maxY && direction.y > 0);
    if (distance >= -epsilon && (distance > epsilon || outwardAtEdge)
      && x >= bounds.minX - epsilon && x <= bounds.maxX + epsilon) nearest = Math.min(nearest, Math.max(0, distance));
  }
  return nearest;
}

function rayBlockerDistance(source: Point, direction: Point, segment: Segment, epsilon: number): number | null {
  const edge = { x: segment.end.x - segment.start.x, y: segment.end.y - segment.start.y };
  const relative = { x: segment.start.x - source.x, y: segment.start.y - source.y };
  const cross = (first: Point, second: Point): number => first.x * second.y - first.y * second.x;
  const dot = (first: Point, second: Point): number => first.x * second.x + first.y * second.y;
  const crossEpsilon = segmentTolerance(segment, epsilon);
  if (segmentLengthSquared(segment) <= epsilon * epsilon) {
    if (Math.abs(cross(relative, direction)) > crossEpsilon) return null;
    const distance = dot(relative, direction);
    return distance >= -epsilon ? Math.max(0, distance) : null;
  }
  const denominator = cross(direction, edge);
  if (Math.abs(denominator) <= crossEpsilon) {
    if (Math.abs(cross(relative, direction)) > crossEpsilon) return null;
    const first = dot(relative, direction);
    const second = dot({ x: segment.end.x - source.x, y: segment.end.y - source.y }, direction);
    const distance = Math.min(first, second);
    return Math.max(first, second) >= -epsilon ? Math.max(0, distance) : null;
  }
  const distance = cross(relative, edge) / denominator;
  const amount = cross(relative, direction) / denominator;
  if (distance < -epsilon || amount < -epsilon || amount > 1 + epsilon) return null;
  return Math.max(0, distance);
}

function eventPointInEffective(point: Point, source: Point, radius: number, bounds: NormalizedBounds, epsilon: number): boolean {
  return pointInEffective(normalizedPoint(point), source, radius, bounds, epsilon);
}

function fixedRangeVertices(source: Point, radius: number): Point[] {
  return Array.from({ length: RANGE_EDGE_COUNT }, (_, index) => {
    // Half-step orientation keeps the fixed boundary conservative at the
    // cardinal/event directions instead of placing a vertex on them.
    const angle = (index + 0.5) / RANGE_EDGE_COUNT * Math.PI * 2;
    return normalizedPoint({ x: source.x + Math.cos(angle) * radius, y: source.y + Math.sin(angle) * radius });
  });
}

function fixedRangeDistance(source: Point, direction: Point, radius: number, epsilon: number): number {
  const vertices = fixedRangeVertices(source, radius);
  let nearest = Number.POSITIVE_INFINITY;
  for (let index = 0; index < vertices.length; index++) {
    const hit = rayBlockerDistance(source, direction, {
      start: vertices[index]!, end: vertices[(index + 1) % vertices.length]!,
    }, epsilon);
    if (hit !== null) nearest = Math.min(nearest, hit);
  }
  return nearest;
}

function fixedRangeMapIntersections(source: Point, radius: number, bounds: NormalizedBounds, epsilon: number): Point[] {
  const vertices = fixedRangeVertices(source, radius);
  const mapEdges: Segment[] = [
    { start: { x: bounds.minX, y: bounds.minY }, end: { x: bounds.maxX, y: bounds.minY } },
    { start: { x: bounds.maxX, y: bounds.minY }, end: { x: bounds.maxX, y: bounds.maxY } },
    { start: { x: bounds.maxX, y: bounds.maxY }, end: { x: bounds.minX, y: bounds.maxY } },
    { start: { x: bounds.minX, y: bounds.maxY }, end: { x: bounds.minX, y: bounds.minY } },
  ];
  const points: Point[] = [];
  for (let firstIndex = 0; firstIndex < vertices.length; firstIndex++) {
    const rangeEdge = { start: vertices[firstIndex]!, end: vertices[(firstIndex + 1) % vertices.length]! };
    for (let secondIndex = 0; secondIndex < mapEdges.length; secondIndex++) {
      const intersection = segmentIntersection(rangeEdge, mapEdges[secondIndex]!, pairTolerance(rangeEdge, mapEdges[secondIndex]!, epsilon));
      if (intersection.kind === 'point') points.push(normalizedPoint(intersection.point));
      else if (intersection.kind === 'overlap') {
        points.push(normalizedPoint(intersection.start), normalizedPoint(intersection.end));
      }
    }
  }
  return points;
}

function pushEvent(events: SweepEvent[], point: Point, key: string, source: Point, radius: number, bounds: NormalizedBounds, epsilon: number): boolean {
  const normalizedPointValue = normalizedPoint(point);
  if (normalizedPointValue.x === source.x && normalizedPointValue.y === source.y) return true;
  if (!eventPointInEffective(normalizedPointValue, source, radius, bounds, epsilon)) return true;
  events.push({ point: normalizedPointValue, angle: angleOf(source, normalizedPointValue), key });
  return events.length <= MAX_VISIBILITY_EVENTS;
}

function intersectionEvents(
  blockers: readonly VisibilityBlocker[],
  source: Point,
  radius: number,
  bounds: NormalizedBounds,
  epsilon: number,
  events: SweepEvent[],
): boolean {
  for (let firstIndex = 0; firstIndex < blockers.length; firstIndex++) {
    for (let secondIndex = firstIndex + 1; secondIndex < blockers.length; secondIndex++) {
      const intersection: SegmentIntersection = segmentIntersection(
        blockers[firstIndex]!.segment,
        blockers[secondIndex]!.segment,
        pairTolerance(blockers[firstIndex]!.segment, blockers[secondIndex]!.segment, epsilon),
      );
      if (intersection.kind === 'none') continue;
      const firstKey = `${blockers[firstIndex]!.key}|${blockers[secondIndex]!.key}`;
      if (intersection.kind === 'point') {
        if (!pushEvent(events, intersection.point, `intersection:${firstKey}`, source, radius, bounds, epsilon)) return false;
      } else {
        if (!pushEvent(events, intersection.start, `intersection:${firstKey}:start`, source, radius, bounds, epsilon)
          || !pushEvent(events, intersection.end, `intersection:${firstKey}:end`, source, radius, bounds, epsilon)) return false;
      }
    }
  }
  return true;
}

function eventAngles(events: readonly SweepEvent[], epsilon: number, radius: number): number[] | null {
  // This is the rotational sweep: event rays are ordered lexically, and each
  // open angular interval uses one stable active-blocker query. Pairwise
  // intersections are events so the nearest active blocker cannot silently
  // change inside an interval.
  const ordered = [...events].sort((first, second) => first.angle - second.angle
    || compareLexically(first.key, second.key)
    || first.point.x - second.point.x || first.point.y - second.point.y);
  const angles: number[] = [];
  const angularEpsilon = Math.max(MIN_EPSILON, epsilon / Math.max(1, radius));
  for (const event of ordered) {
    const previous = angles[angles.length - 1];
    if (previous === undefined || Math.abs(event.angle - previous) > angularEpsilon) angles.push(event.angle);
  }
  if (angles.length < 3 || angles.length > MAX_VISIBILITY_POINTS) return null;
  return angles;
}

function nearestDistance(
  angle: number,
  source: Point,
  radius: number,
  bounds: NormalizedBounds,
  blockers: readonly VisibilityBlocker[],
  epsilon: number,
): number {
  const direction = { x: Math.cos(angle), y: Math.sin(angle) };
  let nearest = Math.min(
    rayBoundaryDistance(source, direction, bounds, epsilon),
    fixedRangeDistance(source, direction, radius, epsilon),
  );
  let nearestKey = '';
  for (const blocker of blockers) {
    const hit = rayBlockerDistance(source, direction, blocker.segment, epsilon);
    if (hit === null) continue;
    if (hit < nearest - epsilon || Math.abs(hit - nearest) <= epsilon && (nearestKey === '' || compareLexically(blocker.key, nearestKey) < 0)) {
      nearest = hit;
      nearestKey = blocker.key;
    }
  }
  return nearest;
}

function pointAtAngle(
  angle: number,
  source: Point,
  radius: number,
  bounds: NormalizedBounds,
  blockers: readonly VisibilityBlocker[],
  epsilon: number,
): Point | null {
  const distance = nearestDistance(angle, source, radius, bounds, blockers, epsilon);
  if (!Number.isFinite(distance) || distance <= epsilon) return null;
  return normalizedPoint({ x: source.x + Math.cos(angle) * distance, y: source.y + Math.sin(angle) * distance });
}

function simpleRing(points: readonly Point[], epsilon: number): boolean {
  if (points.length < 3) return false;
  for (let first = 0; first < points.length; first++) {
    const firstSegment = { start: points[first]!, end: points[(first + 1) % points.length]! };
    for (let second = first + 1; second < points.length; second++) {
      if (second === first || second === (first + 1) % points.length || (first === 0 && second === points.length - 1)) continue;
      const secondSegment = { start: points[second]!, end: points[(second + 1) % points.length]! };
      const intersection = segmentIntersection(firstSegment, secondSegment, pairTolerance(firstSegment, secondSegment, epsilon));
      if (intersection.kind !== 'none') return false;
    }
  }
  return true;
}

function canonicalize(points: Point[], epsilon: number): Point[] {
  const unique: Point[] = [];
  for (const point of points) {
    const candidate = normalizedPoint(point);
    if (!Number.isFinite(candidate.x) || !Number.isFinite(candidate.y)) return emptyPolygon();
    const previous = unique[unique.length - 1];
    if (!previous || previous.x !== candidate.x || previous.y !== candidate.y) unique.push(candidate);
  }
  if (unique.length > 1 && unique[0]!.x === unique[unique.length - 1]!.x && unique[0]!.y === unique[unique.length - 1]!.y) unique.pop();
  if (unique.length < 3) return emptyPolygon();
  let twiceArea = 0;
  for (let index = 0; index < unique.length; index++) {
    const current = unique[index]!;
    const next = unique[(index + 1) % unique.length]!;
    twiceArea += current.x * next.y - next.x * current.y;
  }
  if (Math.abs(twiceArea) <= epsilon) return emptyPolygon();
  if (twiceArea < 0) unique.reverse();
  if (!simpleRing(unique, epsilon)) return emptyPolygon();
  let start = 0;
  for (let index = 1; index < unique.length; index++) {
    const candidate = unique[index]!;
    const current = unique[start]!;
    if (candidate.x < current.x || candidate.x === current.x && candidate.y < current.y) start = index;
  }
  return [...unique.slice(start), ...unique.slice(0, start)];
}

function solve(input: VisibilityInput): Point[] {
  if (!validPoint(input.source)) return emptyPolygon();
  const bounds = normalizeBounds(input.mapBounds ?? input.bounds);
  const cellSize = input.cellSize ?? input.gridCellSize;
  const rangeCells = input.rangeCells ?? DEFAULT_VISION_RADIUS_CELLS;
  if (!bounds || cellSize === undefined || !Number.isFinite(cellSize) || cellSize <= 0 || cellSize > MAX_COORDINATE
    || !Number.isFinite(rangeCells) || rangeCells < 0 || rangeCells > MAX_RANGE_CELLS) return emptyPolygon();
  const source = normalizedPoint(input.source);
  const radius = normalized(rangeCells * cellSize);
  if (!Number.isFinite(radius) || radius <= 0 || radius > MAX_EFFECTIVE_RADIUS) return emptyPolygon();
  const epsilon = epsilonFor(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY, radius);
  if (!pointInEffective(source, source, radius, bounds, epsilon)) return emptyPolygon();
  const walls = canonicalWalls(input.walls ?? input.canonicalWalls);
  if (!walls) return emptyPolygon();
  // This check is intentionally before clipping: the source on a solid line is
  // invalid even when a later map/range clip would remove most of that wall.
  for (const wall of walls) {
    if (!wallBlocksVision(wall as WallRecord)) continue;
    const base: Segment = { start: wall.start, end: wall.end };
    const pieces = wall.openings.length ? segmentPartsOutsideOpenings(base, wall.openings) : [base];
    for (const piece of pieces) if (pointOnSegment(source, piece, segmentTolerance(piece, epsilon))) return emptyPolygon();
    for (const opening of wall.openings) {
      const direction = { x: wall.end.x - wall.start.x, y: wall.end.y - wall.start.y };
      for (const amount of [opening.start, opening.end]) {
        const endpoint = { x: wall.start.x + direction.x * amount, y: wall.start.y + direction.y * amount };
        if (pointOnSegment(source, { start: endpoint, end: endpoint }, epsilon)) return emptyPolygon();
      }
    }
  }
  const blockers = buildLocalBlockers(walls, source, radius, bounds, epsilon);
  if (!blockers) return emptyPolygon();

  const events: SweepEvent[] = [];
  const addEvent = (point: Point, key: string): boolean => pushEvent(events, point, key, source, radius, bounds, epsilon);
  for (const corner of [
    { x: bounds.minX, y: bounds.minY }, { x: bounds.maxX, y: bounds.minY },
    { x: bounds.maxX, y: bounds.maxY }, { x: bounds.minX, y: bounds.maxY },
  ]) if (!addEvent(corner, `map:corner:${corner.x},${corner.y}`)) return emptyPolygon();
  for (const point of fixedRangeMapIntersections(source, radius, bounds, epsilon)) if (!addEvent(point, `map:range:${point.x},${point.y}`)) return emptyPolygon();
  for (let index = 0; index < RANGE_EDGE_COUNT; index++) {
    const angle = (index + 0.5) / RANGE_EDGE_COUNT * Math.PI * 2;
    // Keep all fixed-boundary vertices as events. Endpoint/intersection events
    // may subdivide an edge, but cannot change its straight geometry.
    const point = normalizedPoint({ x: source.x + Math.cos(angle) * radius, y: source.y + Math.sin(angle) * radius });
    events.push({ point, angle, key: `range:${index}` });
    if (events.length > MAX_VISIBILITY_EVENTS) return emptyPolygon();
  }
  for (const blocker of blockers) {
    if (!addEvent(blocker.segment.start, `${blocker.key}:start`) || !addEvent(blocker.segment.end, `${blocker.key}:end`)) return emptyPolygon();
  }
  if (!intersectionEvents(blockers, source, radius, bounds, epsilon, events)) return emptyPolygon();
  const angles = eventAngles(events, epsilon, radius);
  if (!angles) return emptyPolygon();

  const points: Point[] = [];
  for (let index = 0; index < angles.length; index++) {
    const current = angles[index]!;
    const next = angles[(index + 1) % angles.length]! + (index + 1 === angles.length ? Math.PI * 2 : 0);
    const currentPoint = pointAtAngle(current, source, radius, bounds, blockers, epsilon);
    const middlePoint = pointAtAngle((current + next) / 2, source, radius, bounds, blockers, epsilon);
    if (currentPoint) points.push(currentPoint);
    if (middlePoint) points.push(middlePoint);
    if (points.length > MAX_VISIBILITY_POINTS) return emptyPolygon();
  }
  return canonicalize(points, epsilon);
}

export function computeVisibilityPolygon(input: VisibilityInput): Point[];
export function computeVisibilityPolygon(
  source: Point,
  mapBounds: VisibilityMapBounds,
  cellSize: number,
  walls: readonly WallRecord[] | Readonly<Record<string, WallRecord>>,
  rangeCells?: number,
): Point[];
export function computeVisibilityPolygon(
  inputOrSource: VisibilityInput | Point,
  mapBounds?: VisibilityMapBounds,
  cellSize?: number,
  walls?: readonly WallRecord[] | Readonly<Record<string, WallRecord>>,
  rangeCells?: number,
): Point[] {
  const input: VisibilityInput = 'source' in inputOrSource
    ? inputOrSource as VisibilityInput
    : { source: inputOrSource, mapBounds, cellSize, walls, rangeCells };
  return solve(input);
}

/** Alias emphasizing that the output is a single canonical ring. */
export const deriveVisibilityPolygon = computeVisibilityPolygon;
/** Short solver name for callers that already know the projection is 2D. */
export const solveVisibility = computeVisibilityPolygon;
