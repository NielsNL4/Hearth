export interface Config {
  host: string;
  port: number;
  corsOrigins: string[];
  supabaseUrl: string;
  supabaseServiceRoleKey: string;
  s3Endpoint: string;
  s3PublicEndpoint: string;
  s3Region: string;
  s3AccessKey: string;
  s3SecretKey: string;
  s3Bucket: string;
  s3ForcePathStyle: boolean;
  mapMaxPixels: number;
  tokenMaxPixels: number;
  processingConcurrency: number;
  uploadExpirySeconds: number;
  downloadExpirySeconds: number;
  removeTokenSource: boolean;
  internalSecret: string;
  staleReservationMinutes: number;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

function integer(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name];
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function bool(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = env[name];
  if (raw === undefined) return fallback;
  if (raw !== 'true' && raw !== 'false') throw new Error(`${name} must be true or false`);
  return raw === 'true';
}

function url(env: NodeJS.ProcessEnv, name: string): string {
  const value = required(env, name);
  const parsed = new URL(value);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error(`${name} must use http or https`);
  return value.replace(/\/$/, '');
}

function optionalUrl(env: NodeJS.ProcessEnv, name: string, fallback: string): string {
  if (!env[name]?.trim()) return fallback;
  return url(env, name);
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const corsOrigins = required(env, 'CORS_ORIGINS').split(',').map((entry) => entry.trim());
  if (corsOrigins.some((origin) => origin === '*' || new URL(origin).origin !== origin)) {
    throw new Error('CORS_ORIGINS must contain exact origins and cannot contain *');
  }
  return {
    host: env.HOST?.trim() || '0.0.0.0',
    port: integer(env, 'PORT', 3100, 1, 65535),
    corsOrigins,
    supabaseUrl: url(env, 'SUPABASE_URL'),
    supabaseServiceRoleKey: required(env, 'SUPABASE_SERVICE_ROLE_KEY'),
    s3Endpoint: url(env, 'S3_ENDPOINT'),
    s3PublicEndpoint: optionalUrl(env, 'S3_PUBLIC_ENDPOINT', url(env, 'S3_ENDPOINT')),
    s3Region: env.S3_REGION?.trim() || 'us-east-1',
    s3AccessKey: required(env, 'S3_ACCESS_KEY'),
    s3SecretKey: required(env, 'S3_SECRET_KEY'),
    s3Bucket: required(env, 'S3_BUCKET'),
    s3ForcePathStyle: bool(env, 'S3_FORCE_PATH_STYLE', true),
    mapMaxPixels: integer(env, 'MAP_MAX_PIXELS', 400_000_000, 1, 900_000_000),
    tokenMaxPixels: integer(env, 'TOKEN_MAX_PIXELS', 100_000_000, 1, 400_000_000),
    processingConcurrency: integer(env, 'PROCESSING_CONCURRENCY', 2, 1, 16),
    uploadExpirySeconds: integer(env, 'UPLOAD_EXPIRY_SECONDS', 900, 60, 3600),
    downloadExpirySeconds: integer(env, 'DOWNLOAD_EXPIRY_SECONDS', 300, 30, 900),
    removeTokenSource: bool(env, 'REMOVE_TOKEN_SOURCE', true),
    internalSecret: required(env, 'INTERNAL_JOB_SECRET'),
    staleReservationMinutes: integer(env, 'STALE_RESERVATION_MINUTES', 60, 5, 10_080),
  };
}
