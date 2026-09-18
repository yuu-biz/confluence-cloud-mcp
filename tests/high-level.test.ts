import { describe, expect, it, vi } from 'vitest';
import type { ConfluenceClient } from '../src/client/confluence-client.js';
import {
  collectCursorPages,
  getCommentThread,
  getPageContext,
  getSpaceOverview,
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

describe('high-level traversal budgets', () => {
  it('walks a comment thread level by level and reports depth truncation', async () => {
    const children: Record<string, unknown[]> = {
      root: [{ id: 'reply-1' }, { id: 'reply-2' }],
      'reply-1': [{ id: 'reply-1-1' }],
    };
    const client = mockClient((path) => {
      const match = /footer-comments\/([^/]+)\/children$/.exec(path);
      if (match) return { results: children[match[1] ?? ''] ?? [] };
      return { id: 'root', body: { storage: { value: 'root comment' } } };
    });

    const result = await getCommentThread(client, {
      commentId: 'root',
      commentType: 'footer',
      bodyFormat: 'storage',
      maxDepth: 2,
      maxItems: 50,
    });

    const root = result.root as { replies?: Array<{ id: string; replies?: unknown[] }> };
    expect(root.replies?.map((reply) => reply.id)).toEqual(['reply-1', 'reply-2']);
    expect(root.replies?.[0]?.replies).toHaveLength(1);
    // root + two level-2 comments, so no call is made for the leaf level.
    expect(client.requestJson).toHaveBeenCalledTimes(4);
    expect(result.status).toMatchObject({ itemsReturned: 4, truncated: true, partial: false });
  });

  it('resolves a space key without an extra caller round trip', async () => {
    const client = mockClient((path) => {
      if (path === '/wiki/api/v2/spaces') return { results: [{ id: '900', key: 'DOCS' }] };
      if (path === '/wiki/api/v2/spaces/900') return { id: '900', homepageId: '5' };
      if (path === '/wiki/api/v2/pages/5') return { id: '5', title: 'Home' };
      return { results: [{ id: '6', title: 'Child', parentId: '5', depth: 1 }] };
    });

    const result = await getSpaceOverview(client, {
      spaceKey: 'DOCS',
      rootType: 'page',
      depth: 2,
      maxItems: 100,
    });

    expect(result.spaceId).toBe('900');
    const tree = result.tree as { root: { children: Array<{ id: string }> } };
    expect(tree.root.children.map((child) => child.id)).toEqual(['6']);
    expect(client.requestJson).toHaveBeenCalledTimes(4);
  });
});
