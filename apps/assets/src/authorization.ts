import { RequestError } from './policy.js';
import type { AssetRepository, RoomAsset, UserIdentity } from './types.js';

export function bearerToken(header: string | undefined): string {
  const match = /^Bearer ([^\s]+)$/.exec(header ?? '');
  if (!match) throw new RequestError(401, 'A bearer token is required');
  return match[1]!;
}

export async function authenticate(repository: AssetRepository, header: string | undefined): Promise<UserIdentity> {
  try {
    return await repository.verifyToken(bearerToken(header));
  } catch (error) {
    if (error instanceof RequestError) throw error;
    throw new RequestError(401, 'Invalid or expired token');
  }
}

export async function authorizeAsset(repository: AssetRepository, assetId: string, userId: string): Promise<RoomAsset> {
  const asset = await repository.getAsset(assetId);
  if (!asset) throw new RequestError(404, 'Asset not found');
  if (!await repository.isRoomMember(asset.room_id, userId)) throw new RequestError(403, 'Room membership is required');
  return asset;
}
