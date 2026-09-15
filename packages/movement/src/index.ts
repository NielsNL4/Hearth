import Pathfinding from 'pathfinding';
import {
  rectangleFootprint,
  segmentIntersection,
  wallBlocksMovement,
  type GridPoint,
  type Point,
  type SceneV2,
  type Segment,
} from '@hearth/scene';

export interface NavigationBounds {
  minColumn: number;
  minRow: number;
  width: number;
  height: number;
}

export interface PathResult {
  path: GridPoint[];
  costCells: number;
}

export interface NavigationOptions {
  allowDiagonal?: boolean;
  blockOccupiedCells?: boolean;
}

export function navigationBounds(scene: SceneV2): NavigationBounds {
  if (!scene.map) throw new Error('A map is required for grid movement.');
  const { cellSize, offset } = scene.grid;
  const minColumn = Math.floor(-offset.x / cellSize);
  const minRow = Math.floor(-offset.y / cellSize);
  const maxColumn = Math.ceil((scene.map.width - offset.x) / cellSize) - 1;
  const maxRow = Math.ceil((scene.map.height - offset.y) / cellSize) - 1;
  return { minColumn, minRow, width: maxColumn - minColumn + 1, height: maxRow - minRow + 1 };
}

export function worldToNavigationCell(scene: SceneV2, point: Point): GridPoint {
  return {
    column: Math.floor((point.x - scene.grid.offset.x) / scene.grid.cellSize),
    row: Math.floor((point.y - scene.grid.offset.y) / scene.grid.cellSize),
  };
}

export function navigationCellCenter(scene: SceneV2, cell: GridPoint): Point {
  return {
    x: scene.grid.offset.x + (cell.column + 0.5) * scene.grid.cellSize,
    y: scene.grid.offset.y + (cell.row + 0.5) * scene.grid.cellSize,
  };
}

export function navigationKey(cell: GridPoint): string { return `${cell.column},${cell.row}`; }

function pathCost(path: readonly GridPoint[]): number {
  let cost = 0;
  for (let index = 1; index < path.length; index++) {
    const previous = path[index - 1]!;
    const current = path[index]!;
    cost += previous.column !== current.column && previous.row !== current.row ? Math.SQRT2 : 1;
  }
  return cost;
}

function movementSegments(scene: SceneV2): Segment[] {
  return Object.values(scene.walls).filter(wallBlocksMovement).map((wall) => ({ start: wall.start, end: wall.end }));
}

function cellsOccupiedByOtherTokens(scene: SceneV2, movingTokenId: string): Set<string> {
  const occupied = new Set<string>();
  for (const token of Object.values(scene.tokens)) {
    if (token.id === movingTokenId) continue;
    const footprint = rectangleFootprint(token.position, token.size, token.rotation);
    const epsilon = scene.grid.cellSize * 1e-9;
    const minColumn = Math.floor((Math.min(...footprint.map((point) => point.x)) - scene.grid.offset.x + epsilon) / scene.grid.cellSize);
    const maxColumn = Math.floor((Math.max(...footprint.map((point) => point.x)) - scene.grid.offset.x - epsilon) / scene.grid.cellSize);
    const minRow = Math.floor((Math.min(...footprint.map((point) => point.y)) - scene.grid.offset.y + epsilon) / scene.grid.cellSize);
    const maxRow = Math.floor((Math.max(...footprint.map((point) => point.y)) - scene.grid.offset.y - epsilon) / scene.grid.cellSize);
    for (let column = minColumn; column <= maxColumn; column++) {
      for (let row = minRow; row <= maxRow; row++) occupied.add(navigationKey({ column, row }));
    }
  }
  return occupied;
}

function edgeBlocked(
  scene: SceneV2,
  walls: readonly Segment[],
  from: GridPoint,
  to: GridPoint,
  halfWidth: number,
  halfHeight: number,
): boolean {
  const start = navigationCellCenter(scene, from);
  const end = navigationCellCenter(scene, to);
  const epsilon = scene.grid.cellSize * 1e-9;
  const offsets = start.x === end.x
    ? [{ x: 0, y: 0 }, { x: -halfWidth + epsilon, y: 0 }, { x: halfWidth - epsilon, y: 0 }]
    : start.y === end.y
      ? [{ x: 0, y: 0 }, { x: 0, y: -halfHeight + epsilon }, { x: 0, y: halfHeight - epsilon }]
      : [
          { x: 0, y: 0 },
          { x: -halfWidth + epsilon, y: -halfHeight + epsilon },
          { x: halfWidth - epsilon, y: -halfHeight + epsilon },
          { x: halfWidth - epsilon, y: halfHeight - epsilon },
          { x: -halfWidth + epsilon, y: halfHeight - epsilon },
        ];
  return walls.some((wall) => offsets.some((offset) => segmentIntersection({
    start: { x: start.x + offset.x, y: start.y + offset.y },
    end: { x: end.x + offset.x, y: end.y + offset.y },
  }, wall).kind !== 'none'));
}

class WallAwareGrid extends Pathfinding.Grid {
  constructor(
    width: number,
    height: number,
    private readonly bounds: NavigationBounds,
    private readonly blocked: (from: GridPoint, to: GridPoint) => boolean,
    private readonly footprintWalkable: (cell: GridPoint) => boolean,
  ) { super(width, height); }

