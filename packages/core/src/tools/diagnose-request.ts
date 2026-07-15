import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { diagnoseRequest } from '../services/catalog-client.js';

export function registerDiagnoseRequest(server: McpServer): void {
  server.tool(
    'diagnose_request',
    'Read a redacted, account-scoped recovery diagnosis for one EvoLink request ID.',
    {
      request_id: z.string().regex(/^[A-Za-z0-9._-]{8,128}$/)
        .describe('Request ID returned by a previous EvoLink tool call'),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async ({ request_id }) => {
      try {
        const diagnosis = await diagnoseRequest(request_id);
        const lines = [
          `Request: ${diagnosis.request_id}`,
          `Status: ${diagnosis.status}`,
          `Observed: ${diagnosis.observed_at}`,
          '', 'Findings:', ...diagnosis.findings.map(value => `- ${value}`),
          '', 'Recovery actions:', ...diagnosis.recovery_actions.map(value => `- ${value}`),
        ];
        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: error instanceof Error ? error.message : 'Request diagnosis failed' }],
          isError: true,
        };
      }
    },
  );
}
