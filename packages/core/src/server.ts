import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ServerConfig } from './config.js';
import { registerGenerateImage } from './tools/generate-image.js';
import { registerGenerateVideo } from './tools/generate-video.js';
import { registerGenerateMusic } from './tools/generate-music.js';
import { registerListModels } from './tools/list-models.js';
import { registerEstimateCost } from './tools/estimate-cost.js';
import { registerCheckTask } from './tools/check-task.js';
import { registerUploadFile } from './tools/upload-file.js';
import { registerDeleteFile } from './tools/delete-file.js';
import { registerListFiles } from './tools/list-files.js';
import { registerModelHealth } from './tools/model-health.js';
import { registerMCPSetup } from './tools/mcp-setup.js';
import { registerDiagnoseRequest } from './tools/diagnose-request.js';

export { type ServerConfig, createConfig, getApiKey } from './config.js';

export function createServer(config: ServerConfig): McpServer {
  const server = new McpServer({
    name: config.channel === 'beta' ? 'evolink-mcp-beta' : 'evolink-mcp',
    version: '1.3.0',
  });

  registerGenerateImage(server, config);
  registerGenerateVideo(server, config);
  registerGenerateMusic(server, config);
  registerListModels(server);
  registerEstimateCost(server);
  registerCheckTask(server, config);
  registerUploadFile(server);
  registerDeleteFile(server);
  registerListFiles(server);
  registerModelHealth(server);
  registerMCPSetup(server);
  registerDiagnoseRequest(server);

  return server;
}
