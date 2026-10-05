import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ServerConfig } from './config.js';
import { setProcessClientName } from './request-context.js';
import { registerCheckBalance } from './tools/check-balance.js';
import { registerEstimateCost } from './tools/estimate-cost.js';
import { registerGenerateTools } from './tools/generate.js';
import { registerGetModel } from './tools/get-model.js';
import { registerGetTask } from './tools/get-task.js';
import { registerListTasks } from './tools/list-tasks.js';
import { registerSearchModels } from './tools/search-models.js';
import { registerUploadFile } from './tools/upload-file.js';
import { MCP_VERSION } from './version.js';

export { type ServerConfig, createConfig, getApiKey } from './config.js';

export interface ServerOptions {
  /** Allow upload_file to read local paths (stdio only); the hosted service sets false. */
  localFileUploads?: boolean;
  /**
   * Offer upload_file at all. Signed-in hosted connections set false: files-api
   * accepts only the user's own API key, which key custody A never hands out.
   */
  uploads?: boolean;
  /** Remember the client's name from initialize for X-Evo-Client-Name (stdio only; hosted requests carry their own). */
  trackClientName?: boolean;
}

/** Sent to the client at initialize; most assistants add it to their instructions. */
export const SERVER_INSTRUCTIONS = [
  'EvoLink creates images, videos, music and speech with 150+ models, billed to the user\'s EvoLink balance (68 credits ≈ $1).',
  '- Find a model with search_models; read its parameters and prices with get_model.',
  '- Before a paid generate_image, generate_video or generate_audio call, get the price with estimate_cost and tell the user; go ahead once they agree, or if they already approved this spend.',
  '- generate_video and generate_audio return a task_id; wait for it with get_task (up to 45 s per call). Never call a generate tool again to check progress: that charges again.',
  '- Result links expire after 24 hours; give them to the user right away.',
  '- Errors include a next step (for example a top-up link); follow it instead of retrying blindly.',
  '- When a call is refused for money, tell the user which reason the error names: the EvoLink MCP limit (or daily limit) they set, EvoLink MCP being paused, or the account balance. They need different fixes, so never call an MCP limit a low balance; give the link from the error and do not retry until the user has acted.',
].join('\n');

export function createServer(config: ServerConfig, options: ServerOptions = {}): McpServer {
  const server = new McpServer(
    {
      name: config.channel === 'beta' ? 'evolink-mcp-beta' : 'evolink-mcp',
      title: 'EvoLink',
      version: MCP_VERSION,
      websiteUrl: 'https://evolink.ai/mcp',
    },
    { instructions: SERVER_INSTRUCTIONS },
  );
  if (options.trackClientName ?? true) {
    server.server.oninitialized = () => setProcessClientName(server.server.getClientVersion()?.name);
  }

  registerSearchModels(server);
  registerGetModel(server);
  registerEstimateCost(server, config);
  registerGenerateTools(server, config);
  registerGetTask(server, config);
  registerListTasks(server, config);
  if (options.uploads ?? true) registerUploadFile(server, { localFiles: options.localFileUploads ?? true });
  registerCheckBalance(server, config);

  return server;
}
