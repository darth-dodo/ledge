export interface AppConfig {
  port: number;
  nodeEnv: string;
  databaseUrl: string;
  groqApiKey: string;
  jwtSecret: string;
  uploadDir: string;
  logLevel: string;
  corsOrigin: string;
}

export function loadConfig(): AppConfig {
  const missing: string[] = [];

  const databaseUrl = process.env.DATABASE_URL;
  const groqApiKey = process.env.GROQ_API_KEY;
  const jwtSecret = process.env.JWT_SECRET;

  if (!databaseUrl) missing.push('DATABASE_URL');
  if (!groqApiKey) missing.push('GROQ_API_KEY');
  if (!jwtSecret) missing.push('JWT_SECRET');

  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }

  return {
    port: Number(process.env.PORT ?? 3000),
    nodeEnv: process.env.NODE_ENV ?? 'development',
    databaseUrl: databaseUrl!,
    groqApiKey: groqApiKey!,
    jwtSecret: jwtSecret!,
    uploadDir: process.env.UPLOAD_DIR ?? './uploads',
    logLevel: process.env.LOG_LEVEL ?? 'info',
    corsOrigin: process.env.CORS_ORIGIN ?? '*',
  };
}
