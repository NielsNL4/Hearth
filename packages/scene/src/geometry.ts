import type { Point, Size, TokenRecord, WallRecord } from './types.js';

const DEFAULT_EPSILON = 1e-9;

export interface CameraView {
  x: number;
  y: number;
  zoom: number;
}

export interface Segment {
  start: Point;
  end: Point;
}

export interface NormalizedInterval {
  start: number;
  end: number;
}

export type SegmentIntersection =
  | { kind: 'none' }
  | { kind: 'point'; point: Point }
  | { kind: 'overlap'; start: Point; end: Point };

export interface WallShapeInput {
  contour: [Point, Point, Point, Point];
  depth: number;
  elevation: number;
}

/** Semantic part roles consumed by a renderer; geometry remains renderer-neutral. */
export const WallMeshPartRole = {
  Wall: 'wall',
  Door: 'door',
  Segment: 'segment',
  WindowJamb: 'window-jamb',
  WindowSill: 'window-sill',
  WindowLintel: 'window-lintel',
} as const;
export type WallMeshPartRole = (typeof WallMeshPartRole)[keyof typeof WallMeshPartRole];

/** A deterministic prism input in the scene's x-right/y-down coordinate system. */
export interface WallMeshInput extends WallShapeInput {
  wallId: string;
  partId: string;
  role: WallMeshPartRole;
  material: WallRecord['material'];
  openingIndex?: number;
}

function assertFinitePoint(point: Point, name: string): void {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) throw new RangeError(`${name} must be finite.`);
}

function assertViewport(viewport: Size): void {
  if (!Number.isFinite(viewport.width) || viewport.width <= 0 || !Number.isFinite(viewport.height) || viewport.height <= 0) {
    throw new RangeError('Viewport dimensions must be positive and finite.');
  }
}

function assertView(view: CameraView): void {
  if (!Number.isFinite(view.x) || !Number.isFinite(view.y) || !Number.isFinite(view.zoom) || view.zoom <= 0) {
    throw new RangeError('Camera values must be finite and zoom must be positive.');
  }
}

function cross(a: Point, b: Point): number { return a.x * b.y - a.y * b.x; }
function dot(a: Point, b: Point): number { return a.x * b.x + a.y * b.y; }
function subtract(a: Point, b: Point): Point { return { x: a.x - b.x, y: a.y - b.y }; }
function interpolate(segment: Segment, amount: number): Point {
  return {
    x: segment.start.x + (segment.end.x - segment.start.x) * amount,
    y: segment.start.y + (segment.end.y - segment.start.y) * amount,
  };
}

export function worldToScreen(point: Point, view: CameraView, viewport: Size): Point {
  assertFinitePoint(point, 'World point'); assertView(view); assertViewport(viewport);
  return { x: (point.x - view.x) * view.zoom + viewport.width / 2, y: (point.y - view.y) * view.zoom + viewport.height / 2 };
}

export function screenToWorld(point: Point, view: CameraView, viewport: Size): Point {
  assertFinitePoint(point, 'Screen point'); assertView(view); assertViewport(viewport);
  return { x: view.x + (point.x - viewport.width / 2) / view.zoom, y: view.y + (point.y - viewport.height / 2) / view.zoom };
}

export function zoomViewAtScreenPoint(view: CameraView, screenPoint: Point, zoom: number, viewport: Size): CameraView {
  if (!Number.isFinite(zoom) || zoom <= 0) throw new RangeError('Zoom must be positive and finite.');
  const anchor = screenToWorld(screenPoint, view, viewport);
  return {
    x: anchor.x - (screenPoint.x - viewport.width / 2) / zoom,
    y: anchor.y - (screenPoint.y - viewport.height / 2) / zoom,
    zoom,
  };
}

export function worldToGrid(point: Point, cellSize: number, offset: Point = { x: 0, y: 0 }): Point {
  assertFinitePoint(point, 'World point'); assertFinitePoint(offset, 'Grid offset');
  if (!Number.isFinite(cellSize) || cellSize <= 0) throw new RangeError('Cell size must be positive and finite.');
  return { x: (point.x - offset.x) / cellSize, y: (point.y - offset.y) / cellSize };
}

