export interface Point {
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
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
}

interface WallBase {
  id: string;
  start: Point;
  end: Point;
  height: number;
  thickness: number;
  elevation: number;
  revision: number;
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
  z: number;
  revision: number;
}

export interface StructureRecord {
  id: string;
  position: Point;
  size: Size;
  rotation: number;
  label: string;
  z: number;
  revision: number;
}

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
  };
  tokens: Record<string, TokenRecord>;
  walls: Record<string, WallRecord>;
  fog: { version: 1; mode: 'shared' | 'per-player'; operations: FogOperation[] };
  initiative: { version: 1; active: boolean; round: number; turnIndex: number | null; entries: InitiativeEntry[] };
  drawings: Record<string, DrawingRecord>;
  structures: Record<string, StructureRecord>;
  lights: Record<string, LightRecord>;
  effects: Record<string, EffectRecord>;
  extensions: Record<string, JsonValue>;
}
