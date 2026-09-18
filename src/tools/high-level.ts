import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ConfluenceClient } from '../client/confluence-client.js';
import { extractNextCursor } from '../client/confluence-client.js';
import { publicErrorMessage } from '../client/errors.js';
import { toolResult } from './response.js';

type JsonRecord = Record<string, unknown>;
type ClientResponse = { data: unknown; headers: Headers };

const bodyFormat = z
  .enum(['storage', 'atlas_doc_format', 'view', 'export_view', 'styled_view'])
  .default('storage');
const maxChars = z.number().int().min(1_000).max(50_000).optional();

const TREE_MAX_DEPTH = 8;
const TREE_MAX_ITEMS = 1_000;
const DEFAULT_TREE_DEPTH = 3;
const DEFAULT_TREE_ITEMS = 200;
const DEFAULT_SECTION_ITEMS = 50;
const MAX_SECTION_ITEMS = 250;
const DEFAULT_SEARCH_FETCH = 5;
const MAX_SEARCH_FETCH = 20;
const DEFAULT_FETCH_CONCURRENCY = 3;
const MAX_FETCH_CONCURRENCY = 5;

function asRecord(value: unknown): JsonRecord | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : undefined;
}

function resultItems<T>(data: unknown): T[] {
  const record = asRecord(data);
  return Array.isArray(record?.results) ? (record.results as T[]) : [];
}

function compactContentItem(value: unknown, fallbackDepth = 1): ContentTreeItem | undefined {
  const record = asRecord(value);
  const itemId = stringValue(record?.id);
  if (!itemId) return undefined;
  const depth = typeof record?.depth === 'number' ? record.depth : fallbackDepth;
  return {
    id: itemId,
    title: stringValue(record?.title),
    type: stringValue(record?.type),
    status: stringValue(record?.status),
    parentId: stringValue(record?.parentId),
    depth,
    childPosition: typeof record?.childPosition === 'number' ? record.childPosition : undefined,
  };
}

export interface ContentTreeItem {
  id: string;
  title?: string | undefined;
  type?: string | undefined;
  status?: string | undefined;
  parentId?: string | undefined;
  depth: number;
  childPosition?: number | undefined;
}

export interface ContentTreeNode extends ContentTreeItem {
  children: ContentTreeNode[];
}

export interface ContentTreeBuildResult {
  root: ContentTreeNode;
  warnings: string[];
}

export function reconstructContentTree(
  root: ContentTreeItem,
  rawItems: unknown[],
): ContentTreeBuildResult {
  const rootNode: ContentTreeNode = { ...root, depth: 0, children: [] };
  const nodes = new Map<string, ContentTreeNode>();
  const order = new Map<string, number>();
  const warnings: string[] = [];

  rawItems.forEach((raw, index) => {
    const item = compactContentItem(raw);
    if (!item || item.id === root.id) return;
    if (nodes.has(item.id)) {
      warnings.push(`Duplicate content id omitted: ${item.id}`);
      return;
    }
    nodes.set(item.id, { ...item, children: [] });
    order.set(item.id, index);
  });

  const attached = new Set<string>();
  const attaching = new Set<string>();
  const attach = (node: ContentTreeNode): void => {
    if (attached.has(node.id)) return;
    if (attaching.has(node.id)) {
      warnings.push(`Cyclic parent reference attached to root: ${node.id}`);
      rootNode.children.push(node);
      attached.add(node.id);
      return;
    }
    attaching.add(node.id);
    const parent = node.parentId ? nodes.get(node.parentId) : undefined;
    if (parent && parent.id !== node.id) {
      attach(parent);
      parent.children.push(node);
    } else {
      if (node.parentId && node.parentId !== root.id) {
        warnings.push(`Unknown parent attached to root: ${node.id}`);
      }
      rootNode.children.push(node);
    }
    attaching.delete(node.id);
    attached.add(node.id);
  };

  for (const node of nodes.values()) attach(node);
  const sortChildren = (node: ContentTreeNode): void => {
    node.children.sort(
      (left, right) =>
        (left.childPosition ?? Number.MAX_SAFE_INTEGER) -
          (right.childPosition ?? Number.MAX_SAFE_INTEGER) ||
        (order.get(left.id) ?? 0) - (order.get(right.id) ?? 0),
    );
    for (const child of node.children) sortChildren(child);
  };
  sortChildren(rootNode);
  return { root: rootNode, warnings };
}