export function gridToWorld(point: Point, cellSize: number, offset: Point = { x: 0, y: 0 }): Point {
  assertFinitePoint(point, 'Grid point'); assertFinitePoint(offset, 'Grid offset');
  if (!Number.isFinite(cellSize) || cellSize <= 0) throw new RangeError('Cell size must be positive and finite.');
  return { x: offset.x + point.x * cellSize, y: offset.y + point.y * cellSize };
}

export function snapPointToCellCenter(point: Point, cellSize: number, offset: Point = { x: 0, y: 0 }): Point {
  const grid = worldToGrid(point, cellSize, offset);
  return gridToWorld({ x: Math.floor(grid.x) + 0.5, y: Math.floor(grid.y) + 0.5 }, cellSize, offset);
}

export function segmentIntersection(first: Segment, second: Segment, epsilon = DEFAULT_EPSILON): SegmentIntersection {
  assertFinitePoint(first.start, 'Segment start'); assertFinitePoint(first.end, 'Segment end');
  assertFinitePoint(second.start, 'Segment start'); assertFinitePoint(second.end, 'Segment end');
  if (!Number.isFinite(epsilon) || epsilon < 0) throw new RangeError('Epsilon must be finite and non-negative.');
  const r = subtract(first.end, first.start);
  const s = subtract(second.end, second.start);
  const qMinusP = subtract(second.start, first.start);
  const rLengthSquared = dot(r, r);
  const sLengthSquared = dot(s, s);
  if (rLengthSquared <= epsilon * epsilon) {
    if (sLengthSquared <= epsilon * epsilon) {
      return distanceBetween(first.start, second.start) <= epsilon ? { kind: 'point', point: { ...first.start } } : { kind: 'none' };
    }
    return pointOnSegment(first.start, second, epsilon) ? { kind: 'point', point: { ...first.start } } : { kind: 'none' };
  }
  if (sLengthSquared <= epsilon * epsilon) {
    return pointOnSegment(second.start, first, epsilon) ? { kind: 'point', point: { ...second.start } } : { kind: 'none' };
  }
  const denominator = cross(r, s);
  if (Math.abs(denominator) <= epsilon) {
    if (Math.abs(cross(qMinusP, r)) > epsilon) return { kind: 'none' };
    const start = dot(qMinusP, r) / rLengthSquared;
    const end = start + dot(s, r) / rLengthSquared;
    const low = Math.max(0, Math.min(start, end));
    const high = Math.min(1, Math.max(start, end));
    if (low > high + epsilon) return { kind: 'none' };
    if (Math.abs(low - high) <= epsilon) return { kind: 'point', point: interpolate(first, (low + high) / 2) };
    return { kind: 'overlap', start: interpolate(first, low), end: interpolate(first, high) };
  }
  const firstAmount = cross(qMinusP, s) / denominator;
  const secondAmount = cross(qMinusP, r) / denominator;
  if (firstAmount < -epsilon || firstAmount > 1 + epsilon || secondAmount < -epsilon || secondAmount > 1 + epsilon) return { kind: 'none' };
  return { kind: 'point', point: interpolate(first, Math.max(0, Math.min(1, firstAmount))) };
}

export function pointOnSegment(point: Point, segment: Segment, epsilon = DEFAULT_EPSILON): boolean {
  assertFinitePoint(point, 'Point'); assertFinitePoint(segment.start, 'Segment start'); assertFinitePoint(segment.end, 'Segment end');
  const direction = subtract(segment.end, segment.start);
  const relative = subtract(point, segment.start);
  if (dot(direction, direction) <= epsilon * epsilon) return distanceBetween(point, segment.start) <= epsilon;
  if (Math.abs(cross(direction, relative)) > epsilon) return false;
  return dot(relative, direction) >= -epsilon && dot(relative, direction) <= dot(direction, direction) + epsilon;
}

