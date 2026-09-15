export interface Point {
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface GridPoint {
  column: number;
  row: number;
}

export interface TokenMovementState {
  allowanceCells: number | null;
  spentCells: number;
  activePath: GridPoint[];
  pathCostCells: number;
  pathStartedAtServerMs: number | null;
  millisecondsPerCell: number;
  status: 'idle' | 'moving' | 'interrupted';
  revision: number;
}

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface SceneV1 {
  version: 1;
  grid: {
    type: 'square';
    cellSize: number;
    offset: Point;
    distancePerCell: number;
    unit: 'ft' | 'm';
  };
  extensions: Record<string, JsonValue>;
}

export interface TokenRecord {
  id: string;
  assetId: string;
  position: Point;
  size: Size;
  rotation: number;
  label: string;
  ownerId: string;
  hpCurrent: number;
  hpMaximum: number;
  hpHidden: boolean;
  z: number;
  revision: number;
  movement?: TokenMovementState;
}

export type WallMaterial = 'default' | 'masonry' | 'wood' | 'metal';

export interface WallOpening {
  type: 'window';
  /** Fractional position along the wall from start (0) to end (1). */
  start: number;
  /** Fractional position along the wall from start (0) to end (1). */
  end: number;
  /** Height above the wall elevation. */
  bottom: number;
  height: number;
}

interface WallBase {
  id: string;
  start: Point;
  end: Point;
  height: number;
  thickness: number;
  elevation: number;
  revision: number;
  material: WallMaterial;
  openings: WallOpening[];
}

export interface BlockingWall extends WallBase { type: 'blocking' }
export interface TerrainWall extends WallBase { type: 'terrain' }
export interface EtherealWall extends WallBase { type: 'ethereal' }
export interface DoorWall extends WallBase {
  type: 'door';
  doorState: 'open' | 'closed' | 'locked';
}
export type WallRecord = BlockingWall | TerrainWall | EtherealWall | DoorWall;

export interface FogOperation {
  id: string;
  kind: 'reveal' | 'conceal';
  points: Point[];
  playerId: string | null;
  revision: number;
}

export interface InitiativeEntry {
  id: string;
  tokenId: string;
  label: string;
  score: number;
  hidden: boolean;
}

export interface DrawingRecord {
  id: string;
  kind: 'line' | 'polygon';
  points: Point[];
  color: string;
  width: number;
  fill?: string | null;
  hidden?: boolean;
  ownerId?: string;
  z: number;
  revision: number;
}

export type StructureMaterial = WallMaterial;
export type StructureKind = 'block' | 'floor' | 'roof';

interface StructureBase {
  id: string;
  kind: StructureKind;
  position: Point;
  size: Size;
  rotation: number;
  label: string;
  z: number;
  material: StructureMaterial;
  baseElevation: number;
  slabHeight: number;
  revision: number;
}

export interface BlockStructure extends StructureBase { kind: 'block' }
export interface FloorStructure extends StructureBase { kind: 'floor' }
export interface RoofStructure extends StructureBase { kind: 'roof' }
export type StructureRecord = BlockStructure | FloorStructure | RoofStructure;

export interface LightRecord {
  id: string;
  position: Point;
  radius: number;
  color: string;
  intensity: number;
  enabled: boolean;
  revision: number;
}

export interface EffectRecord {
  id: string;
  position: Point;
  radius: number;
  label: string;
  duration: number;
  z: number;
  revision: number;
}

export interface SceneV2 {
  version: 2;
  coordinateSystem: {
    origin: 'top-left';
    axes: 'x-right-y-down';
    worldUnit: 'map-pixel';
  };
  map: null | {
    assetId: string;
    width: number;
    height: number;
  };
  grid: {
    type: 'square';
    visible: boolean;
    cellSize: number;
    offset: Point;
    distancePerCell: number;
    unit: 'ft' | 'm';
    snap: boolean;
  };
  permissions: {
    playerMovement: 'owned' | 'all';
    playerDrawing?: 'none' | 'own' | 'all';
    playerPerspectiveView?: boolean;
  };
  navigationRevision?: number;
  wallRevision?: number;
  tokens: Record<string, TokenRecord>;
  walls: Record<string, WallRecord>;
  fog: {
    version: 1;
    mode: 'shared' | 'per-player';
    enabled?: boolean;
    base?: 'revealed' | 'concealed';
    operations: FogOperation[];
    revision?: number;
  };
  initiative: { version: 1; active: boolean; round: number; turnIndex: number | null; entries: InitiativeEntry[]; revision?: number };
  drawings: Record<string, DrawingRecord>;
  drawingRevision?: number;
  structures: Record<string, StructureRecord>;
  structureRevision?: number;
  lights: Record<string, LightRecord>;
  effects: Record<string, EffectRecord>;
  extensions: Record<string, JsonValue>;
}