export interface CursorCollection<T> {
  items: T[];
  pagesFetched: number;
  apiCalls: number;
  nextCursor?: string | undefined;
  paginationExhausted: boolean;
  truncated: boolean;
  errors: string[];
}

export async function collectCursorPages<T>(
  request: (cursor: string | undefined, limit: number) => Promise<ClientResponse>,
  maxItems: number,
): Promise<CursorCollection<T>> {
  const items: T[] = [];
  const errors: string[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  let pagesFetched = 0;
  let nextCursor: string | undefined;

  while (items.length < maxItems) {
    try {
      const response = await request(cursor, Math.min(250, maxItems - items.length));
      pagesFetched += 1;
      const pageItems = resultItems<T>(response.data);
      items.push(...pageItems.slice(0, maxItems - items.length));
      nextCursor = extractNextCursor(response.data, response.headers);
      if (!nextCursor || seenCursors.has(nextCursor)) {
        nextCursor = undefined;
        break;
      }
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    } catch (error) {
      errors.push(publicErrorMessage(error));
      break;
    }
  }

  const truncated = items.length >= maxItems && Boolean(nextCursor);
  return {
    items,
    pagesFetched,
    apiCalls: pagesFetched,
    nextCursor,
    paginationExhausted: !nextCursor && errors.length === 0,
    truncated,
    errors,
  };
}

function contentPath(contentType: 'page' | 'folder', contentId: string, suffix = ''): string {
  return `/wiki/api/v2/${contentType === 'page' ? 'pages' : 'folders'}/${encodeURIComponent(contentId)}${suffix}`;
}

function rootFromResponse(
  rootId: string,
  rootType: 'page' | 'folder',
  data: unknown,
): ContentTreeItem {
  const record = asRecord(data);
  return {
    id: rootId,
    title: stringValue(record?.title),
    type: stringValue(record?.type) ?? rootType,
    status: stringValue(record?.status),
    parentId: stringValue(record?.parentId),
    depth: 0,
  };
}

export interface ContentTreeOptions {
  rootId: string;
  rootType: 'page' | 'folder';
  depth: number;
  maxItems: number;
}

export async function fetchContentTree(
  client: ConfluenceClient,
  options: ContentTreeOptions,
): Promise<JsonRecord> {
  const rootRequest = client.requestJson<unknown>(
    'GET',
    contentPath(options.rootType, options.rootId),
  );
  const descendants = collectCursorPages<unknown>(
    (cursor, limit) =>
      client.requestJson<unknown>(
        'GET',
        contentPath(options.rootType, options.rootId, '/descendants'),
        {
          depth: options.depth,
          cursor,
          limit,
        },
      ),
    options.maxItems,
  );
  const [rootResult, descendantResult] = await Promise.allSettled([rootRequest, descendants]);

  const errors: string[] = [];
  const rootData = rootResult.status === 'fulfilled' ? rootResult.value.data : undefined;
  if (rootResult.status === 'rejected') errors.push(publicErrorMessage(rootResult.reason));
  const pageData =
    descendantResult.status === 'fulfilled'
      ? descendantResult.value
      : {
          items: [],
          pagesFetched: 0,
          apiCalls: 0,
          paginationExhausted: false,
          truncated: false,
          errors: [publicErrorMessage(descendantResult.reason)],
        };
  errors.push(...pageData.errors);

  const build = reconstructContentTree(
    rootFromResponse(options.rootId, options.rootType, rootData),
    pageData.items,
  );
  errors.push(...build.warnings);
  return {
    root: build.root,
    status: {
      partial: errors.length > 0,
      truncated: pageData.truncated,
      depthLimited: options.depth < TREE_MAX_DEPTH,
      paginationExhausted: pageData.paginationExhausted,
      nextCursor: pageData.nextCursor,
      itemsReturned: pageData.items.length,
      pagesFetched: pageData.pagesFetched,
      apiCalls: pageData.apiCalls + 1,
      errors: errors.length > 0 ? errors : undefined,
    },
  };
}

function compactSearchResult(value: unknown): JsonRecord {
  const record = asRecord(value) ?? {};
  const content = asRecord(record.content);
  return {
    id: stringValue(content?.id) ?? stringValue(record.id),
    type: stringValue(content?.type) ?? stringValue(record.entityType),
    title: stringValue(record.title) ?? stringValue(content?.title),
    excerpt: record.excerpt,
    space: content?.space ?? record.space,
    url: record.url,
    lastModified: record.lastModified,
  };
}

function contentIdFromSearchResult(value: unknown): string | undefined {
  const record = asRecord(value);
  const content = asRecord(record?.content);
  return stringValue(content?.id) ?? stringValue(record?.id);
}

function truncatePageBody(
  value: unknown,
  maxCharsPerPage: number,
): { data: unknown; truncated: boolean } {
  const record = asRecord(value);
  if (!record) return { data: value, truncated: false };
  const clone = JSON.parse(JSON.stringify(value)) as JsonRecord;
  const body = asRecord(clone.body);
  if (!body) return { data: value, truncated: false };
  let truncated = false;
  for (const [representation, bodyValue] of Object.entries(body)) {
    if (typeof bodyValue === 'string' && bodyValue.length > maxCharsPerPage) {
      body[representation] = `${bodyValue.slice(0, maxCharsPerPage)}…[body truncated]`;
      truncated = true;
    } else {
      const bodyRecord = asRecord(bodyValue);
      if (
        bodyRecord &&
        typeof bodyRecord.value === 'string' &&
        bodyRecord.value.length > maxCharsPerPage
      ) {
        bodyRecord.value = `${bodyRecord.value.slice(0, maxCharsPerPage)}…[body truncated]`;
        truncated = true;
      }
    }
  }
  return { data: clone, truncated };
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  worker: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const output = new Array<R>(values.length);
  let nextIndex = 0;
  const run = async (): Promise<void> => {
    while (true) {
      const index = nextIndex++;
      if (index >= values.length) return;
      output[index] = await worker(values[index]!, index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, run));
  return output;
}

async function fetchPage(
  client: ConfluenceClient,
  pageId: string,
  format: string,
  maxCharsPerPage?: number,
): Promise<{ data: unknown; truncated: boolean }> {
  const response = await client.requestJson<unknown>(
    'GET',
    `/wiki/api/v2/pages/${encodeURIComponent(pageId)}`,
    {
      'body-format': format,
      'include-labels': true,
      'include-versions': true,
    },
  );
  return maxCharsPerPage === undefined
    ? { data: response.data, truncated: false }
    : truncatePageBody(response.data, maxCharsPerPage);
}

export async function searchAndFetch(
  client: ConfluenceClient,
  args: {
    cql: string;
    searchLimit: number;
    fetchTop: number;
    start: number;
    bodyFormat: string;
    maxCharsPerPage: number;
    fetchConcurrency: number;
  },
): Promise<JsonRecord> {
  const searchResponse = await client.requestJson<JsonRecord>('GET', '/wiki/rest/api/search', {
    cql: args.cql,
    limit: args.searchLimit,
    start: args.start,
  });
  const rawResults = resultItems<unknown>(searchResponse.data);
  const selected = rawResults.slice(0, args.fetchTop);
  const fetched = await mapWithConcurrency(selected, args.fetchConcurrency, async (item) => {
    const searchResult = compactSearchResult(item);
    const pageId = contentIdFromSearchResult(item);
    if (!pageId || (searchResult.type && searchResult.type !== 'page')) {
      return { searchResult, fetched: false, reason: 'Search result is not a fetchable page.' };
    }
    try {
      const page = await fetchPage(client, pageId, args.bodyFormat, args.maxCharsPerPage);
      return { searchResult, page: page.data, fetched: true, bodyTruncated: page.truncated };
    } catch (error) {
      return { searchResult, fetched: false, error: publicErrorMessage(error) };
    }
  });
  const responseRecord = asRecord(searchResponse.data) ?? {};
  return {
    results: fetched,
    search: {
      start: responseRecord.start ?? args.start,
      limit: responseRecord.limit ?? args.searchLimit,
      size: responseRecord.size ?? rawResults.length,
      totalSize: responseRecord.totalSize,
      fetchedCount: fetched.filter((item) => item.fetched).length,
      fetchRequested: selected.length,
      nextStart:
        args.start + rawResults.length < Number(responseRecord.totalSize ?? 0)
          ? args.start + rawResults.length
          : undefined,
    },
    status: {
      partial: fetched.some((item) => !item.fetched),
      searchApiCalls: 1,
      pageApiCalls: fetched.filter((item) => item.fetched).length,
      note: 'Search metadata and fetched page bodies are paired by result order and id.',
    },
  };
}

async function optionalCall<T>(name: string, operation: () => Promise<T>): Promise<JsonRecord> {
  try {
    return { name, ok: true, data: await operation() };
  } catch (error) {
    return { name, ok: false, error: publicErrorMessage(error) };
  }
}

async function collectList(
  client: ConfluenceClient,
  path: string,
  query: JsonRecord,
  maxItems: number,
): Promise<CursorCollection<unknown>> {
  return collectCursorPages<unknown>((cursor, limit) => {
    return client.requestJson<unknown>('GET', path, { ...query, cursor, limit });
  }, maxItems);
}

export async function getPageContext(
  client: ConfluenceClient,
  args: {
    pageId: string;
    bodyFormat: string;
    includeAncestors: boolean;
    includeAttachments: boolean;
    includeComments: boolean;
    commentTypes: Array<'footer' | 'inline'>;
    maxItemsPerSection: number;
  },
): Promise<JsonRecord> {
  const tasks: Promise<JsonRecord>[] = [
    optionalCall('page', () =>
      fetchPage(client, args.pageId, args.bodyFormat).then((result) => result.data),
    ),
  ];
  if (args.includeAncestors) {
    tasks.push(
      optionalCall('ancestors', () =>
        client
          .requestJson<unknown>(
            'GET',
            `/wiki/api/v2/pages/${encodeURIComponent(args.pageId)}/ancestors`,
          )
          .then((response) => response.data),
      ),
    );
  }
  if (args.includeAttachments) {
    tasks.push(
      optionalCall('attachments', () =>
        collectList(
          client,
          `/wiki/api/v2/pages/${encodeURIComponent(args.pageId)}/attachments`,
          {},
          args.maxItemsPerSection,
        ),
      ),
    );
  }
  if (args.includeComments) {
    for (const commentType of args.commentTypes) {
      const suffix = commentType === 'footer' ? 'footer-comments' : 'inline-comments';
      tasks.push(
        optionalCall(`comments_${commentType}`, () =>
          collectList(
            client,
            `/wiki/api/v2/pages/${encodeURIComponent(args.pageId)}/${suffix}`,
            { 'body-format': args.bodyFormat },
            args.maxItemsPerSection,
          ),
        ),
      );
    }
  }
  const sections = await Promise.all(tasks);
  const errors = sections.filter((section) => section.ok === false).map((section) => section.error);
  const output: JsonRecord = { sections, status: { partial: errors.length > 0, errors } };
  return output;
}

function extractHomepageId(value: unknown): string | undefined {
  const record = asRecord(value);
  const homepage = asRecord(record?.homepage);
  return stringValue(record?.homepageId) ?? stringValue(homepage?.id);
}

export async function getSpaceOverview(
  client: ConfluenceClient,
  args: {
    spaceId: string;
    rootId?: string;
    rootType: 'page' | 'folder';
    depth: number;
    maxItems: number;
  },
): Promise<JsonRecord> {
  const spaceResult = await optionalCall('space', () =>
    client
      .requestJson<unknown>('GET', `/wiki/api/v2/spaces/${encodeURIComponent(args.spaceId)}`)
      .then((response) => response.data),
  );
  const spaceId = spaceResult.ok ? extractHomepageId(spaceResult.data) : undefined;
  const rootId = args.rootId ?? spaceId;
  if (!rootId) {
    return {
      space: spaceResult,
      tree: undefined,
      status: {
        partial: !spaceResult.ok,
        errors: spaceResult.ok ? undefined : [spaceResult.error],
      },
    };
  }
  const tree = await fetchContentTree(client, {
    rootId,
    rootType: args.rootType,
    depth: args.depth,
    maxItems: args.maxItems,
  });
  return {
    space: spaceResult,
    homepageId: spaceId,
    tree,
    status: { partial: Boolean(!spaceResult.ok || asRecord(tree.status)?.partial === true) },
  };
}

export async function getCommentThread(
  client: ConfluenceClient,
  args: {
    commentId: string;
    commentType: 'footer' | 'inline';
    bodyFormat: string;
    maxDepth: number;
    maxItems: number;
  },
): Promise<JsonRecord> {
  const suffix = args.commentType === 'footer' ? 'footer-comments' : 'inline-comments';
  const errors: string[] = [];
  let apiCalls = 0;
  let itemCount = 0;
  let truncated = false;
  const rootResponse = await client.requestJson<unknown>(
    'GET',
    `/wiki/api/v2/${suffix}/${encodeURIComponent(args.commentId)}`,
    { 'body-format': args.bodyFormat },
  );
  apiCalls += 1;
  itemCount = 1;

  const visit = async (comment: JsonRecord, depth: number): Promise<void> => {
    if (depth >= args.maxDepth || itemCount >= args.maxItems) {
      truncated = true;
      return;
    }
    const commentId = stringValue(comment.id);
    if (!commentId) return;
    const children = await collectList(
      client,
      `/wiki/api/v2/${suffix}/${encodeURIComponent(commentId)}/children`,
      { 'body-format': args.bodyFormat },
      Math.min(args.maxItems - itemCount, MAX_SECTION_ITEMS),
    );
    apiCalls += children.apiCalls;
    errors.push(...children.errors);
    if (children.truncated || children.nextCursor) truncated = true;
    const replies: JsonRecord[] = [];
    for (const child of children.items) {
      if (itemCount >= args.maxItems) {
        truncated = true;
        break;
      }
      const childRecord = asRecord(child) ?? {};
      itemCount += 1;
      replies.push(childRecord);
      await visit(childRecord, depth + 1);
    }
    comment.replies = replies;
  };

  const root = asRecord(rootResponse.data) ?? { data: rootResponse.data };
  await visit(root, 0);
  return {
    root,
    status: {
      partial: errors.length > 0,
      truncated,
      maxDepth: args.maxDepth,
      itemsReturned: itemCount,
      apiCalls,
      errors: errors.length > 0 ? errors : undefined,
    },
  };
}

// MCP SDK validates each schema before invoking the handler. This boundary keeps the
// registration calls readable while the API client and high-level helpers stay strict.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function highLevelError(handler: (args: any) => Promise<ReturnType<typeof toolResult>>) {
  return async (args: Parameters<typeof handler>[0]) => {
    try {
      return await handler(args);
    } catch (error) {
      return { ...toolResult({ error: publicErrorMessage(error) }), isError: true };
    }
  };
}

export function registerHighLevelTools(server: McpServer, client: ConfluenceClient): void {
  server.registerTool(
    'confluence_get_content_tree',
    {
      description:
        'HIGH-LEVEL: Get a page or folder subtree in one MCP call. Prefer this over recursively calling confluence_list_children; the server uses v2 descendants, consumes cursor pagination, reconstructs parentId/depth/childPosition, and returns explicit budget/truncation status.',
      inputSchema: z.object({
        root_id: z.string().min(1),
        root_type: z.enum(['page', 'folder']).default('page'),
        depth: z.number().int().min(0).max(TREE_MAX_DEPTH).default(DEFAULT_TREE_DEPTH),
        max_items: z.number().int().min(1).max(TREE_MAX_ITEMS).default(DEFAULT_TREE_ITEMS),
        max_chars: maxChars,
      }),
    },
    highLevelError(async ({ root_id, root_type, depth, max_items, max_chars: chars }) =>
      toolResult(
        await fetchContentTree(client, {
          rootId: root_id,
          rootType: root_type,
          depth,
          maxItems: max_items,
        }),
        chars,
      ),
    ),
  );

  server.registerTool(
    'confluence_search_and_fetch',
    {
      description:
        'HIGH-LEVEL: Search with CQL and fetch the top matching page bodies in one MCP call. Prefer this over confluence_search followed by confluence_get_page for each result. Results retain paired search metadata and page content; non-page or failed fetches are reported as partial results.',
      inputSchema: z.object({
        cql: z.string().min(1).max(4_000),
        search_limit: z.number().int().min(1).max(100).default(25),
        fetch_top: z.number().int().min(0).max(MAX_SEARCH_FETCH).default(DEFAULT_SEARCH_FETCH),
        start: z.number().int().min(0).default(0),
        body_format: bodyFormat,
        max_chars_per_page: z.number().int().min(500).max(20_000).default(6_000),
        fetch_concurrency: z
          .number()
          .int()
          .min(1)
          .max(MAX_FETCH_CONCURRENCY)
          .default(DEFAULT_FETCH_CONCURRENCY),
        max_chars: maxChars,
      }),
    },
    highLevelError(
      async ({
        cql,
        search_limit,
        fetch_top,
        start,
        body_format: bodyFormat,
        max_chars_per_page,
        fetch_concurrency,
        max_chars: chars,
      }) =>
        toolResult(
          await searchAndFetch(client, {
            cql,
            searchLimit: search_limit,
            fetchTop: fetch_top,
            start,
            bodyFormat: bodyFormat,
            maxCharsPerPage: max_chars_per_page,
            fetchConcurrency: fetch_concurrency,
          }),
          chars,
        ),
    ),
  );

  server.registerTool(
    'confluence_get_page_context',
    {
      description:
        'HIGH-LEVEL: Gather the information commonly needed to understand one page in one MCP call: body/current version plus optional ancestors, attachments, and comments. Prefer this over calling several page context primitives separately; optional section failures are returned with partial status.',
      inputSchema: z.object({
        page_id: z.string().min(1),
        body_format: bodyFormat,
        include_ancestors: z.boolean().default(true),
        include_attachments: z.boolean().default(false),
        include_comments: z.boolean().default(false),
        comment_types: z
          .array(z.enum(['footer', 'inline']))
          .min(1)
          .max(2)
          .default(['footer']),
        max_items_per_section: z
          .number()
          .int()
          .min(1)
          .max(MAX_SECTION_ITEMS)
          .default(DEFAULT_SECTION_ITEMS),
        max_chars: maxChars,
      }),
    },
    highLevelError(
      async ({
        page_id,
        body_format: bodyFormat,
        include_ancestors,
        include_attachments,
        include_comments,
        comment_types,
        max_items_per_section,
        max_chars: chars,
      }) =>
        toolResult(
          await getPageContext(client, {
            pageId: page_id,
            bodyFormat: bodyFormat,
            includeAncestors: include_ancestors,
            includeAttachments: include_attachments,
            includeComments: include_comments,
            commentTypes: comment_types,
            maxItemsPerSection: max_items_per_section,
          }),
          chars,
        ),
    ),
  );

  server.registerTool(
    'confluence_get_space_overview',
    {
      description:
        'HIGH-LEVEL: Get space metadata and the homepage/root content tree in one MCP call. Prefer this when first learning a space instead of listing spaces, fetching the space, and recursively listing children. The tree is always budgeted and reports partial/truncated state.',
      inputSchema: z.object({
        space_id: z.string().min(1),
        root_id: z.string().optional(),
        root_type: z.enum(['page', 'folder']).default('page'),
        depth: z.number().int().min(0).max(TREE_MAX_DEPTH).default(DEFAULT_TREE_DEPTH),
        max_items: z.number().int().min(1).max(TREE_MAX_ITEMS).default(DEFAULT_TREE_ITEMS),
        max_chars: maxChars,
      }),
    },
    highLevelError(async ({ space_id, root_id, root_type, depth, max_items, max_chars: chars }) =>
      toolResult(
        await getSpaceOverview(client, {
          spaceId: space_id,
          rootId: root_id,
          rootType: root_type,
          depth,
          maxItems: max_items,
        }),
        chars,
      ),
    ),
  );

  server.registerTool(
    'confluence_get_comment_thread',
    {
      description:
        'HIGH-LEVEL: Get one footer or inline comment plus its reply tree in one MCP call. Prefer this over repeatedly calling confluence_get_comment and child-comment endpoints. max_depth and max_items bound recursive traversal; partial/truncated status is explicit.',
      inputSchema: z.object({
        comment_id: z.string().min(1),
        comment_type: z.enum(['footer', 'inline']).default('footer'),
        body_format: bodyFormat,
        max_depth: z.number().int().min(0).max(8).default(4),
        max_items: z.number().int().min(1).max(250).default(50),
        max_chars: maxChars,
      }),
    },
    highLevelError(
      async ({ comment_id, comment_type, body_format, max_depth, max_items, max_chars: chars }) =>
        toolResult(
          await getCommentThread(client, {
            commentId: comment_id,
            commentType: comment_type,
            bodyFormat: body_format,
            maxDepth: max_depth,
            maxItems: max_items,
          }),
          chars,
        ),
    ),
  );
}