export function pointInPolygon(point: Point, polygon: readonly Point[], epsilon = DEFAULT_EPSILON): boolean {
  assertFinitePoint(point, 'Point');
  if (polygon.length < 3) return false;
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index++) {
    const start = polygon[previous]!;
    const end = polygon[index]!;
    if (pointOnSegment(point, { start, end }, epsilon)) return true;
    if ((start.y > point.y) !== (end.y > point.y) && point.x < (end.x - start.x) * (point.y - start.y) / (end.y - start.y) + start.x) inside = !inside;
  }
  return inside;
}

export function polygonArea(polygon: readonly Point[]): number {
  if (polygon.length < 3) return 0;
  let twiceArea = 0;
  for (let index = 0; index < polygon.length; index++) {
    const point = polygon[index]!;
    const next = polygon[(index + 1) % polygon.length]!;
    assertFinitePoint(point, 'Polygon point');
    twiceArea += point.x * next.y - next.x * point.y;
  }
  return Math.abs(twiceArea) / 2;
}

export function rectanglePolygon(start: Point, end: Point): Point[] {
  assertFinitePoint(start, 'Rectangle start'); assertFinitePoint(end, 'Rectangle end');
  return [{ ...start }, { x: end.x, y: start.y }, { ...end }, { x: start.x, y: end.y }];
}

export function ellipsePolygon(start: Point, end: Point, segments = 32): Point[] {
  assertFinitePoint(start, 'Ellipse start'); assertFinitePoint(end, 'Ellipse end');
  if (!Number.isInteger(segments) || segments < 8 || segments > 256) throw new RangeError('Ellipse segments must be an integer from 8 through 256.');
  const center = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
  const radius = { x: Math.abs(end.x - start.x) / 2, y: Math.abs(end.y - start.y) / 2 };
  return Array.from({ length: segments }, (_, index) => {
    const angle = index / segments * Math.PI * 2;
    return { x: center.x + Math.cos(angle) * radius.x, y: center.y + Math.sin(angle) * radius.y };
  });
}

function pointSegmentDistance(point: Point, start: Point, end: Point): number {
  const segment = subtract(end, start);
  const lengthSquared = dot(segment, segment);
  if (lengthSquared === 0) return distanceBetween(point, start);
  const amount = Math.max(0, Math.min(1, dot(subtract(point, start), segment) / lengthSquared));
  return distanceBetween(point, { x: start.x + segment.x * amount, y: start.y + segment.y * amount });
}

export function simplifyPolyline(points: readonly Point[], tolerance: number): Point[] {
  if (!Number.isFinite(tolerance) || tolerance < 0) throw new RangeError('Polyline tolerance must be finite and non-negative.');
  if (points.length <= 2) return points.map((point) => ({ ...point }));
  let farthestIndex = 0;
  let farthestDistance = 0;
  for (let index = 1; index < points.length - 1; index++) {
    const distance = pointSegmentDistance(points[index]!, points[0]!, points[points.length - 1]!);
    if (distance > farthestDistance) { farthestDistance = distance; farthestIndex = index; }
  }
  if (farthestDistance <= tolerance) return [{ ...points[0]! }, { ...points[points.length - 1]! }];
  const before = simplifyPolyline(points.slice(0, farthestIndex + 1), tolerance);
  const after = simplifyPolyline(points.slice(farthestIndex), tolerance);
  return [...before.slice(0, -1), ...after];
}

export type DiagonalDistanceRule = 'euclidean' | 'manhattan' | 'five-ten-five';

