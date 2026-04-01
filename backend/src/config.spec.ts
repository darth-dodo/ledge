import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { loadConfig } from './config';

const REQUIRED_VARS = {
  DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
  GROQ_API_KEY: 'test-groq-key',
  JWT_SECRET: 'test-jwt-secret',
};

const OPTIONAL_VARS = ['PORT', 'NODE_ENV', 'LOG_LEVEL', 'CORS_ORIGIN', 'UPLOAD_DIR'];

let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = {
    ...Object.fromEntries(
      [...Object.keys(REQUIRED_VARS), ...OPTIONAL_VARS].map((k) => [k, process.env[k]]),
    ),
  };

  // Set required vars by default
  for (const [key, value] of Object.entries(REQUIRED_VARS)) {
    process.env[key] = value;
  }

  // Clear optional vars to test defaults
  for (const key of OPTIONAL_VARS) {
    delete process.env[key];
  }
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

describe('loadConfig', () => {
  test('returns correct defaults when optional vars are missing', () => {
    const config = loadConfig();

    expect(config.port).toBe(3000);
    expect(config.nodeEnv).toBe('development');
    expect(config.logLevel).toBe('info');
    expect(config.corsOrigin).toBe('*');
    expect(config.uploadDir).toBe('./uploads');
  });

  test('reads required vars from environment', () => {
    const config = loadConfig();

    expect(config.databaseUrl).toBe(REQUIRED_VARS.DATABASE_URL);
    expect(config.groqApiKey).toBe(REQUIRED_VARS.GROQ_API_KEY);
    expect(config.jwtSecret).toBe(REQUIRED_VARS.JWT_SECRET);
  });

  test('throws when all required vars are missing', () => {
    delete process.env.DATABASE_URL;
    delete process.env.GROQ_API_KEY;
    delete process.env.JWT_SECRET;

    expect(() => loadConfig()).toThrow('DATABASE_URL, GROQ_API_KEY, JWT_SECRET');
  });

  test('throws when a single required var is missing', () => {
    delete process.env.DATABASE_URL;

    expect(() => loadConfig()).toThrow('DATABASE_URL');
  });

  test('lists all missing vars in error, not just the first', () => {
    delete process.env.DATABASE_URL;
    delete process.env.JWT_SECRET;

    expect(() => loadConfig()).toThrow('DATABASE_URL, JWT_SECRET');
  });

  test('parses PORT as a number', () => {
    process.env.PORT = '8080';
    const config = loadConfig();

    expect(config.port).toBe(8080);
    expect(typeof config.port).toBe('number');
  });

  test('uses provided optional values over defaults', () => {
    process.env.PORT = '4000';
    process.env.NODE_ENV = 'production';
    process.env.LOG_LEVEL = 'debug';
    process.env.CORS_ORIGIN = 'https://example.com';
    process.env.UPLOAD_DIR = '/var/uploads';

    const config = loadConfig();

    expect(config.port).toBe(4000);
    expect(config.nodeEnv).toBe('production');
    expect(config.logLevel).toBe('debug');
    expect(config.corsOrigin).toBe('https://example.com');
    expect(config.uploadDir).toBe('/var/uploads');
  });
});
