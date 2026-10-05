import { allModelParams, findModelParams, type MediaKind, type ModelParams } from '../data/model-params.js';
import { closestMatches } from './param-validator.js';
import { getPricing, type PricedModel } from './pricing-client.js';

/** A model as the tools see it: documented parameters, published prices, or both. */
export interface CatalogEntry {
  id: string;
  kind: MediaKind;
  spec?: ModelParams;
  priced?: PricedModel;
}

export interface Catalog {
  entries: CatalogEntry[];
  /** Why prices are missing, when the pricing list could not be loaded. */
  pricingWarning?: string;
}

function isMediaKind(value: string): value is MediaKind {
  return value === 'image' || value === 'video' || value === 'audio';
}

/** Merges the bundled parameter index with the live price list; works without prices if the list is unreachable. */
export async function loadCatalog(): Promise<Catalog> {
  const entries = new Map<string, CatalogEntry>();
  for (const spec of allModelParams()) entries.set(spec.model, { id: spec.model, kind: spec.kind, spec });
  let pricingWarning: string | undefined;
  try {
    const pricing = await getPricing();
    if (pricing.source === 'stale-cache') pricingWarning = 'Prices could not be refreshed; showing the last known prices.';
    for (const priced of pricing.models.values()) {
      const existing = entries.get(priced.id);
      if (existing) existing.priced = priced;
      else if (isMediaKind(priced.kind)) entries.set(priced.id, { id: priced.id, kind: priced.kind, priced });
    }
  } catch (error) {
    pricingWarning = `Prices are unavailable right now (${error instanceof Error ? error.message : 'unknown error'}).`;
  }
  return { entries: [...entries.values()], pricingWarning };
}

export function findEntry(catalog: Catalog, id: string): CatalogEntry | undefined {
  const lower = id.trim().toLowerCase();
  return catalog.entries.find(entry => entry.id === id.trim()) ?? catalog.entries.find(entry => entry.id.toLowerCase() === lower);
}

export function suggestModels(catalog: Catalog, id: string, kind?: MediaKind): string[] {
  const pool = catalog.entries.filter(entry => !kind || entry.kind === kind).map(entry => entry.id);
  return closestMatches(id, pool, 5);
}

/** Looks a model up for one request; prices are best effort. */
export async function resolveModel(id: string): Promise<{ catalog: Catalog; entry?: CatalogEntry }> {
  const spec = findModelParams(id);
  const catalog = await loadCatalog();
  const entry = spec ? findEntry(catalog, spec.model) : findEntry(catalog, id);
  return { catalog, entry };
}
