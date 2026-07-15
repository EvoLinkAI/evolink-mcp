import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { fileDelete } from '../services/file-client.js';

const schema = {
  file_id: z.string().regex(/^file_[A-Za-z0-9_-]{6,128}$/)
    .describe('The file ID to delete (e.g., file_abc123456). Use list_files to find file IDs.'),
  confirm_delete: z.literal(true)
    .describe('Must be true to confirm permanent deletion of this file.'),
};

export function registerDeleteFile(server: McpServer): void {
  server.tool(
    'delete_file',
    'Permanently delete one uploaded file from EvoLink cloud storage. Requires explicit confirm_delete=true.',
    schema,
    {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    async (params) => {
      const result = await fileDelete(params.file_id);

      return {
        content: [{
          type: 'text' as const,
          text: `File ${params.file_id} deleted successfully. Quota slot freed.${result.request_id ? ` Request ID: ${result.request_id}` : ''}`,
        }],
      };
    },
  );
}
