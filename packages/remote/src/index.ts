#!/usr/bin/env node
import { createConfig } from '../../core/src/config.js';
import { createPassportVerifier } from './auth.js';
import { startRemoteService } from './service.js';
import { loadSettings } from './settings.js';

async function main(): Promise<void> {
  const settings = loadSettings(process.env);
  if (settings.auth === 'oauth' && !settings.serviceToken) {
    console.error('EVOLINK_MCP_SERVICE_TOKEN is not set: signed-in connections can browse models but paid and account tools are disabled.');
  }

  const service = await startRemoteService({
    config: createConfig('official'),
    auth: settings.auth,
    resourceUrl: settings.resourceUrl,
    authorizationServer: settings.auth === 'oauth' ? settings.authorizationServer : undefined,
    requiredScope: settings.requiredScope,
    verifier: settings.auth === 'oauth'
      ? createPassportVerifier({
        issuer: settings.issuer,
        audience: settings.resourceUrl,
        jwksUrl: settings.jwksUrl,
        requiredScope: settings.requiredScope,
      })
      : undefined,
    serviceToken: settings.serviceToken,
    documentationUrl: settings.documentationUrl,
    rateLimitPerMinute: settings.rateLimitPerMinute,
    maxBodyBytes: settings.maxBodyBytes,
    allowedHosts: settings.allowedHosts,
  }, { host: settings.host, port: settings.port });

  console.error(`EvoLink remote MCP (${settings.auth}) listening on ${service.url}, public URL ${settings.resourceUrl}`);

  const shutdown = () => {
    setTimeout(() => process.exit(0), 10_000).unref();
    service.close().then(() => process.exit(0), () => process.exit(1));
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

main().catch((error) => {
  console.error('Fatal error:', error instanceof Error ? error.message : error);
  process.exit(1);
});
