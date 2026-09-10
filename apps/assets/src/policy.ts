import type { AssetKind, RoomAsset } from './types.js';

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const ALLOWED_CONTENT_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
export const MAX_BYTES: Record<AssetKind, number> = { map: 250 * 1024 * 1024, token: 25 * 1024 * 1024 };

export class RequestError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}

export function canonicalKeys(asset: Pick<RoomAsset, 'id' | 'room_id'>) {
  if (!UUID_PATTERN.test(asset.id) || !UUID_PATTERN.test(asset.room_id)) throw new RequestError(500, 'Invalid asset key identity');
  const base = `rooms/${asset.room_id}/assets/${asset.id}`;
  return { source: `${base}/source`, outputPrefix: `${base}/output/` };
}

export function assertCanonicalAsset(asset: RoomAsset): void {
  const expected = canonicalKeys(asset);
  if (asset.source_object_key !== expected.source || asset.output_object_prefix !== expected.outputPrefix) {
    throw new RequestError(500, 'Asset contains non-canonical storage keys');
  }
}

export function validateUpload(asset: RoomAsset, contentType: string, bytes: number): number {
  assertCanonicalAsset(asset);
  if (asset.status !== 'reserved') throw new RequestError(409, 'Asset is not reserved');
  if (!ALLOWED_CONTENT_TYPES.has(contentType)) throw new RequestError(400, 'Only JPEG, PNG, and WebP are accepted');
  if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > MAX_BYTES[asset.kind]) {
    throw new RequestError(400, `Upload must be between 1 and ${MAX_BYTES[asset.kind]} bytes`);
  }
  const expectedType = asset.source_metadata.contentType;
  const expectedBytes = asset.source_metadata.bytes;
  if (typeof expectedType === 'string' && expectedType !== contentType) throw new RequestError(400, 'Content type differs from reservation');
  if (typeof expectedBytes === 'number' && expectedBytes !== bytes) throw new RequestError(400, 'Size differs from reservation');
  return bytes;
}

export function validateImageMetadata(kind: AssetKind, metadata: {
  format?: string | undefined;
  width?: number | undefined;
  height?: number | undefined;
  pages?: number | undefined;
}, pixelCap: number): { width: number; height: number } {
  if (!metadata.format || !['jpeg', 'png', 'webp'].includes(metadata.format) || !metadata.width || !metadata.height) {
    throw new RequestError(422, 'Image is corrupt or unsupported');
  }
  if ((metadata.pages ?? 1) !== 1) throw new RequestError(422, 'Animated or multi-page images are not accepted');
  if (metadata.width > 30_000 || metadata.height > 30_000) throw new RequestError(422, 'Image side exceeds 30000 pixels');
  if (metadata.width * metadata.height > pixelCap) throw new RequestError(422, `${kind} exceeds the configured pixel limit`);
  return { width: metadata.width, height: metadata.height };
}

export function assertRequestedOutputKeys(asset: RoomAsset, available: readonly string[], requested: readonly string[]): void {
  assertCanonicalAsset(asset);
  if (requested.length < 1 || requested.length > 500 || new Set(requested).size !== requested.length) {
    throw new RequestError(400, 'Request 1 to 500 unique output keys');
  }
  const allowed = new Set(available);
  for (const key of requested) {
    if (!key.startsWith(asset.output_object_prefix) || !allowed.has(key)) {
      throw new RequestError(403, 'Only exact generated output keys may be signed');
    }
  }
}
