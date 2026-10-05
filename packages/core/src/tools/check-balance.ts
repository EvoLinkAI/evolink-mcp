import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ServerConfig } from '../config.js';
import { processCredentialsAllowed } from '../request-context.js';
import { getCredits } from '../services/api-client.js';
import { CREDITS_PER_USD } from '../services/error-handler.js';
import { TOP_UP_URL } from '../services/http-policy.js';
import { READ_ONLY, errorResult, money, ok, usdOf } from './shared.js';

/** Below this the user is told the balance is low (about $1). */
const LOW_BALANCE_CREDITS = CREDITS_PER_USD;

export function registerCheckBalance(server: McpServer, config: ServerConfig): void {
  server.registerTool('check_balance', {
    title: 'Check balance',
    description: [
      'Show the EvoLink account balance, what this connection (or API key) has spent, and its limit if one is set. Free.',
      'Also a quick way to confirm the connection works.',
      'Credits: 68 credits ≈ $1.',
    ].join(' '),
    inputSchema: {},
    annotations: { title: 'Check balance', ...READ_ONLY },
  }, async () => {
    try {
      const credits = await getCredits(config);
      const who = processCredentialsAllowed() ? 'This API key' : 'This connection';
      const balance = Math.max(0, credits.user.remaining_credits);
      const lines = [`Account balance: ${money(balance)}`];
      const structured: Record<string, unknown> = {
        account_balance_credits: balance,
        account_balance_usd: usdOf(balance),
        spent_credits: credits.token.used_credits,
        spent_usd: usdOf(credits.token.used_credits),
        has_limit: !credits.token.unlimited_credits,
        top_up_url: TOP_UP_URL,
      };
      if (credits.token.unlimited_credits) {
        lines.push(`${who} has spent ${money(credits.token.used_credits)} and has no spending limit of its own (the account balance applies).`);
      } else {
        lines.push(`${who} has spent ${money(credits.token.used_credits)}; ${money(credits.token.remaining_credits)} of its limit is left.`);
        structured.limit_remaining_credits = credits.token.remaining_credits;
        structured.limit_remaining_usd = usdOf(credits.token.remaining_credits);
      }
      if (balance < LOW_BALANCE_CREDITS) lines.push('The balance is low; paid generations may be refused.');
      lines.push(`Top up: ${TOP_UP_URL}`);
      return ok(lines.join('\n'), structured);
    } catch (error) {
      return errorResult(error);
    }
  });
}
