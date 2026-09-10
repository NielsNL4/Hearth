import type { Point, WallRecord } from './types.js';

export function normalizeRotation(degrees: number): number {
  if (!Number.isFinite(degrees)) throw new RangeError('Rotation must be finite.');
  const normalized = degrees % 360;
  return Object.is(normalized, -0) ? 0 : normalized < 0 ? normalized + 360 : normalized;
}

export function snapCoordinate(value: number, cellSize: number, offset = 0): number {
  if (!Number.isFinite(value) || !Number.isFinite(offset)) throw new RangeError('Coordinate and offset must be finite.');
  if (!Number.isFinite(cellSize) || cellSize <= 0) throw new RangeError('Cell size must be positive and finite.');
  const cells = (value - offset) / cellSize;
  const snappedCells = cells < 0 ? -Math.round(-cells) : Math.round(cells);
  return offset + snappedCells * cellSize;
}

export function snapPoint(point: Point, cellSize: number, offset: Point = { x: 0, y: 0 }): Point {
  return {
    x: snapCoordinate(point.x, cellSize, offset.x),
    y: snapCoordinate(point.y, cellSize, offset.y),
  };
}

export function wallBlocksMovement(wall: WallRecord): boolean {
  if (wall.type === 'door') return wall.doorState !== 'open';
  return wall.type !== 'terrain';
}

export function wallBlocksVision(wall: WallRecord): boolean {
  if (wall.type === 'door') return wall.doorState !== 'open';
  return wall.type !== 'ethereal';
}

export function canOpenDoor(wall: WallRecord): boolean {
  return wall.type === 'door' && wall.doorState === 'closed';
}

export function canCloseDoor(wall: WallRecord): boolean {
  return wall.type === 'door' && wall.doorState === 'open';
}

export function isDoorLocked(wall: WallRecord): boolean {
  return wall.type === 'door' && wall.doorState === 'locked';
}
