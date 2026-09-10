import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import type { Config } from './config.js';
import { MAX_BYTES, RequestError, assertCanonicalAsset, validateImageMetadata } from './policy.js';
import { buildManifest } from './plan.js';
import type { AssetRepository, ManifestOutput, ObjectStore, RoomAsset } from './types.js';

export class AssetProcessor {
  constructor(
    private readonly repository: AssetRepository,
    private readonly store: ObjectStore,
    private readonly config: Pick<Config, 'mapMaxPixels' | 'tokenMaxPixels' | 'removeTokenSource'>,
  ) {}

  async process(asset: RoomAsset): Promise<void> {
    let directory: string | undefined;
    try {
      assertCanonicalAsset(asset);
      const object = await this.store.head(asset.source_object_key);
      if (object.bytes < 1 || object.bytes > MAX_BYTES[asset.kind]) throw new RequestError(422, 'Uploaded object size is invalid');
      await this.repository.setStatus(asset.id, 'processing');
      directory = await mkdtemp(join(tmpdir(), 'hearth-asset-'));
      const sourcePath = join(directory, 'source');
      await this.store.downloadToFile(asset.source_object_key, sourcePath);
      const pixelCap = asset.kind === 'map' ? this.config.mapMaxPixels : this.config.tokenMaxPixels;
      const input = sharp(sourcePath, { animated: false, failOn: 'error', limitInputPixels: pixelCap });
      const dimensions = validateImageMetadata(asset.kind, await input.metadata(), pixelCap);
      const manifest = buildManifest(asset.id, asset.kind, asset.output_object_prefix, dimensions.width, dimensions.height);

      for (const output of manifest.outputs) {
        const bytes = asset.kind === 'map' && output.type === 'tile'
          ? await this.renderTile(sourcePath, output, manifest.outputs, pixelCap)
          : await sharp(sourcePath, { failOn: 'error', limitInputPixels: pixelCap })
              .resize(output.width, output.height, { fit: 'fill', withoutEnlargement: true })
              .webp({ quality: output.type === 'thumbnail' ? 80 : 88, alphaQuality: 100 })
              .toBuffer();
        await this.store.put(output.key, bytes, output.contentType);
      }
      await this.store.put(`${asset.output_object_prefix}manifest.json`, JSON.stringify(manifest), 'application/json');
      if (asset.kind === 'token' && this.config.removeTokenSource) await this.store.remove(asset.source_object_key);
      await this.repository.setStatus(asset.id, 'ready', dimensions);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown processing error';
      try { await this.repository.setStatus(asset.id, 'failed', { error: { code: 'PROCESSING_FAILED', message } }); } catch { /* Preserve the original failure. */ }
      throw error;
    } finally {
      if (directory) await rm(directory, { recursive: true, force: true });
    }
  }

  private async renderTile(sourcePath: string, output: ManifestOutput, all: ManifestOutput[], pixelCap: number) {
    const level = all.filter((candidate) => candidate.type === 'tile' && candidate.z === output.z);
    const levelWidth = Math.max(...level.map((tile) => (tile.x! * 512) + tile.width));
    const levelHeight = Math.max(...level.map((tile) => (tile.y! * 512) + tile.height));
    return sharp(sourcePath, { failOn: 'error', limitInputPixels: pixelCap })
      .resize(levelWidth, levelHeight, { fit: 'fill' })
      .extract({ left: output.x! * 512, top: output.y! * 512, width: output.width, height: output.height })
      .webp({ quality: 86 })
      .toBuffer();
  }
}