export function measureGridDistance(
  start: Point,
  end: Point,
  cellSize: number,
  distancePerCell: number,
  rule: DiagonalDistanceRule,
): { cells: number; distance: number } {
  assertFinitePoint(start, 'Measurement start'); assertFinitePoint(end, 'Measurement end');
  if (!Number.isFinite(cellSize) || cellSize <= 0 || !Number.isFinite(distancePerCell) || distancePerCell <= 0) {
    throw new RangeError('Grid measurement scales must be positive and finite.');
  }
  const horizontal = Math.abs(end.x - start.x) / cellSize;
  const vertical = Math.abs(end.y - start.y) / cellSize;
  let cells: number;
  if (rule === 'euclidean') cells = Math.hypot(horizontal, vertical);
  else if (rule === 'manhattan') cells = horizontal + vertical;
  else {
    const diagonal = Math.min(Math.round(horizontal), Math.round(vertical));
    const straight = Math.max(Math.round(horizontal), Math.round(vertical)) - diagonal;
    cells = straight + diagonal + Math.floor(diagonal / 2);
  }
  return { cells, distance: cells * distancePerCell };
}

export function hitTestRotatedToken(point: Point, token: Pick<TokenRecord, 'position' | 'size' | 'rotation'>): boolean {
  assertFinitePoint(point, 'Point'); assertFinitePoint(token.position, 'Token position');
  if (!Number.isFinite(token.size.width) || token.size.width <= 0 || !Number.isFinite(token.size.height) || token.size.height <= 0) return false;
  const radians = token.rotation * Math.PI / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const delta = subtract(point, token.position);
  const local = { x: delta.x * cosine + delta.y * sine, y: -delta.x * sine + delta.y * cosine };
  return Math.abs(local.x) <= token.size.width / 2 + DEFAULT_EPSILON && Math.abs(local.y) <= token.size.height / 2 + DEFAULT_EPSILON;
}

export function raySegmentIntersection(origin: Point, direction: Point, segment: Segment, epsilon = DEFAULT_EPSILON): { point: Point; distance: number } | null {
  assertFinitePoint(origin, 'Ray origin'); assertFinitePoint(direction, 'Ray direction');
  const length = Math.hypot(direction.x, direction.y);
  if (length <= epsilon) throw new RangeError('Ray direction must have length.');
  const ray = { x: direction.x / length, y: direction.y / length };
  const edge = subtract(segment.end, segment.start);
  const denominator = cross(ray, edge);
  if (Math.abs(denominator) <= epsilon) return null;
  const relative = subtract(segment.start, origin);
  const distance = cross(relative, edge) / denominator;
  const edgeAmount = cross(relative, ray) / denominator;
  if (distance < -epsilon || edgeAmount < -epsilon || edgeAmount > 1 + epsilon) return null;
  return { point: { x: origin.x + ray.x * distance, y: origin.y + ray.y * distance }, distance: Math.max(0, distance) };
}

export function castRayAgainstSegments(origin: Point, direction: Point, segments: readonly Segment[]): { point: Point; distance: number; segmentIndex: number } | null {
  let nearest: { point: Point; distance: number; segmentIndex: number } | null = null;
  segments.forEach((segment, segmentIndex) => {
    const hit = raySegmentIntersection(origin, direction, segment);
    if (hit && (!nearest || hit.distance < nearest.distance)) nearest = { ...hit, segmentIndex };
  });
  return nearest;
}

export function normalizeOpeningIntervals(intervals: readonly NormalizedInterval[]): NormalizedInterval[] {
  const ordered = intervals.map(({ start, end }) => {
    if (!Number.isFinite(start) || !Number.isFinite(end)) throw new RangeError('Opening intervals must be finite.');
    return { start: Math.max(0, Math.min(1, Math.min(start, end))), end: Math.max(0, Math.min(1, Math.max(start, end))) };
  }).filter((interval) => interval.end - interval.start > DEFAULT_EPSILON).sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: NormalizedInterval[] = [];
  for (const interval of ordered) {
    const previous = merged[merged.length - 1];
    if (previous && interval.start <= previous.end + DEFAULT_EPSILON) previous.end = Math.max(previous.end, interval.end);
    else merged.push({ ...interval });
  }
  return merged;
}

export function segmentPartsOutsideOpenings(segment: Segment, openings: readonly NormalizedInterval[]): Segment[] {
  const normalized = normalizeOpeningIntervals(openings);
  const parts: Segment[] = [];
  let start = 0;
  for (const opening of normalized) {
    if (opening.start > start) parts.push({ start: interpolate(segment, start), end: interpolate(segment, opening.start) });
    start = Math.max(start, opening.end);
  }
  if (start < 1) parts.push({ start: interpolate(segment, start), end: interpolate(segment, 1) });
  return parts;
}

