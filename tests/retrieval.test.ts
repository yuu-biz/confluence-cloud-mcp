import { describe, expect, it, vi } from 'vitest';
import type { ConfluenceClient } from '../src/client/confluence-client.js';
import {
  fetchContentTree,
  getCommentThread,
  searchAndFetch,
  searchPlan,
  versionHistoryFilter,
} from '../src/tools/high-level.js';
import { boundedJson, resolveOutputBudget } from '../src/tools/response.js';
import {
  DEEP_BRANCH_INDEXES,
  FIXTURE_BRANCH_COUNT,
  FIXTURE_ROOT_ID,
  VERSION_CONTAINER_ID,
  VERSION_HISTORY_ITEMS,
  midSizeTreeDescendants,
  treeWithVersionHistory,
} from './fixtures/tree.js';

function treeClient(
  options: { pageSize?: number; depthFilter?: boolean; withVersions?: boolean } = {},
) {
  const pageSize = options.pageSize ?? 1_000;
  const calls: Array<{ path: string; query?: Record<string, unknown> }> = [];
  const client = {
    requestJson: vi.fn(async (_method: string, path: string, query?: Record<string, unknown>) => {
      calls.push({ path, query });
      if (!path.endsWith('/descendants')) {
        return {
          data: { id: FIXTURE_ROOT_ID, title: 'Space Home', type: 'page' },
          headers: new Headers(),
        };
      }
      const depth = Number(query?.depth ?? 8);
      const source = options.withVersions ? treeWithVersionHistory() : midSizeTreeDescendants();
      const all =
        options.depthFilter === false ? source : source.filter((item) => item.depth <= depth);
      const offset = Number(query?.cursor ?? 0);
      const slice = all.slice(offset, offset + pageSize);
      const nextOffset = offset + slice.length;
      const more = nextOffset < all.length;
      return {
        data: { results: slice, ...(more ? { _links: { next: `?cursor=${nextOffset}` } } : {}) },
        headers: new Headers(),
      };
    }),
  } as unknown as ConfluenceClient;
  return { client, calls };
}

const treeArgs = {
  rootId: FIXTURE_ROOT_ID,
  rootType: 'page' as const,
  depth: 5,
  maxItems: 1_000,
  includeVersionHistory: false,
};

