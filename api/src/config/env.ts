import { z } from 'zod';

const pgUrl = z
  .string()
  .min(1)
  .refine((v) => v.startsWith('postgres://') || v.startsWith('postgresql://'), {
    message: 'must be a postgres:// connection string',
  });

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),

  DATABASE_URL: pgUrl,
  N8N_DATABASE_URL: pgUrl,

  N8N_CALLBACK_BASE_URL: z.string().url().default('http://api:3000'),
  INTERNAL_CALLBACK_SECRET: z.string().min(16, 'must be at least 16 characters'),

  MIGRATIONS_DIR: z.string().min(1).default('./db/migrations'),

  PGPOOL_MAX: z.coerce.number().int().positive().default(10),
});

export type Env = z.infer<typeof envSchema>;

/**
 * Loads .env from the current working directory if present.
 *
 * This has to happen here rather than in each entry point because ESM hoists
 * static imports: a call placed before an import statement still executes
 * after that import's module body has already run. Since env validation runs
 * lazily on first pool access, doing the load inside loadEnv is the only place
 * guaranteed to run early enough.
 */
let envFileLoaded = false;

function loadEnvFileOnce(): void {
  if (envFileLoaded) return;
  envFileLoaded = true;
  try {
    process.loadEnvFile();
  } catch {
    // No .env present; process environment is authoritative.
  }
}

export function loadEnv(source?: NodeJS.ProcessEnv): Env {
  if (source === undefined) {
    loadEnvFileOnce();
    source = process.env;
  }

  const parsed = envSchema.safeParse(source);

  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `  ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${detail}`);
  }

  return parsed.data;
}