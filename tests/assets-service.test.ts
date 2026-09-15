import { createServer } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { authenticate, authorizeAsset, bearerToken } from '../apps/assets/src/authorization.js';
import { loadConfig } from '../apps/assets/src/config.js';
import {
  RequestError, assertCanonicalAsset, assertRequestedOutputKeys, validateImageMetadata, validateUpload,
} from '../apps/assets/src/policy.js';
import { buildManifest, buildMapOutputs, buildTokenOutputs } from '../apps/assets/src/plan.js';
import { S3ObjectStore } from '../apps/assets/src/storage.js';
import type { AssetRepository, RoomAsset } from '../apps/assets/src/types.js';

const roomId = '00000000-0000-4000-8000-000000000001';
const assetId = '10000000-0000-4000-8000-000000000001';
const userId = '20000000-0000-4000-8000-000000000001';
const prefix = `rooms/${roomId}/assets/${assetId}/output/`;

function asset(overrides: Partial<RoomAsset> = {}): RoomAsset {
  return {
    id: assetId,
    room_id: roomId,
    created_by: userId,
    kind: 'map',
    status: 'reserved',
    source_object_key: `rooms/${roomId}/assets/${assetId}/source`,
    output_object_prefix: prefix,
    source_metadata: { contentType: 'image/png', bytes: 1024 },
    width: null,
    height: null,
    updated_at: new Date(0).toISOString(),
    ...overrides,
  };
}

function repository(overrides: Partial<AssetRepository> = {}): AssetRepository {
  return {
    verifyToken: vi.fn(async () => ({ id: userId })),
    getAsset: vi.fn(async () => asset()),
    isRoomMember: vi.fn(async () => true),
    setStatus: vi.fn(async () => undefined),
    findStaleReservations: vi.fn(async () => []),
    ...overrides,
  };
}

describe('asset upload and image policy', () => {
  it('accepts only a reserved upload matching its SQL reservation', () => {
    expect(validateUpload(asset(), 'image/png', 1024)).toBe(1024);
    expect(() => validateUpload(asset(), 'image/gif', 1024)).toThrow(/JPEG, PNG, and WebP/);
    expect(() => validateUpload(asset(), 'image/png', 1025)).toThrow(/reservation/);
    expect(() => validateUpload(asset({ status: 'uploading' }), 'image/png', 1024)).toThrow(/not reserved/);
    expect(() => validateUpload(asset({ kind: 'token', source_metadata: {} }), 'image/png', 25 * 1024 * 1024 + 1)).toThrow(/26214400/);
  });

  it('rejects corrupt, animated, oversized-side, and over-pixel-cap metadata', () => {
    expect(validateImageMetadata('map', { format: 'png', width: 100, height: 50, pages: 1 }, 5_000)).toEqual({ width: 100, height: 50 });
    expect(() => validateImageMetadata('map', { format: 'gif', width: 1, height: 1 }, 10)).toThrow(/corrupt or unsupported/);
    expect(() => validateImageMetadata('token', { format: 'webp', width: 2, height: 2, pages: 2 }, 10)).toThrow(/Animated/);
    expect(() => validateImageMetadata('map', { format: 'jpeg', width: 30_001, height: 1 }, 100_000)).toThrow(/30000/);
    expect(() => validateImageMetadata('map', { format: 'jpeg', width: 100, height: 100 }, 9_999)).toThrow(/pixel limit/);
  });
});

describe('authorization and generated paths', () => {
  it('strictly parses bearer authentication and maps verification failures to 401', async () => {
    expect(bearerToken('Bearer abc.def')).toBe('abc.def');
    expect(() => bearerToken('bearer token')).toThrow(RequestError);
    await expect(authenticate(repository({ verifyToken: vi.fn(async () => { throw new Error('bad'); }) }), 'Bearer bad'))
      .rejects.toMatchObject({ statusCode: 401 });
  });

  it('requires persisted room membership', async () => {
    await expect(authorizeAsset(repository(), assetId, userId)).resolves.toMatchObject({ id: assetId });
    await expect(authorizeAsset(repository({ isRoomMember: vi.fn(async () => false) }), assetId, userId))
      .rejects.toMatchObject({ statusCode: 403 });
    await expect(authorizeAsset(repository({ getAsset: vi.fn(async () => null) }), assetId, userId))
      .rejects.toMatchObject({ statusCode: 404 });
  });

  it('rejects database key drift, traversal, unknown outputs, and duplicate signing requests', () => {
    expect(() => assertCanonicalAsset(asset({ source_object_key: `${prefix}../source` }))).toThrow(/non-canonical/);
    const known = [`${prefix}preview.webp`];
    expect(() => assertRequestedOutputKeys(asset(), known, known)).not.toThrow();
    expect(() => assertRequestedOutputKeys(asset(), known, [`${prefix}../source`])).toThrow(/exact generated/);
    expect(() => assertRequestedOutputKeys(asset(), known, [known[0]!, known[0]!])).toThrow(/unique/);
  });
});