export function connectedWallComponents(walls: readonly WallRecord[], epsilon = DEFAULT_EPSILON): string[][] {
  const remaining = new Set(walls.map((wall) => wall.id));
  const byId = new Map(walls.map((wall) => [wall.id, wall]));
  const components: string[][] = [];
  while (remaining.size) {
    const seed = remaining.values().next().value as string;
    const queue = [seed];
    const component: string[] = [];
    remaining.delete(seed);
    while (queue.length) {
      const currentId = queue.shift()!;
      const current = byId.get(currentId)!;
      component.push(currentId);
      for (const candidateId of remaining) {
        const candidate = byId.get(candidateId)!;
        const connected = [current.start, current.end].some((a) => [candidate.start, candidate.end].some((b) => distanceBetween(a, b) <= epsilon));
        if (connected) { remaining.delete(candidateId); queue.push(candidateId); }
      }
    }
    components.push(component.sort());
  }
  return components.sort((a, b) => a[0]!.localeCompare(b[0]!));
}

export type WallEndpoint = 'start' | 'end';

export interface WallEndpointSnapResult {
  point: Point;
  wallId: string | null;
  endpoint: WallEndpoint | null;
  distance: number | null;
}

export interface WallSegmentHitResult {
  wallId: string;
  point: Point;
  distance: number;
}

function assertTolerance(tolerance: number): void {
  if (!Number.isFinite(tolerance) || tolerance < 0) throw new RangeError('Wall edit tolerance must be finite and non-negative.');
}

function compareStrings(first: string, second: string): number {
  return first < second ? -1 : first > second ? 1 : 0;
}

function closestPointOnSegment(point: Point, start: Point, end: Point): { point: Point; distance: number } {
  assertFinitePoint(point, 'Point');
  assertFinitePoint(start, 'Segment start');
  assertFinitePoint(end, 'Segment end');
  const segment = subtract(end, start);
  const lengthSquared = dot(segment, segment);
  if (lengthSquared === 0) return { point: { ...start }, distance: distanceBetween(point, start) };
  const amount = Math.max(0, Math.min(1, dot(subtract(point, start), segment) / lengthSquared));
  const closest = { x: start.x + segment.x * amount, y: start.y + segment.y * amount };
  return { point: closest, distance: distanceBetween(point, closest) };
}

/** Finds the nearest existing wall endpoint without mutating the target or walls. */
export function snapWallEndpoint(target: Point, walls: readonly WallRecord[], tolerance: number): WallEndpointSnapResult {
  assertFinitePoint(target, 'Target point');
  assertTolerance(tolerance);
  let nearest: WallEndpointSnapResult | null = null;
  for (const wall of walls) {
    for (const endpoint of ['start', 'end'] as const) {
      const point = wall[endpoint];
      assertFinitePoint(point, `Wall ${wall.id} ${endpoint}`);
      const distance = distanceBetween(target, point);
      const candidate = { point: { ...point }, wallId: wall.id, endpoint, distance } satisfies WallEndpointSnapResult;
      const winsTie = nearest !== null && distance === nearest.distance! && (compareStrings(wall.id, nearest.wallId ?? '') < 0
        || (wall.id === nearest.wallId && endpoint === 'start' && nearest.endpoint === 'end'));
      if (distance <= tolerance && (nearest === null || distance < nearest.distance! || winsTie)) nearest = candidate;
    }
  }
  return nearest ?? { point: { ...target }, wallId: null, endpoint: null, distance: null };
}

