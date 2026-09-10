import type { JsonValue, SceneV2 } from '@hearth/scene';
import type { RoomRole } from '@hearth/domain';

export interface Actor {
  userId: string;
  role: RoomRole;
  displayName: string;
}

export interface LoadedRoomState {
  roomId: string;
  sceneRevision: number;
  scene: SceneV2;
}

export interface CommitInput {
  commandId: string;
  roomId: string;
  actorId: string;
  expectedSceneRevision: number;
  scene: SceneV2;
  eventType: string;
  eventPayload: Record<string, JsonValue>;
}

export interface CommitResult {
  roomId: string;
  sceneRevision: number;
  eventId: number;
}

export interface AssetReservation {
  id: string;
  roomId: string;
  status: string;
  sourceObjectKey: string;
  outputObjectPrefix: string;
}

export interface RoomAsset {
  id: string;
  roomId: string;
  kind: 'map' | 'token';
  status: 'reserved' | 'uploading' | 'processing' | 'ready' | 'failed';
  width: number | null;
  height: number | null;
}

export interface Persistence {
  loadRoomState(roomId: string): Promise<LoadedRoomState>;
  getRoomAsset(assetId: string): Promise<RoomAsset | null>;
  commitRoomState(input: CommitInput): Promise<CommitResult>;
  reserveRoomAsset(input: {
    commandId: string;
    roomId: string;
    creatorId: string;
    kind: 'map' | 'token';
    sourceMetadata: Record<string, JsonValue>;
  }): Promise<AssetReservation>;
}

export interface AuthProvider {
  verifyAccessToken(accessToken: string): Promise<{ userId: string }>;
  getMembership(roomId: string, userId: string): Promise<Actor | null>;
}

export async function authenticateRoomClient(auth: AuthProvider, roomId: string, accessToken: string): Promise<Actor> {
  const user = await auth.verifyAccessToken(accessToken);
  const actor = await auth.getMembership(roomId, user.userId);
  if (!actor) throw new Error('Room membership is required.');
  return actor;
}
