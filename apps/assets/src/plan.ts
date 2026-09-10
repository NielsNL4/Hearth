import type { AssetKind, AssetManifest, ManifestOutput } from './types.js';

export const TILE_SIZE = 512;

export function buildMapOutputs(prefix: string, width: number, height: number): ManifestOutput[] {
  const maxZoom = Math.max(0, Math.ceil(Math.log2(Math.max(width, height) / TILE_SIZE)));
  const outputs: ManifestOutput[] = [];
  for (let z = 0; z <= maxZoom; z++) {
    const scale = 2 ** (maxZoom - z);
    const levelWidth = Math.ceil(width / scale);
    const levelHeight = Math.ceil(height / scale);
    const columns = Math.ceil(levelWidth / TILE_SIZE);
    const rows = Math.ceil(levelHeight / TILE_SIZE);
    for (let y = 0; y < rows; y++) for (let x = 0; x < columns; x++) {
      outputs.push({
        key: `${prefix}tiles/${z}/${x}_${y}.webp`, type: 'tile', contentType: 'image/webp',
        width: Math.min(TILE_SIZE, levelWidth - x * TILE_SIZE),
        height: Math.min(TILE_SIZE, levelHeight - y * TILE_SIZE), z, x, y,
      });
    }
  }
  const ratio = Math.min(1, 1024 / Math.max(width, height));
  outputs.push({
    key: `${prefix}preview.webp`, type: 'preview', contentType: 'image/webp',
    width: Math.max(1, Math.round(width * ratio)), height: Math.max(1, Math.round(height * ratio)),
  });
  return outputs;
}

export function buildTokenOutputs(prefix: string, width: number, height: number): ManifestOutput[] {
  const normalizedRatio = Math.min(1, 2048 / Math.max(width, height));
  const normalizedWidth = Math.max(1, Math.round(width * normalizedRatio));
  const normalizedHeight = Math.max(1, Math.round(height * normalizedRatio));
  const thumbnailRatio = Math.min(1, 256 / Math.max(normalizedWidth, normalizedHeight));
  return [
    { key: `${prefix}image.webp`, type: 'image', contentType: 'image/webp', width: normalizedWidth, height: normalizedHeight },
    { key: `${prefix}thumbnail.webp`, type: 'thumbnail', contentType: 'image/webp', width: Math.max(1, Math.round(normalizedWidth * thumbnailRatio)), height: Math.max(1, Math.round(normalizedHeight * thumbnailRatio)) },
  ];
}

export function buildManifest(assetId: string, kind: AssetKind, prefix: string, width: number, height: number): AssetManifest {
  return {
    version: 1,
    assetId,
    kind,
    width,
    height,
    outputs: kind === 'map' ? buildMapOutputs(prefix, width, height) : buildTokenOutputs(prefix, width, height),
  };
}
