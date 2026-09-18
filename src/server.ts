import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppConfig } from './config.js';
import { ConfluenceClient } from './client/confluence-client.js';
import { registerConfluenceTools } from './tools/index.js';

export const SERVER_NAME = 'confluence-cloud-mcp';
export const SERVER_VERSION = '0.3.1';

export function createServer(config: AppConfig, client = new ConfluenceClient(config)): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  registerConfluenceTools(server, client, config);
  return server;
}
