import { listen } from '@colyseus/tools';
import { readEnvironment } from './config.js';
import { createServerConfig } from './server.js';
import { createSupabaseServices } from './supabase.js';

const environment = readEnvironment();
const services = createSupabaseServices(environment.SUPABASE_URL, environment.SUPABASE_SERVICE_ROLE_KEY);
await listen(createServerConfig({
  ...services,
  reconnectionSeconds: environment.RECONNECTION_SECONDS,
  engine: {
    previewIntervalMs: environment.PREVIEW_INTERVAL_MS,
    previewExpiryMs: environment.PREVIEW_EXPIRY_MS,
  },
}), environment.PORT);