describe('compact content tree', () => {
  it('renders an indented outline instead of repeating node metadata', async () => {
    const { client } = treeClient();
    const result = await fetchContentTree(client, {
      ...treeArgs,
      outputMode: 'compact',
      budget: resolveOutputBudget(50_000),
    });

    const tree = result.tree as string;
    expect(tree.split('\n')[0]).toContain('Space Home [root-0]');
    expect(tree).toContain('- Branch Alpha/ [b0]');
    expect(tree).toContain('    - Alpha Detail 1.1 [b0-c0-g0]');
    // Structure is carried by indentation, so per-node metadata stays out of the rendering.
    expect(tree).not.toContain('parentId');
    expect(tree).not.toContain('childPosition');
    expect(result.treeNodes).toBeUndefined();

    const status = result.status as Record<string, unknown>;
    expect(status.mode).toBe('compact');
    expect(status.fetchedItems).toBe(midSizeTreeDescendants().length);
    expect(status.renderedItems).toBe(status.fetchedItems);
    expect(status.omittedItems).toBe(0);
    expect(status.truncated).toBe(false);
  });

  it('is far denser than the equivalent node objects', async () => {
    const { client } = treeClient();
    const budget = resolveOutputBudget(50_000);
    const compact = await fetchContentTree(client, {
      ...treeArgs,
      outputMode: 'compact',
      budget,
    });
    const detailed = await fetchContentTree(client, {
      ...treeArgs,
      outputMode: 'detailed',
      budget,
    });

    const compactChars = boundedJson(compact, 50_000).length;
    const detailedChars = JSON.stringify(detailed.treeNodes, null, 2).length;
    expect(compactChars).toBeLessThan(detailedChars / 3);
    // The whole fixture still fits one compact call at the default budget.
    expect(boundedJson(compact).length).toBeLessThanOrEqual(12_000);
  });

  it('drops depth before branches and reports the collapsed ones', async () => {
    const { client } = treeClient();
    const result = await fetchContentTree(client, {
      ...treeArgs,
      outputMode: 'compact',
      budget: resolveOutputBudget(3_000),
    });

    const tree = result.tree as string;
    const status = result.status as Record<string, unknown>;
    // Every top-level branch survives the squeeze.
    for (let index = 0; index < FIXTURE_BRANCH_COUNT; index += 1) {
      expect(tree).toContain(`[b${index}]`);
    }
    expect(status.renderedDepth).toBeLessThan(4);
    expect(status.renderedItems).toBeLessThan(status.fetchedItems as number);
    expect(status.omittedItems).toBeGreaterThan(0);
    expect(status.truncationReasons).toContain('output_budget');

    const omitted = result.omittedBranches as Array<Record<string, unknown>>;
    expect(omitted.length).toBeGreaterThan(0);
    expect(omitted[0]).toHaveProperty('fetchedDescendants');
    expect(result.nextStep).toContain('confluence_get_content_tree');
  });

  it('keeps every branch visible when even one level overflows the budget', async () => {
    const { client } = treeClient();
    const result = await fetchContentTree(client, {
      ...treeArgs,
      outputMode: 'compact',
      budget: resolveOutputBudget(1_000),
    });

    const status = result.status as Record<string, unknown>;
    const omitted = result.omittedBranches as Array<Record<string, unknown>>;
    expect(status.truncationReasons).toContain('output_budget');
    // Every branch is either rendered or named in omittedBranches; none is silently dropped.
    const tree = result.tree as string;
    for (let index = 0; index < FIXTURE_BRANCH_COUNT; index += 1) {
      const id = `b${index}`;
      const visible = tree.includes(`[${id}]`) || omitted.some((branch) => branch.id === id);
      expect(visible).toBe(true);
    }
    expect(tree.length).toBeLessThanOrEqual(1_000);
  });

  it('maps a large tree from one cheap outline read', async () => {
    const { client, calls } = treeClient();
    const result = await fetchContentTree(client, {
      ...treeArgs,
      outputMode: 'outline',
      budget: resolveOutputBudget(12_000),
    });

    const tree = result.tree as string;
    const status = result.status as Record<string, unknown>;
    expect(status.mode).toBe('outline');
    expect(status.depthRequested).toBe(2);
    expect(status.renderedItems).toBe(FIXTURE_BRANCH_COUNT);
    expect(tree).toContain('- Branch Alpha/ [b0] (4 children)');
    expect(tree.split('\n')).toHaveLength(FIXTURE_BRANCH_COUNT + 1);
    // Rendering one level is the point of outline mode, not a budget failure.
    expect(status.truncated).toBe(false);
    expect(result.nextStep).toContain('confluence_get_content_tree');
    // Outline never costs a request per branch: root plus one paginated descendants read.
    const descendantCalls = calls.filter((call) => call.path.endsWith('/descendants'));
    expect(descendantCalls).toHaveLength(1);
    expect(descendantCalls[0]?.query?.depth).toBe(2);
    expect(boundedJson(result).length).toBeLessThan(3_000);
  });

  it('separates pagination limits from output-budget omissions', async () => {
    const { client } = treeClient({ pageSize: 20 });
    const result = await fetchContentTree(client, {
      ...treeArgs,
      maxItems: 40,
      outputMode: 'compact',
      budget: resolveOutputBudget(50_000),
    });

    const status = result.status as Record<string, unknown>;
    expect(status.fetchedItems).toBe(40);
    expect(status.truncationReasons).toContain('max_items');
    expect(status.truncationReasons).not.toContain('output_budget');
    expect(status.nextCursor).toBeDefined();
    expect(status.paginationExhausted).toBe(false);
  });

  it('continues from a returned cursor instead of repeating the first page', async () => {
    const { client, calls } = treeClient({ pageSize: 20 });
    const first = await fetchContentTree(client, {
      ...treeArgs,
      maxItems: 20,
      outputMode: 'compact',
      budget: resolveOutputBudget(50_000),
    });
    const firstStatus = first.status as Record<string, unknown>;
    expect(firstStatus.nextCursor).toBeDefined();
    expect(first.nextStep).toContain('nextCursor');

    const second = await fetchContentTree(client, {
      ...treeArgs,
      maxItems: 20,
      outputMode: 'compact',
      budget: resolveOutputBudget(50_000),
      cursor: firstStatus.nextCursor as string,
    });
    const secondStatus = second.status as Record<string, unknown>;

    // The second call requests the cursor it was given and returns different content.
    const descendantCalls = calls.filter((call) => call.path.endsWith('/descendants'));
    expect(descendantCalls[0]?.query?.cursor).toBeUndefined();
    expect(descendantCalls[1]?.query?.cursor).toBe(firstStatus.nextCursor);
    expect(secondStatus.cursorUsed).toBe(firstStatus.nextCursor);
    expect(second.tree).not.toBe(first.tree);
    expect(secondStatus.nextCursor).not.toBe(firstStatus.nextCursor);
  });

  it('treats parents returned on an earlier page as expected, not as errors', async () => {
    const { client } = treeClient({ pageSize: 20 });
    const first = await fetchContentTree(client, {
      ...treeArgs,
      maxItems: 20,
      outputMode: 'compact',
      budget: resolveOutputBudget(50_000),
    });
    const second = await fetchContentTree(client, {
      ...treeArgs,
      maxItems: 20,
      outputMode: 'compact',
      budget: resolveOutputBudget(50_000),
      cursor: (first.status as Record<string, unknown>).nextCursor as string,
    });

    const status = second.status as Record<string, unknown>;
    expect(status.unresolvedParents).toBeGreaterThan(0);
    expect(status.truncationReasons).not.toContain('api_error');
    expect(status.errors).toBeUndefined();
    expect(second.nextStep).toContain('continues an earlier one');
  });

  it('points at the free budget headroom before suggesting more calls', async () => {
    const { client } = treeClient();
    const result = await fetchContentTree(client, {
      ...treeArgs,
      outputMode: 'compact',
      budget: resolveOutputBudget(3_000),
    });

    expect(result.nextStep).toContain('max_chars=50000');
    expect((result.status as Record<string, unknown>).truncationReasons).toContain('output_budget');
  });

  it('reports requested and effective output budgets', async () => {
    const { client } = treeClient();
    const result = await fetchContentTree(client, {
      ...treeArgs,
      outputMode: 'compact',
      budget: resolveOutputBudget(500_000),
    });

    expect((result.status as Record<string, unknown>).outputBudget).toMatchObject({
      requestedChars: 500_000,
      effectiveChars: 50_000,
      hardCapChars: 50_000,
    });
  });
});