/** Returns the nearest wall segment hit within tolerance, using wall ID for ties. */
export function hitTestWallSegments(point: Point, walls: readonly WallRecord[], tolerance: number): WallSegmentHitResult | null {
  assertFinitePoint(point, 'Point');
  assertTolerance(tolerance);
  let nearest: WallSegmentHitResult | null = null;
  for (const wall of walls) {
    const hit = closestPointOnSegment(point, wall.start, wall.end);
    if (hit.distance > tolerance) continue;
    if (nearest === null || hit.distance < nearest.distance || (hit.distance === nearest.distance && compareStrings(wall.id, nearest.wallId) < 0)) {
      nearest = { wallId: wall.id, point: hit.point, distance: hit.distance };
    }
  }
  return nearest;
}

export function wallToShapeInput(wall: WallRecord): WallShapeInput {
  return {
    contour: wallContour(wall, 0, 1),
    depth: wall.height,
    elevation: wall.elevation,
  };
}

function wallContour(wall: WallRecord, start: number, end: number): [Point, Point, Point, Point] {
  const segmentStart = interpolate({ start: wall.start, end: wall.end }, start);
  const segmentEnd = interpolate({ start: wall.start, end: wall.end }, end);
  const direction = subtract(wall.end, wall.start);
  const length = Math.hypot(direction.x, direction.y);
  if (length <= DEFAULT_EPSILON) throw new RangeError('A wall must have length to create a shape.');
  const perpendicular = { x: -direction.y / length * wall.thickness / 2, y: direction.x / length * wall.thickness / 2 };
  return [
    { x: segmentStart.x + perpendicular.x, y: segmentStart.y + perpendicular.y },
    { x: segmentEnd.x + perpendicular.x, y: segmentEnd.y + perpendicular.y },
    { x: segmentEnd.x - perpendicular.x, y: segmentEnd.y - perpendicular.y },
    { x: segmentStart.x - perpendicular.x, y: segmentStart.y - perpendicular.y },
  ];
}

function meshPart(
  wall: WallRecord,
  partId: string,
  role: WallMeshPartRole,
  start: number,
  end: number,
  depth: number,
  elevation: number,
  openingIndex?: number,
): WallMeshInput | undefined {
  if (depth <= DEFAULT_EPSILON) return undefined;
  return {
    wallId: wall.id,
    partId,
    role,
    material: wall.material,
    contour: wallContour(wall, start, end),
    depth,
    elevation,
    ...(openingIndex === undefined ? {} : { openingIndex }),
  };
}

/**
 * Projects one canonical wall into stable prism inputs. Window parts are emitted
 * in wall order as outside segments, sill, and lintel; no input is changed.
 */
export function wallToMeshInputs(wall: WallRecord): WallMeshInput[] {
  if (wall.type === 'door') {
    if (wall.doorState === 'open') return [];
    const part = meshPart(wall, `${wall.id}:door`, WallMeshPartRole.Door, 0, 1, wall.height, wall.elevation);
    return part ? [part] : [];
  }
  if (!wall.openings.length) {
    const part = meshPart(wall, `${wall.id}:wall`, WallMeshPartRole.Wall, 0, 1, wall.height, wall.elevation);
    return part ? [part] : [];
  }

  const parts: WallMeshInput[] = [];
  let cursor = 0;
  for (const [openingIndex, opening] of wall.openings.entries()) {
    if (opening.start < cursor || opening.start >= opening.end || opening.end > 1) {
      throw new RangeError('Wall openings must be sorted and normalized before projection.');
    }
    const segment = meshPart(wall, `${wall.id}:segment:${openingIndex}`, WallMeshPartRole.Segment, cursor, opening.start, wall.height, wall.elevation);
    if (segment) parts.push(segment);
    const sill = meshPart(
      wall, `${wall.id}:opening:${openingIndex}:sill`, WallMeshPartRole.WindowSill,
      opening.start, opening.end, opening.bottom, wall.elevation, openingIndex,
    );
    if (sill) parts.push(sill);
    const lintel = meshPart(
      wall, `${wall.id}:opening:${openingIndex}:lintel`, WallMeshPartRole.WindowLintel,
      opening.start, opening.end, wall.height - opening.bottom - opening.height,
      wall.elevation + opening.bottom + opening.height, openingIndex,
    );
    if (lintel) parts.push(lintel);
    cursor = opening.end;
  }
  const finalSegment = meshPart(wall, `${wall.id}:segment:${wall.openings.length}`, WallMeshPartRole.Segment, cursor, 1, wall.height, wall.elevation);
  if (finalSegment) parts.push(finalSegment);
  return parts;
}

