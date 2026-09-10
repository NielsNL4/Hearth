import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { AssetProcessor } from './processor.js';
import { ProcessingQueue } from './queue.js';
import { SupabaseRepository } from './repository.js';
import { S3ObjectStore } from './storage.js';

const config = loadConfig(process.env);
const repository = new SupabaseRepository(config.supabaseUrl, config.supabaseServiceRoleKey);
const store = new S3ObjectStore(config);
await store.ensurePrivateBucket();
const queue = new ProcessingQueue(config.processingConcurrency);
const processor = new AssetProcessor(repository, store, config);
const app = await buildApp({ config, repository, store, queue, processor });

await app.listen({ host: config.host, port: config.port });

async function shutdown(signal: string) {
  app.log.info({ signal }, 'Shutting down');
  await app.close();
  process.exit(0);
}
process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));