describe('version history', () => {
  it('drops version containers and their subtrees by default', async () => {
    const { client } = treeClient({ withVersions: true });
    const result = await fetchContentTree(client, {
      ...treeArgs,
      outputMode: 'compact',
      budget: resolveOutputBudget(50_000),
    });

    const tree = result.tree as string;
    const status = result.status as Record<string, unknown>;
    expect(tree).not.toContain('Versions of');
    expect(tree).not.toContain(VERSION_CONTAINER_ID);
    expect(tree).not.toContain('Section 1 [');
    expect(status.excludedVersionHistory).toEqual({
      containers: 1,
      items: VERSION_HISTORY_ITEMS + 1,
    });
    // Excluded nodes do not count against the item budget.
    expect(status.fetchedItems).toBe(midSizeTreeDescendants().length);
  });

  it('keeps sibling branches reachable when one branch is buried in history', async () => {
    const { client } = treeClient({ withVersions: true });
    const withHistory = await fetchContentTree(client, {
      ...treeArgs,
      maxItems: 60,
      includeVersionHistory: true,
      outputMode: 'compact',
      budget: resolveOutputBudget(50_000),
    });
    const filtered = await fetchContentTree(client, {
      ...treeArgs,
      maxItems: 60,
      outputMode: 'compact',
      budget: resolveOutputBudget(50_000),
    });

    const historyTree = withHistory.tree as string;
    const filteredTree = filtered.tree as string;
    const branchesIn = (tree: string): number =>
      Array.from({ length: FIXTURE_BRANCH_COUNT }).filter((_, index) =>
        tree.includes(`[b${index}]`),
      ).length;
    expect(historyTree).toContain('Versions of Alpha Page 1');
    expect(branchesIn(filteredTree)).toBeGreaterThan(branchesIn(historyTree));
  });

  it('excludes a whole container subtree even across pages', () => {
    const filter = versionHistoryFilter();
    const stream = [
      { id: 'doc', title: 'Doc', parentId: 'root' },
      { id: 'versions', title: 'Versions of Doc', parentId: 'doc' },
      { id: 'v1', title: 'Doc v1', parentId: 'versions' },
      { id: 'v1-s1', title: 'Doc v1 Section 1', parentId: 'v1' },
      { id: 'other', title: 'Other Doc', parentId: 'root' },
    ];
    expect(stream.filter((item) => filter.keep(item)).map((item) => item.id)).toEqual([
      'doc',
      'other',
    ]);
    expect(filter.excludedRoots).toBe(1);
    expect(filter.excludedItems).toBe(3);
  });
});