/** Projects walls in lexical ID order so mesh generation is reproducible. */
export function sceneToMeshInputs(scene: { walls: Record<string, WallRecord> }): WallMeshInput[] {
  return Object.values(scene.walls)
    .sort((first, second) => first.id < second.id ? -1 : first.id > second.id ? 1 : 0)
    .flatMap(wallToMeshInputs);
}

export function circleFootprint(center: Point, radius: number, segments = 32): Point[] {
  assertFinitePoint(center, 'Circle center');
  if (!Number.isFinite(radius) || radius < 0 || !Number.isInteger(segments) || segments < 3) throw new RangeError('Circle radius and segment count are invalid.');
  return Array.from({ length: segments }, (_, index) => {
    const angle = index / segments * Math.PI * 2;
    return { x: center.x + Math.cos(angle) * radius, y: center.y + Math.sin(angle) * radius };
  });
}

export function rectangleFootprint(center: Point, size: Size, rotationDegrees = 0): [Point, Point, Point, Point] {
  assertFinitePoint(center, 'Rectangle center');
  if (!Number.isFinite(size.width) || size.width <= 0 || !Number.isFinite(size.height) || size.height <= 0 || !Number.isFinite(rotationDegrees)) {
    throw new RangeError('Rectangle dimensions and rotation are invalid.');
  }
  const radians = rotationDegrees * Math.PI / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const rotate = (x: number, y: number): Point => ({ x: center.x + x * cosine - y * sine, y: center.y + x * sine + y * cosine });
  return [
    rotate(-size.width / 2, -size.height / 2), rotate(size.width / 2, -size.height / 2),
    rotate(size.width / 2, size.height / 2), rotate(-size.width / 2, size.height / 2),
  ];
}

export function ellipseFootprint(center: Point, radii: Size, rotationDegrees = 0, segments = 32): Point[] {
  assertFinitePoint(center, 'Ellipse center');
  if (!Number.isFinite(radii.width) || radii.width <= 0 || !Number.isFinite(radii.height) || radii.height <= 0 || !Number.isFinite(rotationDegrees) || !Number.isInteger(segments) || segments < 3) {
    throw new RangeError('Ellipse dimensions, rotation, or segment count are invalid.');
  }
  const rotation = rotationDegrees * Math.PI / 180;
  const cosine = Math.cos(rotation);
  const sine = Math.sin(rotation);
  return Array.from({ length: segments }, (_, index) => {
    const angle = index / segments * Math.PI * 2;
    const x = Math.cos(angle) * radii.width;
    const y = Math.sin(angle) * radii.height;
    return { x: center.x + x * cosine - y * sine, y: center.y + x * sine + y * cosine };
  });
}

export function coneFootprint(origin: Point, directionDegrees: number, radius: number, angleDegrees: number, segments = 16): Point[] {
  assertFinitePoint(origin, 'Cone origin');
  if (![directionDegrees, radius, angleDegrees].every(Number.isFinite) || radius < 0 || angleDegrees <= 0 || angleDegrees > 360 || !Number.isInteger(segments) || segments < 1) {
    throw new RangeError('Cone dimensions are invalid.');
  }
  const start = (directionDegrees - angleDegrees / 2) * Math.PI / 180;
  const sweep = angleDegrees * Math.PI / 180;
  return [{ ...origin }, ...Array.from({ length: segments + 1 }, (_, index) => {
    const angle = start + sweep * index / segments;
    return { x: origin.x + Math.cos(angle) * radius, y: origin.y + Math.sin(angle) * radius };
  })];
}

export function distanceBetween(first: Point, second: Point): number {
  assertFinitePoint(first, 'Point'); assertFinitePoint(second, 'Point');
  return Math.hypot(second.x - first.x, second.y - first.y);
}
