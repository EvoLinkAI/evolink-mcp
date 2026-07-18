import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { TEXT_MODELS, type Tier } from '../data/text-models.js';
import { getTextCatalog } from '../services/catalog-client.js';

// --- Pattern-based routing rules ---

const TIER3_PATTERNS = [
  // Architecture & strategy
  /\b(system\s*design|architect(ure)?|tech\s*select|business\s*strategy|product\s*roadmap)\b/i,
  // Deep analysis
  /\b(security\s*audit|root\s*cause|legal\s*review|financial\s*model)/i,
  /\b(math\s*proof|logic\s*proof|formal\s*verification)\b/i,
  // Complex reasoning
  /\b(deep\s*reason|complex\s*analysis|cross[- ]module\s*refactor|tech\s*debt\s*assess)/i,
  /\b(research\s*report|comprehensive\s*analysis)\b/i,
  // Chinese tier-3 signals
  /\b(系统设计|架构|安全审计|根因分析|法律审查|财务模型|深度分析|技术选型)\b/,
];

const TIER1_PATTERNS = [
  // Simple Q&A
  /\b(what\s+is|define|explain\s+briefly|translate|convert|format)\b/i,
  /\b(status|check|grammar|spell|classify|categorize|extract)\b/i,
  // Quick tasks
  /\b(quick|simple|short|brief|fast)\s+(answer|question|task|summary)\b/i,
  // Chinese tier-1 signals
  /\b(什么是|解释一下|翻译|转换|简单|快速回答|语法检查|分类)\b/,
];

function containsChinese(text: string): boolean {
  return /[\u4e00-\u9fff]/.test(text);
}

interface RouteResult {
  tier: Tier;
  model: string;
  reason: string;
  alternatives: string[];
}

function analyzeTask(prompt: string, available?: Set<string>): RouteResult {
  const hasChinese = containsChinese(prompt);

  const selectModel = (tier: Tier, preferred: string): string => {
    if (!available || available.has(preferred)) return preferred;
    return TEXT_MODELS.find(model => model.tier === tier && available.has(model.name))?.name
      ?? available.values().next().value
      ?? preferred;
  };

  // Check Tier 3 first (most specific)
  for (const pattern of TIER3_PATTERNS) {
    if (pattern.test(prompt)) {
      const model = selectModel(3, hasChinese ? 'claude-opus-4-6' : 'claude-opus-4-6');
      const alts = TEXT_MODELS
        .filter(m => m.tier === 3 && m.name !== model && (!available || available.has(m.name)))
        .slice(0, 3)
        .map(m => m.name);
      return {
        tier: 3,
        model,
        reason: `Task involves complex reasoning or high-stakes analysis (matched: ${pattern.source.slice(0, 40)})`,
        alternatives: alts,
      };
    }
  }

  // Check Tier 1 (lightweight)
  for (const pattern of TIER1_PATTERNS) {
    if (pattern.test(prompt)) {
      const model = selectModel(1, hasChinese ? 'doubao-seed-2.0-mini' : 'claude-haiku-4-5-20251001');
      const alts = TEXT_MODELS
        .filter(m => m.tier === 1 && m.name !== model && (!available || available.has(m.name)))
        .slice(0, 3)
        .map(m => m.name);
      return {
        tier: 1,
        model,
        reason: `Task is a straightforward Q&A or simple operation (matched: ${pattern.source.slice(0, 40)})`,
        alternatives: alts,
      };
    }
  }

  // Default: Tier 2
  const model = selectModel(2, hasChinese ? 'claude-sonnet-4-6' : 'claude-sonnet-4-6');
  const alts = TEXT_MODELS
    .filter(m => m.tier === 2 && m.name !== model && (!available || available.has(m.name)))
    .slice(0, 3)
    .map(m => m.name);
  return {
    tier: 2,
    model,
    reason: 'Task appears to need balanced capability — content creation, coding, or analysis',
    alternatives: alts,
  };
}

export function registerSmartRoute(server: McpServer): void {
  const schema = {
    prompt: z.string().max(100000)
      .describe('The task description or prompt to analyze for routing'),
  };

  server.tool(
    'smart_route',
    'Analyze a task and recommend the best model + tier (does NOT execute the task). Use this to preview routing before calling delegate.',
    schema,
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async (params) => {
      let available: Set<string> | undefined;
      let catalogLabel = 'bundled policy fallback';
      let warning: string | undefined;
      try {
        const catalog = await getTextCatalog();
        available = new Set(catalog.data.models.filter(model => model.lifecycle !== 'retired').map(model => model.model_id));
        catalogLabel = `${catalog.data.meta.catalog_version} (${catalog.source})`;
        warning = catalog.warning;
      } catch {
        warning = 'Canonical Catalog is unavailable; recommendations may be stale.';
      }
      const result = analyzeTask(params.prompt, available);

      const modelInfo = TEXT_MODELS.find(m => m.name === result.model);
      const lines = [
        `Recommended tier: Tier ${result.tier} (${result.tier === 1 ? '$' : result.tier === 2 ? '$$' : '$$$'})`,
        `Recommended model: ${result.model}`,
        `Provider: ${modelInfo?.provider ?? 'Unknown'}`,
        `Reason: ${result.reason}`,
        `Catalog: ${catalogLabel}`,
        '',
        `Alternatives: ${result.alternatives.join(', ') || 'none'}`,
        '',
        'To execute, use: delegate(prompt=..., model="' + result.model + '")',
        'Or use: cascade(prompt=...) for automatic quality assurance.',
      ];
      if (warning) lines.push(`Warning: ${warning}`);

      return {
        content: [{ type: 'text' as const, text: lines.join('\n') }],
      };
    },
  );
}
