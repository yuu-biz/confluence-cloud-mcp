import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ConfluenceClient } from '../client/confluence-client.js';
import { extractNextCursor } from '../client/confluence-client.js';
import { publicErrorMessage } from '../client/errors.js';
import { resolveOutputBudget, toolResult } from './response.js';
import type { OutputBudget } from './response.js';

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
const MAX_PAGINATION_PAGES = 20;
const OUTLINE_FETCH_ITEMS = 600;
const OUTLINE_DEPTH = 2;
const MAX_OMITTED_BRANCHES = 40;
// Share of the output budget spent on the rendered tree, leaving room for status and hints.
const TREE_TEXT_BUDGET_RATIO = 0.7;
const THREAD_CHILD_CONCURRENCY = 4;
const MAX_THREAD_API_CALLS = 60;

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

export type TreeOutputMode = 'compact' | 'outline' | 'detailed';

export interface OmittedBranch {
  id: string;
  title?: string | undefined;
  type?: string | undefined;
  /** Descendants already fetched below this branch; a floor, not a Confluence-wide count. */
  fetchedDescendants: number;
}

export interface TreeRender {
  text: string;
  renderedItems: number;
  renderedDepth: number;
  omittedBranches: OmittedBranch[];
  branchesNotListed: number;
  budgetExceeded: boolean;
}

function treeDepth(node: ContentTreeNode): number {
  return node.children.length === 0
    ? 0
    : 1 + Math.max(...node.children.map((child) => treeDepth(child)));
}

function countDescendants(node: ContentTreeNode): number {
  let total = 0;
  for (const child of node.children) total += 1 + countDescendants(child);
  return total;
}

// One line per node: title, a folder marker, the id needed for follow-up calls, and nothing that
// the indentation already encodes (parentId, depth, childPosition stay out of compact output).
function nodeLine(node: ContentTreeNode, indent: number, bullet: boolean): string {
  const title = node.title ?? '(untitled)';
  const folder = node.type === 'folder' ? '/' : '';
  const status = node.status && node.status !== 'current' ? ` <${node.status}>` : '';
  return `${'  '.repeat(indent)}${bullet ? '- ' : ''}${title}${folder}${status} [${node.id}]`;
}

function omittedBranch(node: ContentTreeNode): OmittedBranch {
  return {
    id: node.id,
    title: node.title,
    type: node.type,
    fetchedDescendants: countDescendants(node),
  };
}

function renderAtDepth(
  root: ContentTreeNode,
  maxDepth: number,
): { lines: string[]; renderedItems: number; omittedBranches: OmittedBranch[] } {
  const lines: string[] = [];
  const omittedBranches: OmittedBranch[] = [];
  let renderedItems = 0;
  const walk = (node: ContentTreeNode, depth: number): void => {
    lines.push(nodeLine(node, depth, depth > 0));
    if (depth > 0) renderedItems += 1;
    if (node.children.length === 0) return;
    if (depth >= maxDepth) {
      omittedBranches.push(omittedBranch(node));
      return;
    }
    for (const child of node.children) walk(child, depth + 1);
  };
  walk(root, 0);
  return { lines, renderedItems, omittedBranches };
}

/**
 * Renders the deepest view of the tree that fits the output budget. Depth is reduced before any
 * branch is dropped, so a wide tree keeps every branch visible and reports the collapsed ones
 * instead of silently losing the tail of the list.
 */