describe('comment threads', () => {
  it('bounds a wide thread by max_items and reports the truncation', async () => {
    const replies = Array.from({ length: 40 }, (_, index) => ({ id: `r${index}` }));
    const client = {
      requestJson: vi.fn(async (_method: string, path: string) => {
        if (path.endsWith('/children')) {
          return {
            data: { results: path.includes('/root/') ? replies : [] },
            headers: new Headers(),
          };
        }
        return { data: { id: 'root', title: 'Thread root' }, headers: new Headers() };
      }),
    } as unknown as ConfluenceClient;

    const result = await getCommentThread(client, {
      commentId: 'root',
      commentType: 'footer',
      bodyFormat: 'storage',
      maxDepth: 3,
      maxItems: 10,
      budget: resolveOutputBudget(),
    });

    const status = result.status as Record<string, unknown>;
    expect(status.itemsReturned).toBe(10);
    expect(status.truncated).toBe(true);
    // The call budget is respected rather than one request per reply.
    expect(status.apiCalls as number).toBeLessThanOrEqual(60);
    expect(status.outputBudget).toMatchObject({ effectiveChars: 12_000 });
  });
});

describe('output budget', () => {
  it('uses the budget instead of collapsing deep structures at the first attempt', () => {
    const deep = (id: string, depth: number): Record<string, unknown> => ({
      id,
      title: `Node ${id}`,
      children: depth < 6 ? [deep(`${id}.0`, depth + 1), deep(`${id}.1`, depth + 1)] : [],
    });
    const payload = { root: deep('r', 0) };
    const full = JSON.stringify(payload, null, 2);
    expect(full.length).toBeGreaterThan(20_000);

    const bounded = boundedJson(payload, 50_000);
    expect(bounded.length).toBeLessThanOrEqual(50_000);
    // The old single-pass shrink returned a much smaller payload full of depth placeholders.
    expect(bounded).not.toContain('[depth omitted]');
  });
});

describe('search semantics', () => {
  it('builds exact title, prefix, and full-text CQL from a plain query', () => {
    expect(searchPlan({ mode: 'exact_title', query: 'AB12-C' })).toEqual([
      { mode: 'exact_title', cql: 'title = "AB12-C"' },
    ]);
    expect(searchPlan({ mode: 'title_prefix', query: 'AB12-C' })).toEqual([
      { mode: 'title_prefix', cql: 'title ~ "AB12-C*"' },
    ]);
    expect(searchPlan({ mode: 'full_text', query: 'AB12-C' })).toEqual([
      { mode: 'full_text', cql: 'text ~ "AB12-C"' },
    ]);
    expect(searchPlan({ mode: 'title_prefix', query: 'AB12*' })[0]?.cql).toBe('title ~ "AB12*"');
    expect(searchPlan({ mode: 'exact_title', query: 'say "hi"' })[0]?.cql).toBe(
      'title = "say \\"hi\\""',
    );
  });

  it('keeps raw CQL as an escape hatch', () => {
    expect(searchPlan({ mode: 'cql', cql: 'label = "x" and type = page' })).toEqual([
      { mode: 'cql', cql: 'label = "x" and type = page' },
    ]);
    expect(searchPlan({ mode: 'auto', cql: 'type = blogpost' })).toEqual([
      { mode: 'cql', cql: 'type = blogpost' },
    ]);
    expect(() => searchPlan({ mode: 'auto' })).toThrow(/Provide query/);
  });

  it('widens from exact title to full text only until something matches', async () => {
    const hits = [{ title: 'AB12-C', content: { id: '10', type: 'page' } }];
    const client = {
      requestJson: vi.fn(async (_method: string, path: string, query?: Record<string, unknown>) => {
        if (path === '/wiki/rest/api/search') {
          const cql = String(query?.cql ?? '');
          return { data: { results: cql.includes('*') ? hits : [] }, headers: new Headers() };
        }
        return { data: { id: '10', body: { storage: { value: 'body' } } }, headers: new Headers() };
      }),
    } as unknown as ConfluenceClient;

    const result = await searchAndFetch(client, {
      mode: 'auto',
      query: 'AB12-C',
      searchLimit: 25,
      fetchTop: 1,
      start: 0,
      bodyFormat: 'storage',
      maxCharsPerPage: 5_000,
      fetchConcurrency: 2,
      budget: resolveOutputBudget(),
    });

    const strategy = result.strategy as Record<string, unknown>;
    expect(strategy.searchMode).toBe('title_prefix');
    expect(strategy.cqlUsed).toBe('title ~ "AB12-C*"');
    expect(strategy.attempts).toHaveLength(2);
    // Stops as soon as a mode matches: no full-text call was made.
    expect((result.status as Record<string, unknown>).searchApiCalls).toBe(2);
  });
});

describe('deep fixture branches', () => {
  it('only the deep branches carry grandchildren', () => {
    const items = midSizeTreeDescendants();
    const deepBranchIds = DEEP_BRANCH_INDEXES.map((index) => `b${index}`);
    const deepItems = items.filter((item) => item.depth >= 3);
    for (const item of deepItems) {
      expect(deepBranchIds.some((id) => item.id.startsWith(`${id}-`))).toBe(true);
    }
  });
});
