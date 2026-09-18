import { readFile, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import type { ConfluenceClient } from '../client/confluence-client.js';
import { extractNextCursor } from '../client/confluence-client.js';
import { publicErrorMessage } from '../client/errors.js';
import { toolResult } from './response.js';
import { registerHighLevelTools } from './high-level.js';

const bodyFormat = z
  .enum(['storage', 'atlas_doc_format', 'view', 'export_view', 'styled_view'])
  .default('storage');
const max_chars = z.number().int().min(1_000).max(50_000).optional();
const limit = z.number().int().min(1).max(250).optional();

function id(value: string): string {
  return encodeURIComponent(value);
}

function nextPage<T>(response: { data: T; headers: Headers }) {
  return extractNextCursor(response.data, response.headers);
}

// Tool schemas are validated by the MCP SDK before handlers run. This boundary keeps the
// registration calls readable while preserving strict types everywhere in the API client.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function withError<R>(handler: (args: any) => Promise<R>) {
  return async (args: Parameters<typeof handler>[0]) => {
    try {
      return await handler(args);
    } catch (error) {
      return { ...toolResult({ error: publicErrorMessage(error) }), isError: true };
    }
  };
}

function assertConfirmed(config: AppConfig, confirm: boolean, kind: string): void {
  if (!confirm) throw new Error(`${kind} requires confirm: true`);
}

export const RAW_PATH_PREFIXES = ['/wiki/api/v2/', '/wiki/rest/api/'] as const;

function hasUnsafeShape(value: string): boolean {
  return (
    !value.startsWith('/') ||
    value.length > 500 ||
    value.includes('://') ||
    value.includes('\\') ||
    value.includes('..') ||
    value.includes('//') ||
    value.includes('?') ||
    value.includes('#') ||
    Array.from(value).some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    }) ||
    !RAW_PATH_PREFIXES.some((prefix) => value.startsWith(prefix))
  );
}

// Percent-encoded separators and dot segments must not survive whatever decoding the
// Confluence gateway applies, so the same checks also run against the fully decoded path.
function fullyDecoded(path: string): string | undefined {
  let current = path;
  for (let round = 0; round < 3; round += 1) {
    let next: string;
    try {
      next = decodeURIComponent(current);
    } catch {
      return undefined;
    }
    if (next === current) return current;
    current = next;
  }
  return current;
}

export function assertSafeRawPath(path: string): void {
  const decoded = fullyDecoded(path);
  if (decoded === undefined || hasUnsafeShape(path) || hasUnsafeShape(decoded)) {
    throw new Error(
      'Raw path must be a relative Confluence path under /wiki/api/v2/ or /wiki/rest/api/',
    );
  }
}

