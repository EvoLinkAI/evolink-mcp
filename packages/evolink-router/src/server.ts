import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RouterConfig } from './config.js';
import { registerDelegate } from './tools/delegate.js';
import { registerCascade } from './tools/cascade.js';
import { registerSmartRoute } from './tools/smart-route.js';
import { registerListTextModels } from './tools/list-text-models.js';

export function createServer(config: RouterConfig): McpServer {
  const server = new McpServer({
    name: 'evolink-mcp-router',
    version: '1.0.0',
  });

  registerDelegate(server, config);
  registerCascade(server, config);
  registerSmartRoute(server);
  registerListTextModels(server);

  return server;
}
