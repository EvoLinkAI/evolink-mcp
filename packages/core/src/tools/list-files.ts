import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { fileList, fileQuota } from '../services/file-client.js';

const schema = {
  page: z.number().int().min(1).default(1).optional()
    .describe('Page number (default: 1)'),
  page_size: z.number().int().min(1).max(100).default(20).optional()
    .describe('Files per page (default: 20, max: 100)'),
};

export function registerListFiles(server: McpServer): void {
  server.tool(
    'list_files',
    'List uploaded files and check storage quota. Shows file names, sizes, upload times, and remaining quota. Use delete_file to free quota when needed.',
    schema,
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async (params) => {
      const [listResult, quotaResult] = await Promise.all([
        fileList(params.page, params.page_size),
        fileQuota(),
      ]);

      const quota = quotaResult.data!;
      const list = listResult.data!;

      const lines = [
        `Quota: ${quota.used_files}/${quota.max_files} files used, ${quota.remain_files} remaining [${quota.user_group}]`,
        '',
        `Files (page ${params.page ?? 1}, total: ${list.total}):`,
      ];

      if (list.files.length === 0) {
        lines.push('  (no files)');
      } else {
        for (const f of list.files) {
          const size = f.file_size >= 1048576
            ? `${(f.file_size / 1048576).toFixed(1)} MB`
            : `${(f.file_size / 1024).toFixed(1)} KB`;
          lines.push(`  - ${f.file_name} (${size}) [${f.file_id}] uploaded ${f.upload_time}`);
        }
      }

      lines.push('', 'Use delete_file with a file_id to free quota.');

      return {
        content: [{ type: 'text' as const, text: lines.join('\n') }],
      };
    },
  );
}
