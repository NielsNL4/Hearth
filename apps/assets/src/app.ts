import { timingSafeEqual } from 'node:crypto';
import cors from '@fastify/cors';
import Fastify from 'fastify';
import type { Config } from './config.js';
import { authenticate, authorizeAsset } from './authorization.js';
import { RequestError, UUID_PATTERN, assertRequestedOutputKeys, validateUpload } from './policy.js';
import type { ProcessingQueue } from './queue.js';
import type { AssetProcessor } from './processor.js';
import type { AssetManifest, AssetRepository, ObjectStore } from './types.js';

interface Dependencies {
  config: Config;
  repository: AssetRepository;
  store: ObjectStore;
  queue: ProcessingQueue;
  processor: AssetProcessor;
}

function idFrom(params: unknown): string {
  const id = (params as { assetId?: unknown }).assetId;
  if (typeof id !== 'string' || !UUID_PATTERN.test(id)) throw new RequestError(400, 'A valid asset ID is required');
  return id;
}

function internalSecretMatches(expected: string, actual: string | undefined): boolean {
  if (!actual) return false;
  const expectedBytes = Buffer.from(expected);
  const actualBytes = Buffer.from(actual);
  return expectedBytes.length === actualBytes.length && timingSafeEqual(expectedBytes, actualBytes);
}

export async function buildApp(deps: Dependencies) {
  const app = Fastify({ logger: true, bodyLimit: 32 * 1024 });
  await app.register(cors, {
    origin(origin, callback) {
      if (!origin || deps.config.corsOrigins.includes(origin)) callback(null, true);
      else callback(new Error('Origin not allowed'), false);
    },
    methods: ['GET', 'POST'],
    allowedHeaders: ['authorization', 'content-type', 'x-internal-secret'],
    maxAge: 600,
  });

  app.get('/health', async () => ({ ok: true, queuedProcessing: deps.queue.size }));

  app.post('/v1/assets/:assetId/upload', async (request, reply) => {
    const user = await authenticate(deps.repository, request.headers.authorization);
    const asset = await authorizeAsset(deps.repository, idFrom(request.params), user.id);
    if (asset.created_by !== user.id) throw new RequestError(403, 'Only the reservation creator may upload this asset');
    const body = request.body as { contentType?: unknown; bytes?: unknown };
    if (!body || typeof body.contentType !== 'string' || typeof body.bytes !== 'number') throw new RequestError(400, 'contentType and bytes are required');
    const expectedBytes = validateUpload(asset, body.contentType, body.bytes);
    const upload = await deps.store.createUpload(asset.source_object_key, body.contentType, expectedBytes, deps.config.uploadExpirySeconds);
    await deps.repository.setStatus(asset.id, 'uploading');
    return reply.code(201).send({ method: 'POST', expiresIn: deps.config.uploadExpirySeconds, ...upload });
  });

  app.post('/v1/assets/:assetId/process', async (request, reply) => {
    const user = await authenticate(deps.repository, request.headers.authorization);
    const asset = await authorizeAsset(deps.repository, idFrom(request.params), user.id);
    if (asset.created_by !== user.id) throw new RequestError(403, 'Only the reservation creator may process this asset');
    if (asset.status !== 'uploading') throw new RequestError(409, 'Asset is not awaiting processing');
    const info = await deps.store.head(asset.source_object_key);
    if (info.bytes < 1 || info.bytes > validateUploadSizeForProcessing(asset.kind)) throw new RequestError(422, 'Uploaded object size is invalid');
    if (!deps.queue.enqueue(asset.id, () => deps.processor.process(asset))) throw new RequestError(409, 'Asset is already queued');
    return reply.code(202).send({ id: asset.id, status: 'queued' });
  });

  app.get('/v1/assets/:assetId/manifest', async (request) => {
    const user = await authenticate(deps.repository, request.headers.authorization);
    const asset = await authorizeAsset(deps.repository, idFrom(request.params), user.id);
    if (asset.status !== 'ready') throw new RequestError(409, 'Asset is not ready');
    return JSON.parse(await deps.store.getText(`${asset.output_object_prefix}manifest.json`)) as AssetManifest;
  });

  app.post('/v1/assets/:assetId/download-urls', async (request) => {
    const user = await authenticate(deps.repository, request.headers.authorization);
    const asset = await authorizeAsset(deps.repository, idFrom(request.params), user.id);
    if (asset.status !== 'ready') throw new RequestError(409, 'Asset is not ready');
    const body = request.body as { keys?: unknown };
    if (!body || !Array.isArray(body.keys) || body.keys.some((key) => typeof key !== 'string')) throw new RequestError(400, 'keys must be an array of strings');
    const keys = body.keys as string[];
    const manifest = JSON.parse(await deps.store.getText(`${asset.output_object_prefix}manifest.json`)) as AssetManifest;
    assertRequestedOutputKeys(asset, manifest.outputs.map((output) => output.key), keys);
    return {
      expiresIn: deps.config.downloadExpirySeconds,
      urls: Object.fromEntries(await Promise.all(keys.map(async (key) => [key, await deps.store.signDownload(key, deps.config.downloadExpirySeconds)]))),
    };
  });

  // Invoke from a trusted scheduler. It expires reservations that never requested an upload.
  app.post('/internal/jobs/cleanup-stale-reservations', async (request) => {
    const secret = Array.isArray(request.headers['x-internal-secret']) ? undefined : request.headers['x-internal-secret'];
    if (!internalSecretMatches(deps.config.internalSecret, secret)) throw new RequestError(401, 'Invalid internal secret');
    const before = new Date(Date.now() - deps.config.staleReservationMinutes * 60_000);
    const stale = await deps.repository.findStaleReservations(before, 500);
    await Promise.all(stale.map((asset) => deps.repository.setStatus(asset.id, 'failed', {
      error: { code: 'RESERVATION_EXPIRED', message: 'Upload reservation expired before use' },
    })));
    return { expired: stale.length, before: before.toISOString() };
  });

  app.setErrorHandler((error, _request, reply) => {
    const status = error instanceof RequestError ? error.statusCode : 500;
    if (status === 500) app.log.error(error);
    const message = error instanceof Error ? error.message : 'Request failed';
    void reply.code(status).send({ error: status === 500 ? 'Internal server error' : message });
  });
  return app;
}

function validateUploadSizeForProcessing(kind: 'map' | 'token'): number {
  return kind === 'map' ? 250 * 1024 * 1024 : 25 * 1024 * 1024;
}
