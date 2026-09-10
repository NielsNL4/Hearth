import { z } from 'zod';

const environmentSchema = z.object({
  SUPABASE_URL: z.url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  PORT: z.coerce.number().int().min(1).max(65535).default(2567),
  RECONNECTION_SECONDS: z.union([z.literal('manual'), z.coerce.number().int().positive()]).default(20),
  PREVIEW_INTERVAL_MS: z.coerce.number().int().nonnegative().default(30),
  PREVIEW_EXPIRY_MS: z.coerce.number().int().positive().default(2000),
});

export function readEnvironment(environment: NodeJS.ProcessEnv = process.env) {
  return environmentSchema.parse(environment);
}
