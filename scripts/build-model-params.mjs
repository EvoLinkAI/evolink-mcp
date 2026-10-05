#!/usr/bin/env node
// Converts the docs site's OpenAPI files (mintlify-docs, en/api-manual/**.json)
// into one parameter index per model, written to
// packages/core/src/data/model-params.generated.ts.
//
// Usage: node scripts/build-model-params.mjs <path-to-mintlify-docs> [commit]
// The commit (for example `git -C ../mintlify-docs rev-parse --short HEAD`) is
// recorded so get_model can say which docs version the parameters come from.

import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const KIND_BY_PATH = {
  '/v1/images/generations': 'image',
  '/v1/videos/generations': 'video',
  '/v1/audios/generations': 'audio',
};
/** Never offered to assistants: callbacks are unsigned and would send results to an arbitrary URL. */
const HIDDEN_PARAMS = new Set(['model', 'callback_url']);
const DOCS_SITE = 'https://evolink.ai/docs';
const MAX_DESCRIPTION = 600;

const docsRoot = process.argv[2];
const commit = process.argv[3] ?? '';
if (!docsRoot) {
  console.error('usage: node scripts/build-model-params.mjs <path-to-mintlify-docs> [commit]');
  process.exit(2);
}
const manualRoot = join(docsRoot, 'en', 'api-manual');
const output = fileURLToPath(new URL('../packages/core/src/data/model-params.generated.ts', import.meta.url));

function walk(dir) {
  const files = [];
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) files.push(...walk(path));
    else if (name.endsWith('.json')) files.push(path);
  }
  return files;
}

