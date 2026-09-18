import { describe, expect, it, vi } from 'vitest';
import type { ConfluenceClient } from '../src/client/confluence-client.js';
import {
  collectCursorPages,
  getPageContext,
  reconstructContentTree,
  searchAndFetch,
} from '../src/tools/high-level.js';

function response(data: unknown): { data: unknown; headers: Headers } {
  return { data, headers: new Headers() };
}

function mockClient(handler: (path: string, query?: Record<string, unknown>) => unknown) {
  return {
    requestJson: vi.fn(async (_method: string, path: string, query?: Record<string, unknown>) =>
      response(handler(path, query)),
    ),
  } as unknown as ConfluenceClient;
}

describe('high-level pagination and tree helpers', () => {
  it('consumes cursor pages internally and exposes a budget truncation', async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(response({ results: [1, 2, 3], _links: { next: '?cursor=next' } }))
      .mockResolvedValueOnce(response({ results: [4] }));

    const result = await collectCursorPages(request, 3);

    expect(result.items).toEqual([1, 2, 3]);
    expect(result.pagesFetched).toBe(1);
    expect(result.truncated).toBe(true);
    expect(result.nextCursor).toBe('next');
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('reconstructs parent-child relationships and child ordering', () => {
    const result = reconstructContentTree({ id: 'root', title: 'Root', type: 'page', depth: 0 }, [
      { id: 'grandchild', title: 'Grandchild', parentId: 'child', depth: 2, childPosition: 0 },
      { id: 'child', title: 'Child', parentId: 'root', depth: 1, childPosition: 1 },
      { id: 'sibling', title: 'Sibling', parentId: 'root', depth: 1, childPosition: 0 },
    ]);

    expect(result.root.children.map((item) => item.id)).toEqual(['sibling', 'child']);
    expect(result.root.children[1]?.children[0]?.id).toBe('grandchild');
    expect(result.warnings).toEqual([]);
  });
});

describe('high-level combined reads', () => {
  it('searches once and fetches only the requested top pages with bounded bodies', async () => {
    const client = mockClient((path) => {
      if (path === '/wiki/rest/api/search') {
        return {
          results: [
            { title: 'One', content: { id: '1', type: 'page' } },
            { title: 'Two', content: { id: '2', type: 'page' } },
            { title: 'Three', content: { id: '3', type: 'page' } },
          ],
          totalSize: 3,
        };
      }
      return { id: path.split('/').pop(), body: { storage: { value: 'x'.repeat(30) } } };
    });

    const result = await searchAndFetch(client, {
      cql: 'type=page',
      searchLimit: 10,
      fetchTop: 2,
      start: 0,
      bodyFormat: 'storage',
      maxCharsPerPage: 10,
      fetchConcurrency: 2,
    });

    expect(client.requestJson).toHaveBeenCalledTimes(3);
    expect(result.search).toMatchObject({ fetchedCount: 2, fetchRequested: 2 });
    expect(result.results).toHaveLength(2);
    expect(JSON.stringify(result.results)).toContain('body truncated');
  });

  it('returns partial status when an optional context section fails', async () => {
    const client = {
      requestJson: vi.fn(async (_method: string, path: string) => {
        if (path.endsWith('/ancestors')) throw new Error('permission denied');
        return response({ id: '1', body: { storage: { value: 'body' } } });
      }),
    } as unknown as ConfluenceClient;

    const result = await getPageContext(client, {
      pageId: '1',
      bodyFormat: 'storage',
      includeAncestors: true,
      includeAttachments: false,
      includeComments: false,
      commentTypes: ['footer'],
      maxItemsPerSection: 10,
    });

    expect(result.status).toMatchObject({ partial: true });
    expect(JSON.stringify(result.sections)).toContain('permission denied');
  });
});
