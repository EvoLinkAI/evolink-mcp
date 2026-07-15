import { isIP } from 'node:net';
import type { ApiFormat } from '../data/text-models.js';

const CACHE_TTL_MS = 5 * 60_000;
const MAX_STALE_MS = 24 * 60 * 60_000;

export interface CatalogTextModel {
  model_id: string;
  display_name: string;
  provider: string;
  aliases: string[];
  capabilities: string[];
  protocols: string[];
  lifecycle: 'preview' | 'active' | 'deprecated' | 'retired';
}

interface CatalogResponse {
  meta: { schema_version: string; catalog_version: string; updated_at: string; fresh_until: string };
  models: CatalogTextModel[];
}

export interface TextCatalogResult {
  data: CatalogResponse;
  source: 'live' | 'cache' | 'stale-cache';
  warning?: string;
}

let cached: { data: CatalogResponse; fetchedAt: number } | undefined;

function controlBaseURL(): string {
  const configured = (process.env.EVOLINK_CONTROL_BASE ?? 'https://api.evolink.ai').trim().replace(/\/$/, '');
  const parsed = new URL(configured);
  const loopback = parsed.hostname === 'localhost' || (isIP(parsed.hostname) !== 0 && parsed.hostname === '127.0.0.1');
  if ((parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('EVOLINK_CONTROL_BASE must be a secure absolute URL');
  }
  return configured;
}

export async function getTextCatalog(): Promise<TextCatalogResult> {
  const now = Date.now();
  if (cached && now - cached.fetchedAt < CACHE_TTL_MS) return { data: cached.data, source: 'cache' };
  try {
    const controller = new AbortController();
    const rawTimeout = Number(process.env.EVOLINK_MCP_READ_TIMEOUT_MS ?? 15_000);
    const timeout = Number.isInteger(rawTimeout) && rawTimeout >= 1_000 && rawTimeout <= 600_000 ? rawTimeout : 15_000;
    const timer = setTimeout(() => controller.abort(), timeout);
    let response: Response;
    try {
      response = await fetch(`${controlBaseURL()}/v1/catalog/models?capability=text`, {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
          'X-Evo-Client': 'mcp',
          'X-Evo-Client-Version': process.env.npm_package_version ?? 'dev',
          'X-Evo-Tool': 'list_text_models',
        },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) throw new Error(`Catalog HTTP ${response.status}`);
    const data = await response.json() as CatalogResponse;
    if (!data.meta?.catalog_version || !Array.isArray(data.models)) throw new Error('Catalog returned an invalid versioned envelope');
    cached = { data, fetchedAt: now };
    return { data, source: 'live' };
  } catch (error) {
    if (cached && now - cached.fetchedAt <= MAX_STALE_MS) {
      return {
        data: cached.data,
        source: 'stale-cache',
        warning: `Catalog refresh failed; using in-memory version ${cached.data.meta.catalog_version}.`,
      };
    }
    throw error;
  }
}

export function catalogApiFormat(model: CatalogTextModel): ApiFormat {
  const protocols = new Set(model.protocols.map(value => value.toLowerCase()));
  if (model.provider.toLowerCase().includes('anthropic') && protocols.has('anthropic-messages')) return 'anthropic';
  if (protocols.has('openai-chat-completions')) return 'openai';
  if (protocols.has('anthropic-messages')) return 'anthropic';
  throw new Error(`Model ${model.model_id} has no supported text protocol`);
}

export function resetTextCatalogForTests(): void {
  cached = undefined;
}
