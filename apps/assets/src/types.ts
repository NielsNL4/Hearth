export type AssetKind = 'map' | 'token';
export type AssetStatus = 'reserved' | 'uploading' | 'processing' | 'ready' | 'failed';

export interface RoomAsset {
  id: string;
  room_id: string;
  created_by: string;
  kind: AssetKind;
  status: AssetStatus;
  source_object_key: string;
  output_object_prefix: string;
  source_metadata: Record<string, unknown>;
  width: number | null;
  height: number | null;
  updated_at: string;
}

export interface UserIdentity { id: string }

export interface AssetRepository {
  verifyToken(token: string): Promise<UserIdentity>;
  getAsset(id: string): Promise<RoomAsset | null>;
  isRoomMember(roomId: string, userId: string): Promise<boolean>;
  setStatus(id: string, status: AssetStatus, details?: {
    width?: number;
    height?: number;
    error?: Record<string, unknown>;
  }): Promise<void>;
  findStaleReservations(before: Date, limit: number): Promise<RoomAsset[]>;
}

export interface ObjectInfo { bytes: number; contentType?: string }

export interface ObjectStore {
  createUpload(key: string, contentType: string, expectedBytes: number, expiresSeconds: number): Promise<{
    url: string;
    fields: Record<string, string>;
  }>;
  head(key: string): Promise<ObjectInfo>;
  downloadToFile(key: string, path: string): Promise<void>;
  put(key: string, body: Uint8Array | string, contentType: string): Promise<void>;
  getText(key: string): Promise<string>;
  remove(key: string): Promise<void>;
  signDownload(key: string, expiresSeconds: number): Promise<string>;
}

export interface ManifestOutput {
  key: string;
  type: 'tile' | 'preview' | 'image' | 'thumbnail';
  contentType: 'image/webp';
  width: number;
  height: number;
  z?: number;
  x?: number;
  y?: number;
}

export interface AssetManifest {
  version: 1;
  assetId: string;
  kind: AssetKind;
  width: number;
  height: number;
  outputs: ManifestOutput[];
}
