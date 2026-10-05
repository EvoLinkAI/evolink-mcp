import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ServerConfig } from '../config.js';
import { currentCredentialMode } from '../request-context.js';
import { getCredits } from '../services/api-client.js';
import { CREDITS_PER_USD } from '../services/error-handler.js';
import { API_KEYS_URL, MCP_CONSOLE_URL, TOP_UP_URL } from '../services/http-policy.js';
import { READ_ONLY, errorResult, money, ok, usdOf } from './shared.js';

/** Below this the user is told the balance, or the limit, is nearly gone (about $1). */
const LOW_BALANCE_CREDITS = CREDITS_PER_USD;

export function registerCheckBalance(server: McpServer, config: ServerConfig): void {
  server.registerTool('check_balance', {
    title: 'Check balance',
    description: [
      'Show the EvoLink account balance and what has been spent: by EvoLink MCP in total (all assistants connected by sign-in) or by this API key, with its limit if one is set. Free.',
      'Also a quick way to confirm the connection works.',
      'Credits: 68 credits ≈ $1.',
    ].join(' '),
    inputSchema: {},
    annotations: { title: 'Check balance', ...READ_ONLY },
  }, async () => {
    try {
      const credits = await getCredits(config);
      // A signed-in connection spends the account's MCP key: its spend and limit cover every connected assistant.
      const signedIn = currentCredentialMode() === 'signed_in';
      const who = signedIn ? 'EvoLink MCP (all assistants connected to this account)' : 'This API key';
      const limitName = signedIn ? 'the EvoLink MCP limit' : 'its limit';
      const balance = Math.max(0, credits.user.remaining_credits);
      const lines = [`Account balance: ${money(balance)}`];
      const structured: Record<string, unknown> = {
        account_balance_credits: balance,
        account_balance_usd: usdOf(balance),
        spent_scope: signedIn ? 'mcp' : 'api_key',
        spent_credits: credits.token.used_credits,
        spent_usd: usdOf(credits.token.used_credits),
        has_limit: !credits.token.unlimited_credits,
        top_up_url: TOP_UP_URL,
        ...(signedIn ? { mcp_settings_url: MCP_CONSOLE_URL } : {}),
      };
      if (credits.token.unlimited_credits) {
        lines.push(signedIn
          ? `${who} has spent ${money(credits.token.used_credits)}; no EvoLink MCP limit is set, so only the account balance applies.`
          : `${who} has spent ${money(credits.token.used_credits)} and has no spending limit of its own (the account balance applies).`);
      } else {
        const left = Math.max(0, credits.token.remaining_credits);
        lines.push(`${who} has spent ${money(credits.token.used_credits)}; ${money(left)} of ${limitName} is left.`);
        structured.limit_remaining_credits = left;
        structured.limit_remaining_usd = usdOf(left);
        if (left < LOW_BALANCE_CREDITS) {
          lines.push(signedIn
            ? `The EvoLink MCP limit is nearly used up (it is a limit, not the account balance); the user can raise it at ${MCP_CONSOLE_URL}.`
            : `This API key's limit is nearly used up; raise it at ${API_KEYS_URL}.`);
        }
      }
      if (balance < LOW_BALANCE_CREDITS) lines.push('The account balance is low; paid generations may be refused.');
      lines.push(`Top up: ${TOP_UP_URL}`);
      return ok(lines.join('\n'), structured);
    } catch (error) {
      return errorResult(error);
    }
  });
}