export function registerConfluenceTools(
  server: McpServer,
  client: ConfluenceClient,
  config: AppConfig,
): void {
  registerHighLevelTools(server, client);
  server.registerTool(
    'confluence_search',
    {
      description:
        'Primitive: search Confluence content with CQL when only compact search metadata is needed. For search plus page bodies in one call, prefer confluence_search_and_fetch.',
      inputSchema: z.object({
        cql: z.string().min(1).max(4_000),
        limit: z.number().int().min(1).max(100).default(25),
        start: z.number().int().min(0).default(0),
        expand: z.array(z.string()).max(20).optional(),
        max_chars,
      }),
    },
    withError(async ({ cql, limit: resultLimit, start, expand, max_chars: chars }) => {
      const response = await client.requestJson<{
        results?: unknown[];
        start?: number;
        limit?: number;
        size?: number;
        totalSize?: number;
      }>('GET', '/wiki/rest/api/search', { cql, limit: resultLimit, start, expand });
      const results = (response.data.results ?? []).map((item) => {
        if (!item || typeof item !== 'object') return item;
        const record = item as Record<string, unknown>;
        const content =
          record.content && typeof record.content === 'object'
            ? (record.content as Record<string, unknown>)
            : undefined;
        return {
          id: content?.id ?? record.id,
          type: content?.type ?? record.entityType,
          title: record.title ?? content?.title,
          excerpt: record.excerpt,
          space: content?.space,
          url: record.url,
          lastModified: record.lastModified,
          content,
        };
      });
      return toolResult(
        {
          results,
          start: response.data.start ?? start,
          limit: response.data.limit ?? resultLimit,
          size: response.data.size,
          totalSize: response.data.totalSize,
          next_start:
            start + results.length < (response.data.totalSize ?? 0)
              ? start + results.length
              : undefined,
        },
        chars,
      );
    }),
  );

  server.registerTool(
    'confluence_list_pages',
    {
      description:
        'List Confluence pages with optional space, title, status, ID, and body format filters. Use cursor from the previous response for the next page.',
      inputSchema: z.object({
        ids: z.array(z.string()).max(100).optional(),
        space_ids: z.array(z.string()).max(100).optional(),
        title: z.string().optional(),
        status: z.array(z.string()).max(10).optional(),
        sort: z.string().optional(),
        body_format: bodyFormat,
        cursor: z.string().optional(),
        limit,
        max_chars,
      }),
    },
    withError(
      async ({
        ids,
        space_ids,
        title,
        status,
        sort,
        body_format,
        cursor,
        limit: resultLimit,
        max_chars: chars,
      }) => {
        const response = await client.requestJson<unknown>('GET', '/wiki/api/v2/pages', {
          id: ids,
          'space-id': space_ids,
          title,
          status,
          sort,
          'body-format': body_format,
          cursor,
          limit: resultLimit,
        });
        return toolResult({ data: response.data, next_cursor: nextPage(response) }, chars);
      },
    ),
  );

  server.registerTool(
    'confluence_get_page',
    {
      description:
        'Primitive: get one Confluence page by ID. For a page understanding bundle with ancestors, attachments, or comments, prefer confluence_get_page_context.',
      inputSchema: z.object({
        page_id: z.string().min(1),
        body_format: bodyFormat,
        status: z.array(z.string()).max(10).optional(),
        version: z.number().int().positive().optional(),
        include_labels: z.boolean().optional(),
        include_properties: z.boolean().optional(),
        include_operations: z.boolean().optional(),
        include_likes: z.boolean().optional(),
        include_versions: z.boolean().optional(),
        max_chars,
      }),
    },
    withError(
      async ({
        page_id,
        body_format,
        status,
        version,
        include_labels,
        include_properties,
        include_operations,
        include_likes,
        include_versions,
        max_chars: chars,
      }) => {
        const response = await client.requestJson<unknown>(
          'GET',
          `/wiki/api/v2/pages/${id(page_id)}`,
          {
            'body-format': body_format,
            status,
            version,
            'include-labels': include_labels,
            'include-properties': include_properties,
            'include-operations': include_operations,
            'include-likes': include_likes,
            'include-versions': include_versions,
          },
        );
        return toolResult(response.data, chars);
      },
    ),
  );

  server.registerTool(
    'confluence_get_content',
    {
      description:
        'Get a generic Confluence content item through REST API v1 when v2 does not expose the needed content shape or expansion.',
      inputSchema: z.object({
        content_id: z.string().min(1),
        expand: z.array(z.string()).max(30).optional(),
        max_chars,
      }),
    },
    withError(async ({ content_id, expand, max_chars: chars }) => {
      const response = await client.requestJson<unknown>(
        'GET',
        `/wiki/rest/api/content/${id(content_id)}`,
        { expand },
      );
      return toolResult(response.data, chars);
    }),
  );

  server.registerTool(
    'confluence_list_spaces',
    {
      description:
        'List Confluence spaces with optional key, type, status, and description format filters.',
      inputSchema: z.object({
        keys: z.array(z.string()).max(100).optional(),
        type: z.string().optional(),
        status: z.array(z.string()).max(10).optional(),
        sort: z.string().optional(),
        description_format: z.string().optional(),
        cursor: z.string().optional(),
        limit,
        max_chars,
      }),
    },
    withError(
      async ({
        keys,
        type,
        status,
        sort,
        description_format,
        cursor,
        limit: resultLimit,
        max_chars: chars,
      }) => {
        const response = await client.requestJson<unknown>('GET', '/wiki/api/v2/spaces', {
          keys,
          type,
          status,
          sort,
          'description-format': description_format,
          cursor,
          limit: resultLimit,
        });
        return toolResult({ data: response.data, next_cursor: nextPage(response) }, chars);
      },
    ),
  );

  server.registerTool(
    'confluence_get_space',
    {
      description:
        'Primitive: get one Confluence space by ID. When first understanding a space and its structure, prefer confluence_get_space_overview.',
      inputSchema: z.object({
        space_id: z.string().min(1),
        description_format: z.string().optional(),
        include_icon: z.boolean().optional(),
        include_operations: z.boolean().optional(),
        include_permissions: z.boolean().optional(),
        include_properties: z.boolean().optional(),
        max_chars,
      }),
    },
    withError(
      async ({
        space_id,
        description_format,
        include_icon,
        include_operations,
        include_permissions,
        include_properties,
        max_chars: chars,
      }) => {
        const response = await client.requestJson<unknown>(
          'GET',
          `/wiki/api/v2/spaces/${id(space_id)}`,
          {
            'description-format': description_format,
            'include-icon': include_icon,
            'include-operations': include_operations,
            'include-permissions': include_permissions,
            'include-properties': include_properties,
          },
        );
        return toolResult(response.data, chars);
      },
    ),
  );

  server.registerTool(
    'confluence_get_folder',
    {
      description:
        'Get one Confluence folder by ID, optionally including direct children, operations, properties, or collaborators.',
      inputSchema: z.object({
        folder_id: z.string().min(1),
        include_collaborators: z.boolean().optional(),
        include_direct_children: z.boolean().optional(),
        include_operations: z.boolean().optional(),
        include_properties: z.boolean().optional(),
        max_chars,
      }),
    },
    withError(
      async ({
        folder_id,
        include_collaborators,
        include_direct_children,
        include_operations,
        include_properties,
        max_chars: chars,
      }) => {
        const response = await client.requestJson<unknown>(
          'GET',
          `/wiki/api/v2/folders/${id(folder_id)}`,
          {
            'include-collaborators': include_collaborators,
            'include-direct-children': include_direct_children,
            'include-operations': include_operations,
            'include-properties': include_properties,
          },
        );
        return toolResult(response.data, chars);
      },
    ),
  );

  server.registerTool(
    'confluence_create_folder',
    {
      description:
        'Create a folder in a Confluence space, optionally under a parent page or folder.',
      inputSchema: z.object({
        space_id: z.string().min(1),
        title: z.string().min(1).max(500),
        parent_id: z.string().optional(),
        max_chars,
      }),
    },
    withError(async ({ space_id, title, parent_id, max_chars: chars }) => {
      const response = await client.requestJson<unknown>(
        'POST',
        '/wiki/api/v2/folders',
        undefined,
        { spaceId: space_id, title, parentId: parent_id },
      );
      return toolResult(response.data, chars);
    }),
  );

  server.registerTool(
    'confluence_list_children',
    {
      description:
        'Primitive: list one direct level of page or folder children. For a subtree, prefer confluence_get_content_tree so the server handles descendants pagination and reconstruction in one MCP call.',
      inputSchema: z.object({
        parent_id: z.string().min(1),
        parent_type: z.enum(['page', 'folder']).default('page'),
        cursor: z.string().optional(),
        limit,
        sort: z.string().optional(),
        max_chars,
      }),
    },
    withError(
      async ({ parent_id, parent_type, cursor, limit: resultLimit, sort, max_chars: chars }) => {
        const path =
          parent_type === 'page'
            ? `/wiki/api/v2/pages/${id(parent_id)}/children`
            : `/wiki/api/v2/folders/${id(parent_id)}/direct-children`;
        const response = await client.requestJson<unknown>('GET', path, {
          cursor,
          limit: resultLimit,
          sort,
        });
        return toolResult({ data: response.data, next_cursor: nextPage(response) }, chars);
      },
    ),
  );

  server.registerTool(
    'confluence_list_descendants',
    {
      description:
        'Primitive: list one paginated descendants response below a page or folder. For a complete bounded tree with parent/child nesting, prefer confluence_get_content_tree.',
      inputSchema: z.object({
        parent_id: z.string().min(1),
        parent_type: z.enum(['page', 'folder']).default('page'),
        depth: z.number().int().min(1).max(100).optional(),
        cursor: z.string().optional(),
        limit,
        max_chars,
      }),
    },
    withError(
      async ({ parent_id, parent_type, depth, cursor, limit: resultLimit, max_chars: chars }) => {
        const path =
          parent_type === 'page'
            ? `/wiki/api/v2/pages/${id(parent_id)}/descendants`
            : `/wiki/api/v2/folders/${id(parent_id)}/descendants`;
        const response = await client.requestJson<unknown>('GET', path, {
          depth,
          cursor,
          limit: resultLimit,
        });
        return toolResult({ data: response.data, next_cursor: nextPage(response) }, chars);
      },
    ),
  );

  server.registerTool(
    'confluence_get_ancestors',
    {
      description:
        'Get the ancestor chain for a page or folder so an LLM can understand its location in the hierarchy.',
      inputSchema: z.object({
        content_id: z.string().min(1),
        content_type: z.enum(['page', 'folder']).default('page'),
        max_chars,
      }),
    },
    withError(async ({ content_id, content_type, max_chars: chars }) => {
      const path =
        content_type === 'page'
          ? `/wiki/api/v2/pages/${id(content_id)}/ancestors`
          : `/wiki/api/v2/folders/${id(content_id)}/ancestors`;
      const response = await client.requestJson<unknown>('GET', path);
      return toolResult(response.data, chars);
    }),
  );

  server.registerTool(
    'confluence_list_attachments',
    {
      description:
        'List attachments for a page with optional filename, media type, status, and cursor filters.',
      inputSchema: z.object({
        page_id: z.string().min(1),
        filename: z.string().optional(),
        media_type: z.string().optional(),
        status: z.array(z.string()).max(10).optional(),
        cursor: z.string().optional(),
        limit,
        max_chars,
      }),
    },
    withError(
      async ({
        page_id,
        filename,
        media_type,
        status,
        cursor,
        limit: resultLimit,
        max_chars: chars,
      }) => {
        const response = await client.requestJson<unknown>(
          'GET',
          `/wiki/api/v2/pages/${id(page_id)}/attachments`,
          { filename, mediaType: media_type, status, cursor, limit: resultLimit },
        );
        return toolResult({ data: response.data, next_cursor: nextPage(response) }, chars);
      },
    ),
  );

  server.registerTool(
    'confluence_get_attachment',
    {
      description:
        'Get attachment metadata and optional version, labels, properties, operations, or collaborators.',
      inputSchema: z.object({
        attachment_id: z.string().min(1),
        version: z.number().int().positive().optional(),
        include_labels: z.boolean().optional(),
        include_properties: z.boolean().optional(),
        include_operations: z.boolean().optional(),
        include_versions: z.boolean().optional(),
        include_collaborators: z.boolean().optional(),
        max_chars,
      }),
    },
    withError(
      async ({
        attachment_id,
        version,
        include_labels,
        include_properties,
        include_operations,
        include_versions,
        include_collaborators,
        max_chars: chars,
      }) => {
        const response = await client.requestJson<unknown>(
          'GET',
          `/wiki/api/v2/attachments/${id(attachment_id)}`,
          {
            version,
            'include-labels': include_labels,
            'include-properties': include_properties,
            'include-operations': include_operations,
            'include-versions': include_versions,
            'include-collaborators': include_collaborators,
          },
        );
        return toolResult(response.data, chars);
      },
    ),
  );

  server.registerTool(
    'confluence_list_comments',
    {
      description:
        'Primitive: list root footer or inline comments on a page. For one discussion and all bounded replies, prefer confluence_get_comment_thread; use this for a single page-level comment list.',
      inputSchema: z.object({
        page_id: z.string().min(1),
        comment_type: z.enum(['footer', 'inline']).default('footer'),
        body_format: bodyFormat,
        status: z.array(z.string()).max(10).optional(),
        resolution_status: z.array(z.string()).max(10).optional(),
        sort: z.string().optional(),
        cursor: z.string().optional(),
        limit,
        max_chars,
      }),
    },
    withError(
      async ({
        page_id,
        comment_type,
        body_format,
        status,
        resolution_status,
        sort,
        cursor,
        limit: resultLimit,
        max_chars: chars,
      }) => {
        const suffix = comment_type === 'footer' ? 'footer-comments' : 'inline-comments';
        const response = await client.requestJson<unknown>(
          'GET',
          `/wiki/api/v2/pages/${id(page_id)}/${suffix}`,
          {
            'body-format': body_format,
            status,
            'resolution-status': resolution_status,
            sort,
            cursor,
            limit: resultLimit,
          },
        );
        return toolResult({ data: response.data, next_cursor: nextPage(response) }, chars);
      },
    ),
  );

  server.registerTool(
    'confluence_get_comment',
    {
      description:
        'Get one footer or inline comment by ID, including its body and optional version metadata.',
      inputSchema: z.object({
        comment_id: z.string().min(1),
        comment_type: z.enum(['footer', 'inline']).default('footer'),
        body_format: bodyFormat,
        version: z.number().int().positive().optional(),
        include_versions: z.boolean().optional(),
        max_chars,
      }),
    },
    withError(
      async ({
        comment_id,
        comment_type,
        body_format,
        version,
        include_versions,
        max_chars: chars,
      }) => {
        const suffix = comment_type === 'footer' ? 'footer-comments' : 'inline-comments';
        const response = await client.requestJson<unknown>(
          'GET',
          `/wiki/api/v2/${suffix}/${id(comment_id)}`,
          { 'body-format': body_format, version, 'include-versions': include_versions },
        );
        return toolResult(response.data, chars);
      },
    ),
  );

  server.registerTool(
    'confluence_list_versions',
    {
      description:
        'List page version history with optional body representation and cursor pagination.',
      inputSchema: z.object({
        page_id: z.string().min(1),
        body_format: bodyFormat,
        sort: z.string().optional(),
        cursor: z.string().optional(),
        limit,
        max_chars,
      }),
    },
    withError(
      async ({ page_id, body_format, sort, cursor, limit: resultLimit, max_chars: chars }) => {
        const response = await client.requestJson<unknown>(
          'GET',
          `/wiki/api/v2/pages/${id(page_id)}/versions`,
          { 'body-format': body_format, sort, cursor, limit: resultLimit },
        );
        return toolResult({ data: response.data, next_cursor: nextPage(response) }, chars);
      },
    ),
  );

  server.registerTool(
    'confluence_get_page_version',
    {
      description: 'Get details for one historical page version.',
      inputSchema: z.object({
        page_id: z.string().min(1),
        version_number: z.number().int().positive(),
        max_chars,
      }),
    },
    withError(async ({ page_id, version_number, max_chars: chars }) => {
      const response = await client.requestJson<unknown>(
        'GET',
        `/wiki/api/v2/pages/${id(page_id)}/versions/${version_number}`,
      );
      return toolResult(response.data, chars);
    }),
  );

  server.registerTool(
    'confluence_get_content_history',
    {
      description:
        'Get v1 history details for generic Confluence content, useful when the v2 page model does not expose the required history shape.',
      inputSchema: z.object({
        content_id: z.string().min(1),
        start: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(100).default(25),
        expand: z.array(z.string()).max(20).optional(),
        max_chars,
      }),
    },
    withError(async ({ content_id, start, limit: resultLimit, expand, max_chars: chars }) => {
      const response = await client.requestJson<unknown>(
        'GET',
        `/wiki/rest/api/content/${id(content_id)}/history`,
        { start, limit: resultLimit, expand },
      );
      return toolResult(response.data, chars);
    }),
  );

  server.registerTool(
    'confluence_create_page',
    {
      description:
        'Create a published or draft Confluence page in a space, optionally under a parent page. Body is Confluence storage or Atlas document format.',
      inputSchema: z.object({
        space_id: z.string().min(1),
        title: z.string().min(1).max(500),
        body: z.string(),
        representation: z.enum(['storage', 'atlas_doc_format']).default('storage'),
        status: z.enum(['current', 'draft']).default('current'),
        parent_id: z.string().optional(),
        subtype: z.string().optional(),
        max_chars,
      }),
    },
    withError(
      async ({
        space_id,
        title,
        body,
        representation,
        status,
        parent_id,
        subtype,
        max_chars: chars,
      }) => {
        const response = await client.requestJson<unknown>(
          'POST',
          '/wiki/api/v2/pages',
          undefined,
          {
            spaceId: space_id,
            title,
            status,
            parentId: parent_id,
            body: { representation, value: body },
            subtype,
          },
        );
        return toolResult(response.data, chars);
      },
    ),
  );

  server.registerTool(
    'confluence_update_page',
    {
      description:
        'Update a page body and title using an explicit current version number. Read the page first when unsure; Confluence requires optimistic versioning.',
      inputSchema: z.object({
        page_id: z.string().min(1),
        title: z.string().min(1).max(500),
        body: z.string(),
        representation: z.enum(['storage', 'atlas_doc_format']).default('storage'),
        version_number: z.number().int().positive(),
        version_message: z.string().max(500).optional(),
        minor_edit: z.boolean().optional(),
        status: z.enum(['current', 'draft']).default('current'),
        space_id: z.string().optional(),
        parent_id: z.string().optional(),
        max_chars,
      }),
    },
    withError(
      async ({
        page_id,
        title,
        body,
        representation,
        version_number,
        version_message,
        minor_edit,
        status,
        space_id,
        parent_id,
        max_chars: chars,
      }) => {
        const response = await client.requestJson<unknown>(
          'PUT',
          `/wiki/api/v2/pages/${id(page_id)}`,
          undefined,
          {
            id: page_id,
            title,
            status,
            spaceId: space_id,
            parentId: parent_id,
            body: { representation, value: body },
            version: { number: version_number, message: version_message, minorEdit: minor_edit },
          },
        );
        return toolResult(response.data, chars);
      },
    ),
  );

  server.registerTool(
    'confluence_update_page_title',
    {
      description:
        'Update only a page title using the v2 title endpoint and explicit version number.',
      inputSchema: z.object({
        page_id: z.string().min(1),
        title: z.string().min(1).max(500),
        version_number: z.number().int().positive(),
        version_message: z.string().max(500).optional(),
        minor_edit: z.boolean().optional(),
        max_chars,
      }),
    },
    withError(
      async ({ page_id, title, version_number, version_message, minor_edit, max_chars: chars }) => {
        const response = await client.requestJson<unknown>(
          'PUT',
          `/wiki/api/v2/pages/${id(page_id)}/title`,
          undefined,
          {
            title,
            version: { number: version_number, message: version_message, minorEdit: minor_edit },
          },
        );
        return toolResult(response.data, chars);
      },
    ),
  );

  server.registerTool(
    'confluence_create_comment',
    {
      description: 'Create a footer comment on a page or as a reply to an existing comment.',
      inputSchema: z.object({
        page_id: z.string().optional(),
        parent_comment_id: z.string().optional(),
        body: z.string().min(1),
        representation: z.enum(['storage', 'atlas_doc_format']).default('storage'),
        max_chars,
      }),
    },
    withError(async ({ page_id, parent_comment_id, body, representation, max_chars: chars }) => {
      if (!page_id && !parent_comment_id) throw new Error('Provide page_id or parent_comment_id');
      const response = await client.requestJson<unknown>(
        'POST',
        '/wiki/api/v2/footer-comments',
        undefined,
        {
          pageId: page_id,
          parentCommentId: parent_comment_id,
          body: { representation, value: body },
        },
      );
      return toolResult(response.data, chars);
    }),
  );

  server.registerTool(
    'confluence_update_comment',
    {
      description:
        'Update a footer comment body. Use confluence_get_comment first if you need to inspect its current version.',
      inputSchema: z.object({
        comment_id: z.string().min(1),
        body: z.string().min(1),
        representation: z.enum(['storage', 'atlas_doc_format']).default('storage'),
        max_chars,
      }),
    },
    withError(async ({ comment_id, body, representation, max_chars: chars }) => {
      const response = await client.requestJson<unknown>(
        'PUT',
        `/wiki/api/v2/footer-comments/${id(comment_id)}`,
        undefined,
        { body: { representation, value: body } },
      );
      return toolResult(response.data, chars);
    }),
  );

  server.registerTool(
    'confluence_create_inline_comment',
    {
      description:
        'Create an inline comment on a page. inline_comment_properties should contain the selection coordinates required by the Confluence v2 API.',
      inputSchema: z.object({
        page_id: z.string().optional(),
        parent_comment_id: z.string().optional(),
        body: z.string().min(1),
        representation: z.enum(['storage', 'atlas_doc_format']).default('storage'),
        inline_comment_properties: z.record(z.unknown()),
        max_chars,
      }),
    },
    withError(
      async ({
        page_id,
        parent_comment_id,
        body,
        representation,
        inline_comment_properties,
        max_chars: chars,
      }) => {
        if (!page_id && !parent_comment_id) throw new Error('Provide page_id or parent_comment_id');
        const response = await client.requestJson<unknown>(
          'POST',
          '/wiki/api/v2/inline-comments',
          undefined,
          {
            pageId: page_id,
            parentCommentId: parent_comment_id,
            body: { representation, value: body },
            inlineCommentProperties: inline_comment_properties,
          },
        );
        return toolResult(response.data, chars);
      },
    ),
  );

  server.registerTool(
    'confluence_update_inline_comment',
    {
      description: 'Update or resolve an inline comment.',
      inputSchema: z.object({
        comment_id: z.string().min(1),
        body: z.string().min(1).optional(),
        representation: z.enum(['storage', 'atlas_doc_format']).default('storage'),
        resolved: z.boolean().optional(),
        max_chars,
      }),
    },
    withError(async ({ comment_id, body, representation, resolved, max_chars: chars }) => {
      const response = await client.requestJson<unknown>(
        'PUT',
        `/wiki/api/v2/inline-comments/${id(comment_id)}`,
        undefined,
        { body: body === undefined ? undefined : { representation, value: body }, resolved },
      );
      return toolResult(response.data, chars);
    }),
  );

  server.registerTool(
    'confluence_delete_page',
    {
      description:
        'Move a page to the Confluence trash, or permanently purge a trashed page. Disabled unless CONFLUENCE_ALLOW_DESTRUCTIVE_OPERATIONS=true and confirm=true.',
      inputSchema: z.object({
        page_id: z.string().min(1),
        confirm: z.literal(true),
        purge: z.boolean().optional(),
        draft: z.boolean().optional(),
        max_chars,
      }),
    },
    withError(async ({ page_id, confirm, purge, draft, max_chars: chars }) => {
      if (!config.allowDestructiveOperations)
        throw new Error(
          'Destructive operations are disabled by CONFLUENCE_ALLOW_DESTRUCTIVE_OPERATIONS',
        );
      assertConfirmed(config, confirm, 'Page deletion');
      const response = await client.requestJson<unknown>(
        'DELETE',
        `/wiki/api/v2/pages/${id(page_id)}`,
        { purge, draft },
      );
      return toolResult({ deleted: true, page_id, status: response.status }, chars);
    }),
  );

  server.registerTool(
    'confluence_upload_attachment',
    {
      description:
        'Upload a local file to a page using REST API v1. Disabled unless CONFLUENCE_ALLOW_LOCAL_FILE_UPLOAD=true and confirm=true; the file path is read by this local process.',
      inputSchema: z.object({
        page_id: z.string().min(1),
        file_path: z.string().min(1),
        comment: z.string().max(500).optional(),
        confirm: z.literal(true),
        max_chars,
      }),
    },
    withError(async ({ page_id, file_path, comment, confirm, max_chars: chars }) => {
      if (!config.allowLocalFileUpload)
        throw new Error('Local file upload is disabled by CONFLUENCE_ALLOW_LOCAL_FILE_UPLOAD');
      assertConfirmed(config, confirm, 'Attachment upload');
      const fileInfo = await stat(file_path);
      if (!fileInfo.isFile()) throw new Error('file_path must point to a regular file');
      if (fileInfo.size > 50 * 1024 * 1024)
        throw new Error('Attachment upload is limited to 50 MiB');
      const file = new Blob([await readFile(file_path)]);
      const response = await client.uploadAttachment(page_id, file, basename(file_path), comment);
      return toolResult({ uploaded: true, response: response.data }, chars);
    }),
  );

  server.registerTool(
    'confluence_raw_request',
    {
      description:
        'Call an allowlisted Confluence REST API path for an operation not covered by a named tool. Path must be under /wiki/api/v2/ or /wiki/rest/api/. GET is enabled by default; non-GET requires CONFLUENCE_ALLOW_RAW_WRITE=true and confirm=true, and DELETE also requires destructive opt-in.',
      inputSchema: z.object({
        method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
        path: z.string().min(1).max(500),
        query: z
          .record(
            z.union([
              z.string(),
              z.number(),
              z.boolean(),
              z.array(z.union([z.string(), z.number()])),
            ]),
          )
          .optional(),
        body: z.unknown().optional(),
        confirm: z.boolean().default(false),
        max_chars,
      }),
    },
    withError(async ({ method, path, query, body, confirm, max_chars: chars }) => {
      assertSafeRawPath(path);
      if (method !== 'GET') {
        if (!config.allowRawWrite)
          throw new Error('Raw write operations are disabled by CONFLUENCE_ALLOW_RAW_WRITE');
        assertConfirmed(config, confirm, 'Raw write');
      }
      if (method === 'DELETE' && !config.allowDestructiveOperations)
        throw new Error('Raw DELETE is disabled by CONFLUENCE_ALLOW_DESTRUCTIVE_OPERATIONS');
      const response = await client.requestJson<unknown>(method, path, query, body);
      return toolResult({ status: response.status, data: response.data }, chars);
    }),
  );
}
