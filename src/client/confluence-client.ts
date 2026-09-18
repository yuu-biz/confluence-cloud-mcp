import { ConfluenceApiError } from './errors.js';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
export type QueryValue = string | number | boolean | Array<string | number> | undefined;
export type QueryParams = Record<string, QueryValue>;

export interface ApiResponse<T> {
  data: T;
  status: number;
  headers: Headers;
  url: string;
}

export interface ConfluenceClientOptions {
  baseUrl: string;
  email: string;
  apiToken: string;
  requestTimeoutMs?: number;
  maxRetries?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 3;
const MAX_ERROR_TEXT = 500;

function toQueryString(query: QueryParams | undefined): string {
  if (!query) return '';
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) params.append(key, String(item));
    } else {
      params.set(key, String(value));
    }
  }
  const value = params.toString();
  return value ? `?${value}` : '';
}

function retryDelayMs(response: Response, attempt: number): number {
  const retryAfter = response.headers.get('retry-after');
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.min(Math.max(seconds * 1_000, 100), 15_000);
    const timestamp = Date.parse(retryAfter);
    if (Number.isFinite(timestamp)) return Math.min(Math.max(timestamp - Date.now(), 100), 15_000);
  }
  return Math.min(250 * 2 ** attempt, 4_000);
}

function redact(value: string, email: string, apiToken: string): string {
  return value.replaceAll(apiToken, '[REDACTED]').replaceAll(email, '[REDACTED]');
}

async function readBody(response: Response): Promise<unknown> {
  if (response.status === 204) return undefined;
  const text = await response.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function errorText(body: unknown, email: string, apiToken: string): string {
  let text = 'Request failed';
  if (typeof body === 'string') text = body;
  else if (body && typeof body === 'object') {
    const record = body as Record<string, unknown>;
    const messages = record.message ?? record.errorMessages ?? record.errors;
    text = typeof messages === 'string' ? messages : JSON.stringify(messages ?? record);
  }
  return redact(text.slice(0, MAX_ERROR_TEXT), email, apiToken);
}

function statusHint(status: number): string {
  if (status === 401) return ' Check the Confluence site URL, email, and API token.';
  if (status === 403) return ' The authenticated user lacks the required Confluence permission.';
  if (status === 404)
    return ' The resource may not exist or may not be visible to the authenticated user.';
  if (status === 429) return ' Confluence rate limited the request; retry later.';
  return '';
}

export class ConfluenceClient {
  private readonly baseUrl: string;
  private readonly authHeader: string;
  private readonly email: string;
  private readonly apiToken: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: ConfluenceClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.email = options.email;
    this.apiToken = options.apiToken;
    this.authHeader = `Basic ${Buffer.from(`${options.email}:${options.apiToken}`, 'utf8').toString('base64')}`;
    this.timeoutMs = options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async request<T>(
    method: HttpMethod,
    path: string,
    query?: QueryParams,
    body?: unknown,
  ): Promise<ApiResponse<T>> {
    if (!path.startsWith('/') || path.includes('://')) throw new Error('API path must be relative');
    const url = `${this.baseUrl}${path}${toQueryString(query)}`;
    const headers = new Headers({
      Accept: 'application/json',
      Authorization: this.authHeader,
    });
    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      headers.set('Content-Type', 'application/json');
      init.body = JSON.stringify(body);
    }

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
      let response: Response;
      try {
        response = await this.fetchImpl(url, { ...init, signal: controller.signal });
      } catch (error) {
        if (attempt < this.maxRetries) {
          await this.sleep(Math.min(250 * 2 ** attempt, 4_000));
          continue;
        }
        if (error instanceof DOMException && error.name === 'AbortError') {
          throw new Error(`Confluence request timed out after ${this.timeoutMs} ms`);
        }
        throw new Error('Confluence request failed before receiving a response');
      } finally {
        clearTimeout(timeout);
      }

      if ((response.status === 429 || response.status >= 500) && attempt < this.maxRetries) {
        await this.sleep(retryDelayMs(response, attempt));
        continue;
      }

      const responseBody = await readBody(response);
      if (!response.ok) {
        const requestId =
          response.headers.get('x-request-id') ?? response.headers.get('atl-traceid') ?? undefined;
        const retryAfterMs = response.status === 429 ? retryDelayMs(response, attempt) : undefined;
        throw new ConfluenceApiError(
          `${errorText(responseBody, this.email, this.apiToken)}.${statusHint(response.status)}`,
          response.status,
          requestId,
          retryAfterMs,
        );
      }
      return { data: responseBody as T, status: response.status, headers: response.headers, url };
    }
    throw new Error('Confluence request failed');
  }

  requestJson<T>(
    method: HttpMethod,
    path: string,
    query?: QueryParams,
    body?: unknown,
  ): Promise<ApiResponse<T>> {
    return this.request<T>(method, path, query, body);
  }

  async uploadAttachment(
    pageId: string,
    file: Blob,
    filename: string,
    comment?: string,
  ): Promise<ApiResponse<unknown>> {
    const url = `${this.baseUrl}/wiki/rest/api/content/${encodeURIComponent(pageId)}/child/attachment`;
    const form = new FormData();
    form.append('file', file, filename);
    if (comment) form.append('comment', comment);
    const headers = new Headers({
      Accept: 'application/json',
      Authorization: this.authHeader,
      'X-Atlassian-Token': 'no-check',
    });
    const response = await this.fetchImpl(url, { method: 'POST', headers, body: form });
    const responseBody = await readBody(response);
    if (!response.ok) {
      const requestId =
        response.headers.get('x-request-id') ?? response.headers.get('atl-traceid') ?? undefined;
      throw new ConfluenceApiError(
        `${errorText(responseBody, this.email, this.apiToken)}.${statusHint(response.status)}`,
        response.status,
        requestId,
      );
    }
    return { data: responseBody, status: response.status, headers: response.headers, url };
  }
}

export function extractNextCursor(data: unknown, headers?: Headers): string | undefined {
  const next =
    data && typeof data === 'object'
      ? (data as { _links?: { next?: unknown } })._links?.next
      : undefined;
  const candidates = [
    typeof next === 'string' ? next : undefined,
    headers?.get('link') ?? undefined,
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const match = candidate.match(/[?&]cursor=([^&>]+)/);
    if (match?.[1]) return decodeURIComponent(match[1]);
  }
  return undefined;
}