function resolveRef(doc, value, seen = new Set()) {
  if (!value || typeof value !== 'object') return value;
  if (typeof value.$ref === 'string') {
    if (seen.has(value.$ref)) return {};
    seen.add(value.$ref);
    const target = value.$ref.replace(/^#\//, '').split('/').reduce((node, key) => node?.[key], doc);
    return resolveRef(doc, target ?? {}, seen);
  }
  if (Array.isArray(value.allOf)) {
    const merged = { type: 'object', properties: {}, required: [] };
    for (const part of value.allOf.map(item => resolveRef(doc, item, new Set(seen)))) {
      Object.assign(merged.properties, part.properties ?? {});
      merged.required.push(...(part.required ?? []));
      for (const [key, val] of Object.entries(part)) {
        if (!['properties', 'required', 'type'].includes(key)) merged[key] = val;
      }
    }
    return merged;
  }
  return value;
}

function cleanDescription(text) {
  if (typeof text !== 'string') return undefined;
  const cleaned = text
    .replace(/\*\*/g, '')
    .replace(/`/g, '')
    .replace(/\r/g, '')
    .replace(/\n\s*[-*]\s+/g, '; ')
    .replace(/\s*\n+\s*/g, ' ')
    .replace(/;\s*;/g, ';')
    .replace(/:\s*;/g, ':')
    .replace(/\s{2,}/g, ' ')
    .trim();
  if (!cleaned) return undefined;
  return cleaned.length > MAX_DESCRIPTION ? `${cleaned.slice(0, MAX_DESCRIPTION - 1).trimEnd()}…` : cleaned;
}

function typeOf(doc, schema) {
  if (schema.type) return Array.isArray(schema.type) ? schema.type.filter(t => t !== 'null').join('|') : schema.type;
  const options = schema.oneOf ?? schema.anyOf;
  if (Array.isArray(options)) {
    const types = [...new Set(options.map(option => typeOf(doc, resolveRef(doc, option))).filter(Boolean))];
    return types.join('|') || undefined;
  }
  if (schema.properties) return 'object';
  if (schema.enum) return typeof schema.enum[0];
  return undefined;
}

function simplify(doc, raw, required) {
  const schema = resolveRef(doc, raw) ?? {};
  const spec = {};
  const type = typeOf(doc, schema);
  if (type) spec.type = type;
  const description = cleanDescription(schema.description);
  if (description) spec.description = description;
  for (const key of ['enum', 'default', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'minLength', 'maxLength', 'minItems', 'maxItems', 'format']) {
    if (schema[key] !== undefined) spec[key] = schema[key];
  }
  const options = schema.oneOf ?? schema.anyOf;
  if (!spec.enum && Array.isArray(options)) {
    const resolved = options.map(option => resolveRef(doc, option));
    if (resolved.length > 0 && resolved.every(option => Array.isArray(option.enum))) {
      // Every alternative is a fixed list, so the union is the full set of choices.
      spec.enum = [...new Set(resolved.flatMap(option => option.enum))];
    } else {
      // Mixed alternatives (e.g. a number range or "auto"): keep the numeric bounds, leave the strings open.
      for (const option of resolved) {
        for (const key of ['minimum', 'maximum']) {
          if (option[key] !== undefined && spec[key] === undefined) spec[key] = option[key];
        }
      }
    }
  }
  if (schema.items) {
    const items = resolveRef(doc, schema.items);
    const itemSpec = {};
    const itemType = typeOf(doc, items);
    if (itemType) itemSpec.type = itemType;
    if (items.enum) itemSpec.enum = items.enum;
    if (items.format) itemSpec.format = items.format;
    if (items.properties) {
      itemSpec.properties = {};
      const itemRequired = new Set(items.required ?? []);
      for (const [name, prop] of Object.entries(items.properties)) {
        itemSpec.properties[name] = simplify(doc, prop, itemRequired.has(name));
      }
    }
    spec.items = itemSpec;
  }
  if (schema.properties) {
    spec.properties = {};
    const nestedRequired = new Set(schema.required ?? []);
    for (const [name, prop] of Object.entries(schema.properties)) {
      spec.properties[name] = simplify(doc, prop, nestedRequired.has(name));
    }
  }
  if (required) spec.required = true;
  return spec;
}

function modelsFor(doc, modelProp, examples) {
  const schema = resolveRef(doc, modelProp ?? {});
  const models = new Set();
  for (const value of schema.enum ?? []) if (typeof value === 'string') models.add(value);
  if (models.size === 0) {
    if (typeof schema.default === 'string') models.add(schema.default);
    if (typeof schema.example === 'string') models.add(schema.example);
    for (const example of Object.values(examples ?? {})) {
      const model = example?.value?.model;
      if (typeof model === 'string') models.add(model);
    }
  }
  return [...models];
}

function firstExample(examples, schemaExample) {
  const value = Object.values(examples ?? {})[0]?.value ?? schemaExample;
  if (!value || typeof value !== 'object') return undefined;
  const copy = { ...value };
  for (const key of HIDDEN_PARAMS) delete copy[key];
  return copy;
}

const files = walk(manualRoot);
const entries = {};
/** How many models the page that won each entry documents; a page for one model beats an overview page. */
const breadth = {};
const duplicates = [];
let endpoints = 0;
for (const file of files) {
  const doc = JSON.parse(readFileSync(file, 'utf8'));
  const page = relative(docsRoot, file).split(sep).join('/').replace(/\.json$/, '');
  for (const [path, operations] of Object.entries(doc.paths ?? {})) {
    const kind = KIND_BY_PATH[path];
    const operation = operations?.post;
    if (!kind || !operation) continue;
    const content = operation.requestBody?.content?.['application/json'];
    const schema = resolveRef(doc, content?.schema);
    if (!schema?.properties) continue;
    endpoints += 1;
    const required = (schema.required ?? []).filter(name => !HIDDEN_PARAMS.has(name));
    const params = {};
    for (const [name, prop] of Object.entries(schema.properties)) {
      if (HIDDEN_PARAMS.has(name)) continue;
      params[name] = simplify(doc, prop, required.includes(name));
    }
    const entry = {
      kind,
      path,
      title: cleanDescription(operation.summary) ?? page.split('/').pop(),
      docs: `${DOCS_SITE}/${page}`,
      required,
      params,
    };
    const example = firstExample(content.examples, content.example ?? schema.example);
    if (example && Object.keys(example).length > 0) entry.example = example;
    const models = modelsFor(doc, schema.properties.model, content.examples);
    for (const model of models) {
      if (entries[model]) {
        const keepExisting = breadth[model] <= models.length;
        duplicates.push(`${model}: kept ${keepExisting ? entries[model].docs : entry.docs}, skipped ${keepExisting ? entry.docs : entries[model].docs}`);
        if (keepExisting) continue;
      }
      entries[model] = { model, ...entry };
      breadth[model] = models.length;
    }
  }
}

const sorted = Object.fromEntries(Object.keys(entries).sort().map(key => [key, entries[key]]));
const meta = { source: 'mintlify-docs en/api-manual', commit, files: files.length, endpoints, models: Object.keys(sorted).length };
const json = JSON.stringify({ meta, models: sorted });
const banner = '// Generated by scripts/build-model-params.mjs from the docs site OpenAPI files. Do not edit by hand.\n';
writeFileSync(output, `${banner}export const MODEL_PARAMS_JSON: string = ${JSON.stringify(json)};\n`);
console.error(`model params: ${meta.models} models from ${endpoints} endpoints in ${files.length} files → ${relative(process.cwd(), output)} (${json.length} bytes)`);
if (duplicates.length > 0) console.error(`skipped ${duplicates.length} duplicate model entries:\n  ${duplicates.join('\n  ')}`);