export function renderCompactTree(root: ContentTreeNode, budgetChars: number): TreeRender {
  const deepest = treeDepth(root);
  for (let depth = deepest; depth >= 1; depth -= 1) {
    const attempt = renderAtDepth(root, depth);
    const text = attempt.lines.join('\n');
    if (text.length > budgetChars) continue;
    return {
      text,
      renderedItems: attempt.renderedItems,
      renderedDepth: depth,
      omittedBranches: attempt.omittedBranches.slice(0, MAX_OMITTED_BRANCHES),
      branchesNotListed: Math.max(0, attempt.omittedBranches.length - MAX_OMITTED_BRANCHES),
      budgetExceeded: false,
    };
  }
  if (deepest === 0) {
    return {
      text: nodeLine(root, 0, false),
      renderedItems: 0,
      renderedDepth: 0,
      omittedBranches: [],
      branchesNotListed: 0,
      budgetExceeded: false,
    };
  }

  // Even one level does not fit: keep as many top-level branches as the budget allows and report
  // the rest, so the caller can expand exactly the branch it cares about.
  const lines = [nodeLine(root, 0, false)];
  const omittedBranches: OmittedBranch[] = [];
  let renderedItems = 0;
  let used = lines[0]?.length ?? 0;
  let dropping = false;
  for (const child of root.children) {
    const line = nodeLine(child, 1, true);
    if (dropping || used + line.length + 1 > budgetChars) {
      dropping = true;
      omittedBranches.push(omittedBranch(child));
      continue;
    }
    lines.push(line);
    used += line.length + 1;
    renderedItems += 1;
    if (child.children.length > 0) omittedBranches.push(omittedBranch(child));
  }
  return {
    text: lines.join('\n'),
    renderedItems,
    renderedDepth: 1,
    omittedBranches: omittedBranches.slice(0, MAX_OMITTED_BRANCHES),
    branchesNotListed: Math.max(0, omittedBranches.length - MAX_OMITTED_BRANCHES),
    budgetExceeded: true,
  };
}

/**
 * Outline view: one line per direct child with whether it has children and how many were seen.
 * Built from a single depth-2 descendants read, so it never costs a per-branch request.
 */
export function renderOutline(
  root: ContentTreeNode,
  countsAreFloor: boolean,
  budgetChars: number,
): TreeRender {
  const lines = [nodeLine(root, 0, false)];
  const omittedBranches: OmittedBranch[] = [];
  let renderedItems = 0;
  let used = lines[0]?.length ?? 0;
  for (const child of root.children) {
    const count = child.children.length;
    const marker =
      count === 0 ? ' (no children seen)' : ` (${count}${countsAreFloor ? '+' : ''} children)`;
    const line = `${nodeLine(child, 1, true)}${marker}`;
    if (omittedBranches.length > 0 || used + line.length + 1 > budgetChars) {
      omittedBranches.push(omittedBranch(child));
      continue;
    }
    lines.push(line);
    used += line.length + 1;
    renderedItems += 1;
  }
  return {
    text: lines.join('\n'),
    renderedItems,
    renderedDepth: 1,
    omittedBranches: omittedBranches.slice(0, MAX_OMITTED_BRANCHES),
    branchesNotListed: Math.max(0, omittedBranches.length - MAX_OMITTED_BRANCHES),
    budgetExceeded: omittedBranches.length > 0,
  };
}

export interface CursorCollection<T> {
  items: T[];
  pagesFetched: number;
  apiCalls: number;
  nextCursor?: string | undefined;
  paginationExhausted: boolean;
  truncated: boolean;
  stopReason: 'complete' | 'max_items' | 'pagination_limit' | 'api_error';
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
  let stopReason: CursorCollection<T>['stopReason'] = 'complete';

  while (items.length < maxItems) {
    if (pagesFetched >= MAX_PAGINATION_PAGES) {
      stopReason = 'pagination_limit';
      break;
    }
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
      stopReason = 'api_error';
      break;
    }
  }

  if (stopReason === 'complete' && nextCursor) stopReason = 'max_items';
  return {
    items,
    pagesFetched,
    apiCalls: pagesFetched,
    nextCursor,
    paginationExhausted: !nextCursor && errors.length === 0,
    truncated: Boolean(nextCursor),
    stopReason,
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
  outputMode: TreeOutputMode;
  budget: OutputBudget;
}

function paginationReason(stopReason: CursorCollection<unknown>['stopReason']): string | undefined {
  if (stopReason === 'max_items') return 'max_items';
  if (stopReason === 'pagination_limit') return 'pagination_limit';
  if (stopReason === 'api_error') return 'api_error';
  return undefined;
}