  override isWalkableAt(x: number, y: number): boolean {
    return super.isWalkableAt(x, y) && this.footprintWalkable({
      column: x + this.bounds.minColumn,
      row: y + this.bounds.minRow,
    });
  }

  override getNeighbors(node: Pathfinding.Node, diagonalMovement: Pathfinding.DiagonalMovement): Pathfinding.Node[] {
    const from = { column: node.x + this.bounds.minColumn, row: node.y + this.bounds.minRow };
    return super.getNeighbors(node, diagonalMovement).filter((neighbor) => !this.blocked(from, {
      column: neighbor.x + this.bounds.minColumn,
      row: neighbor.y + this.bounds.minRow,
    }));
  }
}

function createGrid(scene: SceneV2, movingTokenId: string, options: NavigationOptions): { grid: WallAwareGrid; bounds: NavigationBounds } {
  const bounds = navigationBounds(scene);
  const walls = movementSegments(scene);
  const movingToken = scene.tokens[movingTokenId];
  if (!movingToken) throw new Error('Moving token not found.');
  const footprint = rectangleFootprint(movingToken.position, movingToken.size, movingToken.rotation);
  const halfWidth = Math.max(...footprint.map((point) => Math.abs(point.x - movingToken.position.x)));
  const halfHeight = Math.max(...footprint.map((point) => Math.abs(point.y - movingToken.position.y)));
  const occupied = options.blockOccupiedCells === false ? new Set<string>() : cellsOccupiedByOtherTokens(scene, movingTokenId);
  const footprintWalkable = (cell: GridPoint): boolean => {
    const center = navigationCellCenter(scene, cell);
    if (!scene.map || center.x - halfWidth < 0 || center.y - halfHeight < 0
      || center.x + halfWidth > scene.map.width || center.y + halfHeight > scene.map.height) return false;
    const epsilon = scene.grid.cellSize * 1e-9;
    const minColumn = Math.floor((center.x - halfWidth - scene.grid.offset.x + epsilon) / scene.grid.cellSize);
    const maxColumn = Math.floor((center.x + halfWidth - scene.grid.offset.x - epsilon) / scene.grid.cellSize);
    const minRow = Math.floor((center.y - halfHeight - scene.grid.offset.y + epsilon) / scene.grid.cellSize);
    const maxRow = Math.floor((center.y + halfHeight - scene.grid.offset.y - epsilon) / scene.grid.cellSize);
    for (let column = minColumn; column <= maxColumn; column++) {
      for (let row = minRow; row <= maxRow; row++) if (occupied.has(navigationKey({ column, row }))) return false;
    }
    return true;
  };
  const grid = new WallAwareGrid(
    bounds.width,
    bounds.height,
    bounds,
    (from, to) => edgeBlocked(scene, walls, from, to, halfWidth, halfHeight),
    footprintWalkable,
  );
  return { grid, bounds };
}

function inside(cell: GridPoint, bounds: NavigationBounds): boolean {
  return cell.column >= bounds.minColumn && cell.row >= bounds.minRow
    && cell.column < bounds.minColumn + bounds.width && cell.row < bounds.minRow + bounds.height;
}

export function findNavigationPath(
  scene: SceneV2,
  movingTokenId: string,
  start: GridPoint,
  destination: GridPoint,
  options: NavigationOptions = {},
): PathResult | null {
  const { grid, bounds } = createGrid(scene, movingTokenId, options);
  if (!inside(start, bounds) || !inside(destination, bounds)) return null;
  const diagonalMovement = options.allowDiagonal ? Pathfinding.DiagonalMovement.OnlyWhenNoObstacles : Pathfinding.DiagonalMovement.Never;
  const finder = new Pathfinding.AStarFinder({ diagonalMovement });
  const raw = finder.findPath(
    start.column - bounds.minColumn,
    start.row - bounds.minRow,
    destination.column - bounds.minColumn,
    destination.row - bounds.minRow,
    grid,
  );
  if (!raw.length) return null;
  const path = raw.map(([column, row]) => ({ column: column! + bounds.minColumn, row: row! + bounds.minRow }));
  return { path, costCells: pathCost(path) };
}

export function reachableNavigationCells(
  scene: SceneV2,
  movingTokenId: string,
  start: GridPoint,
  allowanceCells: number,
  options: NavigationOptions = {},
): Map<string, PathResult> {
  if (!Number.isFinite(allowanceCells) || allowanceCells < 0) throw new RangeError('Movement allowance must be finite and non-negative.');
  const bounds = navigationBounds(scene);
  const radius = Math.ceil(allowanceCells);
  const reachable = new Map<string, PathResult>();
  for (let row = Math.max(bounds.minRow, start.row - radius); row <= Math.min(bounds.minRow + bounds.height - 1, start.row + radius); row++) {
    for (let column = Math.max(bounds.minColumn, start.column - radius); column <= Math.min(bounds.minColumn + bounds.width - 1, start.column + radius); column++) {
      const destination = { column, row };
      const result = findNavigationPath(scene, movingTokenId, start, destination, options);
      if (result && result.costCells <= allowanceCells) reachable.set(navigationKey(destination), result);
    }
  }
  return reachable;
}
