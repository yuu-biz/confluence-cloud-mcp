import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('configuration', () => {
  it('loads safe defaults', () => {
    const config = loadConfig({
      CONFLUENCE_BASE_URL: 'https://example.atlassian.net',
      CONFLUENCE_EMAIL: 'user@example.com',
      CONFLUENCE_API_TOKEN: 'fixture',
    });
    expect(config.allowDestructiveOperations).toBe(false);
    expect(config.allowRawWrite).toBe(false);
    expect(config.allowLocalFileUpload).toBe(false);
    expect(config.baseUrl).toBe('https://example.atlassian.net');
  });

  it('rejects non-Atlassian URLs by default', () => {
    expect(() =>
      loadConfig({
        CONFLUENCE_BASE_URL: 'https://internal.example.com',
        CONFLUENCE_EMAIL: 'user@example.com',
        CONFLUENCE_API_TOKEN: 'fixture',
      }),
    ).toThrow(/atlassian\.net/);
  });
});