export async function fetchContentTree(
  client: ConfluenceClient,
  options: ContentTreeOptions,
): Promise<JsonRecord> {
  const outline = options.outputMode === 'outline';
  // Retrieval budget and output budget are separate: outline reads wide but renders one level.
  const fetchDepth = outline ? OUTLINE_DEPTH : options.depth;
  const fetchMaxItems = outline
    ? Math.min(TREE_MAX_ITEMS, Math.max(options.maxItems, OUTLINE_FETCH_ITEMS))
    : options.maxItems;

  const rootRequest = client.requestJson<unknown>(
    'GET',
    contentPath(options.rootType, options.rootId),
  );
  const descendants = collectCursorPages<unknown>(
    (cursor, limit) =>
      client.requestJson<unknown>(
        'GET',
        contentPath(options.rootType, options.rootId, '/descendants'),
        { depth: fetchDepth, cursor, limit },
      ),
    fetchMaxItems,
  );
  const [rootResult, descendantResult] = await Promise.allSettled([rootRequest, descendants]);

  const errors: string[] = [];
  const rootData = rootResult.status === 'fulfilled' ? rootResult.value.data : undefined;
  if (rootResult.status === 'rejected') errors.push(publicErrorMessage(rootResult.reason));
  const pageData: CursorCollection<unknown> =
    descendantResult.status === 'fulfilled'
      ? descendantResult.value
      : {
          items: [],
          pagesFetched: 0,
          apiCalls: 0,
          paginationExhausted: false,
          truncated: false,
          stopReason: 'api_error',
          errors: [publicErrorMessage(descendantResult.reason)],
        };
  errors.push(...pageData.errors);

  const build = reconstructContentTree(
    rootFromResponse(options.rootId, options.rootType, rootData),
    pageData.items,
  );
  errors.push(...build.warnings);

  const fetchedItems = pageData.items.length;
  const textBudget = Math.max(
    500,
    Math.floor(options.budget.effectiveChars * TREE_TEXT_BUDGET_RATIO),
  );
  const render =
    options.outputMode === 'detailed'
      ? undefined
      : outline
        ? renderOutline(build.root, pageData.truncated, textBudget)
        : renderCompactTree(build.root, textBudget);

  const renderedItems = render ? render.renderedItems : fetchedItems;
  const truncationReasons = new Set<string>();
  const retrievalReason = paginationReason(pageData.stopReason);
  if (retrievalReason) truncationReasons.add(retrievalReason);
  if (rootResult.status === 'rejected' || build.warnings.length > 0)
    truncationReasons.add('api_error');
  // Outline renders one level on purpose, so only a dropped branch counts as a budget loss.
  if (outline ? render?.budgetExceeded : renderedItems < fetchedItems)
    truncationReasons.add('output_budget');

  const omittedBranches = render?.omittedBranches ?? [];
  const output: JsonRecord = {
    root: { id: build.root.id, title: build.root.title, type: build.root.type },
    status: {
      mode: options.outputMode,
      depthRequested: outline ? OUTLINE_DEPTH : options.depth,
      renderedDepth: render?.renderedDepth,
      fetchedItems,
      renderedItems,
      omittedItems: Math.max(0, fetchedItems - renderedItems),
      truncated: truncationReasons.size > 0,
      truncationReasons: truncationReasons.size > 0 ? [...truncationReasons] : undefined,
      paginationExhausted: pageData.paginationExhausted,
      nextCursor: pageData.nextCursor,
      apiCalls: pageData.apiCalls + 1,
      outputBudget: options.budget,
      errors: errors.length > 0 ? errors : undefined,
    },
  };
  if (render) {
    output.tree = render.text;
    output.legend =
      'One line per node, indentation = hierarchy, "/" = folder, [id] = content id for follow-up calls.';
  } else {
    output.treeNodes = build.root;
  }
  if (omittedBranches.length > 0) {
    output.omittedBranches = omittedBranches;
    output.nextStep =
      'Expand only the branches you need: call confluence_get_content_tree with root_id set to an omitted branch id.';
  } else if (outline) {
    output.nextStep =
      'Pick the branches that matter and call confluence_get_content_tree with root_id set to their ids.';
  }
  if (render?.branchesNotListed) output.omittedBranchesNotListed = render.branchesNotListed;
  return output;
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

export type SearchMode = 'auto' | 'exact_title' | 'title_prefix' | 'full_text' | 'cql';

function escapeCqlLiteral(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}

/**
 * Builds the CQL for a plain query. Only operators Confluence documents for these fields are
 * used: title supports = and ~ (with a trailing * wildcard), text supports ~ only.
 */
export function buildSearchCql(mode: Exclude<SearchMode, 'auto' | 'cql'>, query: string): string {
  const value = escapeCqlLiteral(query.trim());
  if (mode === 'exact_title') return `title = "${value}"`;
  if (mode === 'title_prefix') return `title ~ "${value.replace(/\*+$/, '')}*"`;
  return `text ~ "${value}"`;
}

// auto widens step by step and stops at the first hit, so an exact identifier is not diluted by
// full-text tokenization while an unknown phrase still reaches full text.
const AUTO_SEARCH_SEQUENCE: Array<Exclude<SearchMode, 'auto' | 'cql'>> = [
  'exact_title',
  'title_prefix',
  'full_text',
];

export interface SearchAttempt {
  mode: string;
  cql: string;
  size: number;
}

export function searchPlan(args: {
  mode: SearchMode;
  query?: string | undefined;
  cql?: string | undefined;
}): Array<{ mode: string; cql: string }> {
  if (args.mode === 'cql' || (args.mode === 'auto' && !args.query && args.cql)) {
    if (!args.cql) throw new Error('search_mode "cql" requires cql');
    return [{ mode: 'cql', cql: args.cql }];
  }
  if (!args.query) throw new Error('Provide query, or cql with search_mode "cql"');
  if (args.mode === 'auto')
    return AUTO_SEARCH_SEQUENCE.map((mode) => ({ mode, cql: buildSearchCql(mode, args.query!) }));
  return [{ mode: args.mode, cql: buildSearchCql(args.mode, args.query) }];
}

export async function searchAndFetch(
  client: ConfluenceClient,
  args: {
    mode: SearchMode;
    query?: string | undefined;
    cql?: string | undefined;
    searchLimit: number;
    fetchTop: number;
    start: number;
    bodyFormat: string;
    maxCharsPerPage: number;
    fetchConcurrency: number;
    budget: OutputBudget;
  },
): Promise<JsonRecord> {
  const plan = searchPlan(args);
  const attempts: SearchAttempt[] = [];
  let searchResponse = await client.requestJson<JsonRecord>('GET', '/wiki/rest/api/search', {
    cql: plan[0]!.cql,
    limit: args.searchLimit,
    start: args.start,
  });
  let rawResults = resultItems<unknown>(searchResponse.data);
  attempts.push({ mode: plan[0]!.mode, cql: plan[0]!.cql, size: rawResults.length });
  for (const step of plan.slice(1)) {
    if (rawResults.length > 0) break;
    searchResponse = await client.requestJson<JsonRecord>('GET', '/wiki/rest/api/search', {
      cql: step.cql,
      limit: args.searchLimit,
      start: args.start,
    });
    rawResults = resultItems<unknown>(searchResponse.data);
    attempts.push({ mode: step.mode, cql: step.cql, size: rawResults.length });
  }
  const used = attempts[attempts.length - 1]!;
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
    strategy: {
      searchMode: used.mode,
      cqlUsed: used.cql,
      attempts: attempts.length > 1 ? attempts : undefined,
    },
    status: {
      partial: fetched.some((item) => !item.fetched),
      searchApiCalls: attempts.length,
      pageApiCalls: fetched.filter((item) => item.fetched).length,
      outputBudget: args.budget,
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
    budget: OutputBudget;
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
  const output: JsonRecord = {
    sections,
    status: { partial: errors.length > 0, outputBudget: args.budget, errors },
  };
  return output;
}

function extractHomepageId(value: unknown): string | undefined {
  const record = asRecord(value);
  const homepage = asRecord(record?.homepage);
  return stringValue(record?.homepageId) ?? stringValue(homepage?.id);
}

// A space key is what people quote, so the numeric v2 space id is resolved here instead of
// costing the caller a separate confluence_list_spaces round trip.
async function resolveSpaceId(
  client: ConfluenceClient,
  spaceKey: string,
): Promise<{ spaceId?: string; error?: string }> {
  try {
    const response = await client.requestJson<unknown>('GET', '/wiki/api/v2/spaces', {
      keys: [spaceKey],
      limit: 1,
    });
    const spaceId = stringValue(asRecord(resultItems<unknown>(response.data)[0])?.id);
    return spaceId ? { spaceId } : { error: `No space found for key ${spaceKey}` };
  } catch (error) {
    return { error: publicErrorMessage(error) };
  }
}

export async function getSpaceOverview(
  client: ConfluenceClient,
  args: {
    spaceId?: string;
    spaceKey?: string;
    rootId?: string;
    rootType: 'page' | 'folder';
    depth: number;
    maxItems: number;
    outputMode: TreeOutputMode;
    budget: OutputBudget;
  },
): Promise<JsonRecord> {
  let spaceId = args.spaceId;
  if (!spaceId && args.spaceKey) {
    const resolved = await resolveSpaceId(client, args.spaceKey);
    if (!resolved.spaceId) {
      return {
        space: { name: 'space', ok: false, error: resolved.error },
        tree: undefined,
        status: { partial: true, errors: [resolved.error] },
      };
    }
    spaceId = resolved.spaceId;
  }
  if (!spaceId) throw new Error('Provide space_id or space_key');
  const resolvedSpaceId = spaceId;
  const spaceResult = await optionalCall('space', () =>
    client
      .requestJson<unknown>('GET', `/wiki/api/v2/spaces/${encodeURIComponent(resolvedSpaceId)}`)
      .then((response) => response.data),
  );
  const homepageId = spaceResult.ok ? extractHomepageId(spaceResult.data) : undefined;
  const rootId = args.rootId ?? homepageId;
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
    outputMode: args.outputMode,
    budget: args.budget,
  });
  return {
    space: spaceResult,
    spaceId: resolvedSpaceId,
    homepageId,
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
    budget: OutputBudget;
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

  // Confluence has no bulk reply endpoint, so each level still costs one call per comment.
  // Levels are walked breadth-first with bounded concurrency and an explicit call budget so a
  // large thread cannot turn into a long chain of sequential requests inside one tool call.
  const root = asRecord(rootResponse.data) ?? { data: rootResponse.data };
  let frontier: JsonRecord[] = [root];
  for (let depth = 0; depth < args.maxDepth && frontier.length > 0; depth += 1) {
    if (itemCount >= args.maxItems || apiCalls >= MAX_THREAD_API_CALLS) break;
    const affordable = Math.min(frontier.length, MAX_THREAD_API_CALLS - apiCalls);
    const targets = frontier.slice(0, affordable);
    const perComment = Math.min(Math.max(args.maxItems - itemCount, 1), MAX_SECTION_ITEMS);
    const childPages = await mapWithConcurrency(targets, THREAD_CHILD_CONCURRENCY, (comment) => {
      const commentId = stringValue(comment.id);
      if (!commentId) return Promise.resolve(undefined);
      return collectList(
        client,
        `/wiki/api/v2/${suffix}/${encodeURIComponent(commentId)}/children`,
        { 'body-format': args.bodyFormat },
        perComment,
      );
    });
    const next: JsonRecord[] = [];
    targets.forEach((comment, index) => {
      const children = childPages[index];
      if (!children) return;
      apiCalls += children.apiCalls;
      errors.push(...children.errors);
      if (children.truncated) truncated = true;
      const replies: JsonRecord[] = [];
      for (const child of children.items) {
        if (itemCount >= args.maxItems) {
          truncated = true;
          break;
        }
        const childRecord = asRecord(child) ?? {};
        itemCount += 1;
        replies.push(childRecord);
        next.push(childRecord);
      }
      comment.replies = replies;
    });
    if (targets.length < frontier.length) truncated = true;
    frontier = next;
  }
  if (frontier.length > 0) truncated = true;
  return {
    root,
    status: {
      partial: errors.length > 0,
      truncated,
      maxDepth: args.maxDepth,
      itemsReturned: itemCount,
      apiCalls,
      outputBudget: args.budget,
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
        'HIGH-LEVEL: Get a page or folder hierarchy in one MCP call, rendered as an indented text tree (title [id], a trailing / marks folders). Prefer this over recursively calling confluence_list_children: the server reads v2 descendants, consumes cursor pagination, and rebuilds the hierarchy. output_mode=compact (default) returns the deepest view that fits the output budget and lists collapsed branches in omittedBranches, so a follow-up call can expand only what matters; output_mode=outline returns just the direct children with child counts and is the cheapest way to map a large or unknown tree first; output_mode=detailed returns raw node objects and is only worth it when parentId, childPosition or status are needed. status separates fetchedItems from renderedItems and names every truncationReason.',
      inputSchema: z.object({
        root_id: z.string().min(1),
        root_type: z.enum(['page', 'folder']).default('page'),
        output_mode: z.enum(['compact', 'outline', 'detailed']).default('compact'),
        depth: z.number().int().min(0).max(TREE_MAX_DEPTH).default(DEFAULT_TREE_DEPTH),
        max_items: z.number().int().min(1).max(TREE_MAX_ITEMS).default(DEFAULT_TREE_ITEMS),
        max_chars: maxChars,
      }),
    },
    highLevelError(
      async ({ root_id, root_type, output_mode, depth, max_items, max_chars: chars }) =>
        toolResult(
          await fetchContentTree(client, {
            rootId: root_id,
            rootType: root_type,
            depth,
            maxItems: max_items,
            outputMode: output_mode,
            budget: resolveOutputBudget(chars),
          }),
          chars,
        ),
    ),
  );

  server.registerTool(
    'confluence_search_and_fetch',
    {
      description:
        'HIGH-LEVEL: Find pages and read their bodies in one MCP call. Prefer this over confluence_search followed by confluence_get_page per result. Pass a plain query with search_mode instead of writing CQL: auto (default) tries exact title, then title prefix, then full text and stops at the first mode that matches, which keeps identifiers such as codes or part numbers from being diluted by full-text tokenization; exact_title, title_prefix and full_text pin one strategy; cql is the escape hatch for a hand-written query. strategy.cqlUsed reports what actually ran. Non-page or failed fetches come back as partial results.',
      inputSchema: z.object({
        query: z.string().min(1).max(500).optional(),
        search_mode: z
          .enum(['auto', 'exact_title', 'title_prefix', 'full_text', 'cql'])
          .default('auto'),
        cql: z.string().min(1).max(4_000).optional(),
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
        query,
        search_mode,
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
            mode: search_mode,
            query,
            cql,
            budget: resolveOutputBudget(chars),
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
            budget: resolveOutputBudget(chars),
          }),
          chars,
        ),
    ),
  );

  server.registerTool(
    'confluence_get_space_overview',
    {
      description:
        'HIGH-LEVEL: Get space metadata and the homepage/root content tree in one MCP call. Prefer this when first learning a space instead of listing spaces, fetching the space, and recursively listing children. Provide either space_id or space_key; with space_key (for example DOCS) the server resolves the numeric space id itself. The tree is always budgeted and reports partial/truncated state.',
      inputSchema: z.object({
        space_id: z.string().min(1).optional(),
        space_key: z.string().min(1).optional(),
        root_id: z.string().optional(),
        root_type: z.enum(['page', 'folder']).default('page'),
        output_mode: z.enum(['compact', 'outline', 'detailed']).default('compact'),
        depth: z.number().int().min(0).max(TREE_MAX_DEPTH).default(DEFAULT_TREE_DEPTH),
        max_items: z.number().int().min(1).max(TREE_MAX_ITEMS).default(DEFAULT_TREE_ITEMS),
        max_chars: maxChars,
      }),
    },
    highLevelError(
      async ({
        space_id,
        space_key,
        root_id,
        root_type,
        output_mode,
        depth,
        max_items,
        max_chars: chars,
      }) =>
        toolResult(
          await getSpaceOverview(client, {
            spaceId: space_id,
            spaceKey: space_key,
            rootId: root_id,
            rootType: root_type,
            depth,
            maxItems: max_items,
            outputMode: output_mode,
            budget: resolveOutputBudget(chars),
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
            budget: resolveOutputBudget(chars),
          }),
          chars,
        ),
    ),
  );
}
