import { describe, expect, it, vi } from 'vitest';
import { ConfluenceClient, extractNextCursor } from '../src/client/confluence-client.js';
import { ConfluenceApiError } from '../src/client/errors.js';

function response(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

describe('ConfluenceClient', () => {
  it('uses Basic auth and encodes query arrays', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response({ results: [] }));
    const client = new ConfluenceClient({
      baseUrl: 'https://example.atlassian.net',
      email: 'user@example.com',
      apiToken: 'fixture',
      fetchImpl,
      maxRetries: 0,
    });
    await client.requestJson('GET', '/wiki/api/v2/pages', {
      status: ['current', 'draft'],
      limit: 25,
    });
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(String(url)).toContain('status=current');
    expect(String(url)).toContain('status=draft');
    expect((init?.headers as Headers).get('authorization')).toMatch(/^Basic /);
  });

  it('retries 429 and then returns the response', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response({ message: 'slow down' }, 429, { 'retry-after': '0' }))
      .mockResolvedValueOnce(response({ ok: true }));
    const sleep = vi.fn().mockResolvedValue(undefined);
    const client = new ConfluenceClient({
      baseUrl: 'https://example.atlassian.net',
      email: 'user@example.com',
      apiToken: 'fixture',
      fetchImpl,
      sleep,
      maxRetries: 1,
    });
    const result = await client.requestJson('GET', '/wiki/api/v2/pages');
    expect(result.data).toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalled();
  });

  it('sanitizes API error content and exposes status', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(async () =>
        response({ message: 'permission denied' }, 403, { 'x-request-id': 'request-123' }),
      );
    const client = new ConfluenceClient({
      baseUrl: 'https://example.atlassian.net',
      email: 'user@example.com',
      apiToken: 'fixture',
      fetchImpl,
      maxRetries: 0,
    });
    await expect(client.requestJson('GET', '/wiki/api/v2/pages/1')).rejects.toMatchObject({
      status: 403,
      requestId: 'request-123',
    });
    try {
      await client.requestJson('GET', '/wiki/api/v2/pages/1');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfluenceApiError);
      expect((error as Error).message).toContain('permission denied');
    }
  });
});

describe('pagination', () => {
  it('extracts v2 cursor from a next link', () => {
    expect(extractNextCursor({ _links: { next: '/wiki/api/v2/pages?cursor=abc%2B123' } })).toBe(
      'abc+123',
    );
    expect(
      extractNextCursor(
        { results: [] },
        new Headers({ link: '</wiki/api/v2/pages?cursor=next-token>; rel="next"' }),
      ),
    ).toBe('next-token');
  });
});
