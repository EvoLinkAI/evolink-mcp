import type { ConnectionIdentity } from './auth.js';

/** Maps a verified connection to the EvoLink key that pays for its calls. */
export interface KeyResolver {
  resolve(identity: ConnectionIdentity): Promise<string>;
}

/** The connection has no usable key right now; the message is shown to the agent. */
export class KeyUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KeyUnavailableError';
  }
}

/**
 * Placeholder until the gateway exposes per-connection MCP keys. Whether the
 * key ever leaves the gateway is still being decided, so nothing is wired yet.
 */
export const unconfiguredKeyResolver: KeyResolver = {
  async resolve(): Promise<string> {
    throw new KeyUnavailableError(
      'EvoLink account access for MCP connections is not enabled on this server yet. No request was sent and nothing was charged.',
    );
  },
};
