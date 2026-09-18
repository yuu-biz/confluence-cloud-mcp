import { describe, expect, it } from 'vitest';
import { assertSafeRawPath } from '../src/tools/index.js';
import { boundedJson } from '../src/tools/response.js';

describe('raw path safety', () => {
  it('allows only Confluence REST paths', () => {
    expect(() => assertSafeRawPath('/wiki/api/v2/pages/1')).not.toThrow();
    expect(() => assertSafeRawPath('/wiki/rest/api/search')).not.toThrow();
    expect(() => assertSafeRawPath('https://example.atlassian.net/wiki/api/v2/pages')).toThrow();
    expect(() => assertSafeRawPath('/wiki/api/v2/../admin-key')).toThrow();
    expect(() => assertSafeRawPath('/wiki/api/v2/pages?cursor=secret')).toThrow();
    expect(() => assertSafeRawPath('/wiki/api/v2/%2e%2e/%2e%2e/rest/api/3/myself')).toThrow();
  });
});

describe('response bounds', () => {
  it('keeps large responses within the requested bound', () => {
    const result = boundedJson(
      { body: 'x'.repeat(100_000), values: Array.from({ length: 500 }, (_, index) => index) },
      2_000,
    );
    expect(result.length).toBeLessThanOrEqual(2_000);
    expect(result).toContain('truncated');
  });
});
