export interface AppConfig {
  baseUrl: string;
  email: string;
  apiToken: string;
  allowDestructiveOperations: boolean;
  allowRawWrite: boolean;
  allowLocalFileUpload: boolean;
  requestTimeoutMs: number;
  maxRetries: number;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required configuration: ${name}`);
  }
  return value;
}

function booleanValue(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = env[name]?.trim().toLowerCase();
  if (raw === undefined || raw === '') return fallback;
  if (raw === 'true' || raw === '1' || raw === 'yes') return true;
  if (raw === 'false' || raw === '0' || raw === 'no') return false;
  throw new Error(`${name} must be true or false`);
}

function integerValue(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = env[name]?.trim();
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function normalizeBaseUrl(raw: string, allowCustomDomain: boolean): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('CONFLUENCE_BASE_URL must be a valid HTTPS URL');
  }
  const hostname = url.hostname.toLowerCase();
  const isAtlassianCloud = hostname === 'atlassian.net' || hostname.endsWith('.atlassian.net');
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error(
      'CONFLUENCE_BASE_URL must be an HTTPS origin without credentials or query data',
    );
  }
  if (!allowCustomDomain && !isAtlassianCloud) {
    throw new Error(
      'CONFLUENCE_BASE_URL must use an atlassian.net hostname; set CONFLUENCE_ALLOW_CUSTOM_DOMAIN=true for a verified custom domain',
    );
  }
  return url.origin;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const allowCustomDomain = booleanValue(env, 'CONFLUENCE_ALLOW_CUSTOM_DOMAIN', false);
  return {
    baseUrl: normalizeBaseUrl(required(env, 'CONFLUENCE_BASE_URL'), allowCustomDomain),
    email: required(env, 'CONFLUENCE_EMAIL'),
    apiToken: required(env, 'CONFLUENCE_API_TOKEN'),
    allowDestructiveOperations: booleanValue(env, 'CONFLUENCE_ALLOW_DESTRUCTIVE_OPERATIONS', false),
    allowRawWrite: booleanValue(env, 'CONFLUENCE_ALLOW_RAW_WRITE', false),
    allowLocalFileUpload: booleanValue(env, 'CONFLUENCE_ALLOW_LOCAL_FILE_UPLOAD', false),
    requestTimeoutMs: integerValue(env, 'CONFLUENCE_REQUEST_TIMEOUT_MS', 30_000, 5_000, 120_000),
    maxRetries: integerValue(env, 'CONFLUENCE_MAX_RETRIES', 3, 0, 5),
  };
}