describe('derivative plans and manifests', () => {
  it('plans a complete 512px map pyramid with edge tile dimensions and preview', () => {
    const outputs = buildMapOutputs(prefix, 1025, 700);
    expect(outputs.filter((output) => output.type === 'tile')).toHaveLength(9);
    expect(outputs).toContainEqual(expect.objectContaining({ key: `${prefix}tiles/2/2_1.webp`, width: 1, height: 188, z: 2, x: 2, y: 1 }));
    expect(outputs).toContainEqual(expect.objectContaining({ key: `${prefix}preview.webp`, width: 1024, height: 699 }));
  });

  it('normalizes tokens without enlargement while preserving deterministic output names', () => {
    expect(buildTokenOutputs(prefix, 4096, 2048)).toEqual([
      { key: `${prefix}image.webp`, type: 'image', contentType: 'image/webp', width: 2048, height: 1024 },
      { key: `${prefix}thumbnail.webp`, type: 'thumbnail', contentType: 'image/webp', width: 256, height: 128 },
    ]);
    expect(buildTokenOutputs(prefix, 64, 32)[0]).toMatchObject({ width: 64, height: 32 });
  });

  it('emits stable versioned manifest metadata containing exact output keys', () => {
    const manifest = buildManifest(assetId, 'token', prefix, 3000, 1500);
    expect(manifest).toMatchObject({ version: 1, assetId, kind: 'token', width: 3000, height: 1500 });
    expect(manifest.outputs.map((output) => output.key)).toEqual([`${prefix}image.webp`, `${prefix}thumbnail.webp`]);
  });
});

describe('environment validation', () => {
  const valid = {
    CORS_ORIGINS: 'https://table.example.com,http://localhost:3000',
    SUPABASE_URL: 'https://project.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'server-only-key',
    S3_ENDPOINT: 'http://minio:9000',
    S3_ACCESS_KEY: 'access',
    S3_SECRET_KEY: 'secret',
    S3_BUCKET: 'private',
    INTERNAL_JOB_SECRET: 'job-secret',
  };

  it('accepts exact origins and bounded settings', () => {
    expect(loadConfig(valid)).toMatchObject({
      corsOrigins: ['https://table.example.com', 'http://localhost:3000'],
      processingConcurrency: 2,
      s3PublicEndpoint: 'http://minio:9000',
    });
    expect(loadConfig({ ...valid, S3_PUBLIC_ENDPOINT: 'http://localhost:9000/' })).toMatchObject({
      s3PublicEndpoint: 'http://localhost:9000',
    });
  });

  it('rejects wildcard CORS, malformed booleans, and unsafe concurrency', () => {
    expect(() => loadConfig({ ...valid, CORS_ORIGINS: '*' })).toThrow(/cannot contain/);
    expect(() => loadConfig({ ...valid, REMOVE_TOKEN_SOURCE: 'yes' })).toThrow(/true or false/);
    expect(() => loadConfig({ ...valid, PROCESSING_CONCURRENCY: '100' })).toThrow(/between 1 and 16/);
  });
});

describe('S3 endpoint separation', () => {
  it('uses the public endpoint only for signed URLs and the internal endpoint for storage operations', async () => {
    const valid = {
      CORS_ORIGINS: 'http://localhost:5175',
      SUPABASE_URL: 'https://project.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: 'server-only-key',
      S3_ENDPOINT: 'http://minio:9000',
      S3_ACCESS_KEY: 'access',
      S3_SECRET_KEY: 'secret',
      S3_BUCKET: 'private',
      INTERNAL_JOB_SECRET: 'job-secret',
    };
    const internalRequests: string[] = [];
    const internalServer = createServer((request, response) => {
      internalRequests.push(`${request.method} ${request.url}`);
      request.resume();
      request.on('end', () => {
        if (request.method === 'HEAD') {
          response.setHeader('Content-Length', '4');
          response.setHeader('Content-Type', 'text/plain');
        } else if (request.method === 'GET') {
          response.setHeader('Content-Type', 'text/plain');
          response.setHeader('Content-Length', '4');
        }
        response.end(request.method === 'GET' ? 'test' : undefined);
      });
    });
    const publicServer = createServer((_request, response) => response.end());

    const listen = async (server: ReturnType<typeof createServer>): Promise<string> => {
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Test server did not receive an address');
      return `http://127.0.0.1:${address.port}`;
    };
    const close = async (server: ReturnType<typeof createServer>): Promise<void> => {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    };

    const internalEndpoint = await listen(internalServer);
    const publicEndpoint = await listen(publicServer);
    try {
      const config = loadConfig({ ...valid, S3_ENDPOINT: internalEndpoint, S3_PUBLIC_ENDPOINT: publicEndpoint });
      const store = new S3ObjectStore(config);

      const upload = await store.createUpload('diagnostic', 'text/plain', 4, 60);
      expect(new URL(upload.url).origin).toBe(publicEndpoint);
      expect(new URL(await store.signDownload('diagnostic', 60)).origin).toBe(publicEndpoint);

      await store.put('diagnostic', 'test', 'text/plain');
      await expect(store.head('diagnostic')).resolves.toMatchObject({ bytes: 4, contentType: 'text/plain' });
      await expect(store.getText('diagnostic')).resolves.toBe('test');
      expect(internalRequests).toEqual(expect.arrayContaining([
        expect.stringMatching(/^PUT \/private\/diagnostic/),
        expect.stringMatching(/^HEAD \/private\/diagnostic/),
        expect.stringMatching(/^GET \/private\/diagnostic/),
      ]));
    } finally {
      await close(publicServer);
      await close(internalServer);
    }
  });
});
