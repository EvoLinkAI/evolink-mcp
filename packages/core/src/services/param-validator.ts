import type { ModelParams, ParamSpec } from '../data/model-params.js';

export interface ValidationIssue {
  param: string;
  problem: string;
}

export interface ValidationResult {
  /** The request would be rejected; it is not submitted. */
  errors: ValidationIssue[];
  /** Worth telling the user, but the gateway has the final say (for example prompt length, which it counts in tokens). */
  warnings: ValidationIssue[];
}

/** Parameters an assistant may not set through MCP, with the reason shown to it. */
const BLOCKED_PARAMS: Record<string, string> = {
  callback_url: 'callbacks are not available through MCP; use get_task to wait for the result',
};

/** Levenshtein distance, capped for long strings. */
function distance(a: string, b: string): number {
  if (a === b) return 0;
  const rows = a.length + 1;
  const cols = b.length + 1;
  let previous = Array.from({ length: cols }, (_, j) => j);
  for (let i = 1; i < rows; i++) {
    const current = [i];
    for (let j = 1; j < cols; j++) {
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[cols - 1];
}

/** Up to `limit` candidates that look like `value`, best first. */
export function closestMatches(value: string, candidates: string[], limit = 3): string[] {
  const needle = value.toLowerCase();
  return candidates
    .map(candidate => {
      const lower = candidate.toLowerCase();
      const contains = lower.includes(needle) || needle.includes(lower);
      const score = distance(needle, lower) / Math.max(needle.length, lower.length, 1) - (contains ? 0.5 : 0);
      return { candidate, score };
    })
    .filter(item => item.score <= 0.45)
    .sort((a, b) => a.score - b.score || a.candidate.localeCompare(b.candidate))
    .slice(0, limit)
    .map(item => item.candidate);
}

function describeType(type: string): string {
  return type.split('|').map(part => (part === 'integer' ? 'a whole number' : part === 'array' ? 'a list' : `a ${part}`)).join(' or ');
}

function matchesType(type: string | undefined, value: unknown): boolean {
  if (!type) return true;
  return type.split('|').some(part => {
    switch (part) {
      case 'string': return typeof value === 'string';
      case 'integer': return typeof value === 'number' && Number.isInteger(value);
      case 'number': return typeof value === 'number' && Number.isFinite(value);
      case 'boolean': return typeof value === 'boolean';
      case 'array': return Array.isArray(value);
      case 'object': return !!value && typeof value === 'object' && !Array.isArray(value);
      case 'null': return value === null;
      default: return true;
    }
  });
}

function show(value: unknown): string {
  const json = JSON.stringify(value);
  return json && json.length > 60 ? `${json.slice(0, 57)}…` : json ?? String(value);
}

function checkValue(name: string, spec: ParamSpec, value: unknown, result: ValidationResult): void {
  if (value === undefined) return;
  if (!matchesType(spec.type, value)) {
    const numericString = typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Number(value));
    const hint = numericString && /integer|number/.test(spec.type ?? '') ? ` Use ${Number(value)} (a number), not "${value}".` : '';
    result.errors.push({ param: name, problem: `must be ${describeType(spec.type!)}, got ${show(value)}.${hint}` });
    return;
  }
  if (spec.enum && spec.enum.length > 0 && (typeof value !== 'object' || value === null)) {
    if (!spec.enum.some(option => option === value)) {
      const caseMatch = typeof value === 'string'
        ? spec.enum.find(option => typeof option === 'string' && option.toLowerCase() === value.toLowerCase())
        : undefined;
      result.errors.push({
        param: name,
        problem: caseMatch !== undefined
          ? `use ${show(caseMatch)} (values are case-sensitive), got ${show(value)}.`
          : `must be one of ${spec.enum.map(show).join(', ')}; got ${show(value)}.`,
      });
      return;
    }
  }
  if (typeof value === 'number') {
    if (spec.minimum !== undefined && value < spec.minimum) result.errors.push({ param: name, problem: `must be at least ${spec.minimum}, got ${value}.` });
    if (spec.maximum !== undefined && value > spec.maximum) result.errors.push({ param: name, problem: `must be at most ${spec.maximum}, got ${value}.` });
    if (spec.exclusiveMinimum !== undefined && value <= spec.exclusiveMinimum) result.errors.push({ param: name, problem: `must be greater than ${spec.exclusiveMinimum}, got ${value}.` });
    if (spec.exclusiveMaximum !== undefined && value >= spec.exclusiveMaximum) result.errors.push({ param: name, problem: `must be less than ${spec.exclusiveMaximum}, got ${value}.` });
  }
  if (typeof value === 'string') {
    if (spec.maxLength !== undefined && value.length > spec.maxLength) {
      result.warnings.push({ param: name, problem: `is ${value.length} characters; the documented limit is ${spec.maxLength}. The gateway may reject it.` });
    }
    if (spec.minLength !== undefined && value.length < spec.minLength) {
      result.errors.push({ param: name, problem: `must be at least ${spec.minLength} characters.` });
    }
  }
  if (Array.isArray(value)) {
    if (spec.maxItems !== undefined && value.length > spec.maxItems) result.errors.push({ param: name, problem: `allows at most ${spec.maxItems} items, got ${value.length}.` });
    if (spec.minItems !== undefined && value.length < spec.minItems) result.errors.push({ param: name, problem: `needs at least ${spec.minItems} items, got ${value.length}.` });
    const items = spec.items;
    if (items) {
      value.forEach((item, position) => {
        checkValue(`${name}[${position}]`, { type: items.type, enum: items.enum, properties: items.properties }, item, result);
      });
    }
  }
  if (spec.properties && value && typeof value === 'object' && !Array.isArray(value)) {
    checkObject(name, spec.properties, value as Record<string, unknown>, result);
  }
}

function checkObject(prefix: string, properties: Record<string, ParamSpec>, value: Record<string, unknown>, result: ValidationResult): void {
  const known = Object.keys(properties);
  for (const [key, nested] of Object.entries(value)) {
    const spec = properties[key];
    const path = prefix ? `${prefix}.${key}` : key;
    if (!spec) {
      const suggestions = closestMatches(key, known);
      result.errors.push({
        param: path,
        problem: `is not a parameter here.${suggestions.length ? ` Did you mean ${suggestions.map(s => `"${s}"`).join(' or ')}?` : ''} Allowed: ${known.join(', ') || 'none'}.`,
      });
      continue;
    }
    checkValue(path, spec, nested, result);
  }
  for (const [key, spec] of Object.entries(properties)) {
    if (spec.required && value[key] === undefined) {
      result.errors.push({ param: prefix ? `${prefix}.${key}` : key, problem: 'is required.' });
    }
  }
}

/**
 * Checks a generation input against the documented parameters before
 * anything is sent: unknown names, wrong types, values outside the documented
 * choices or ranges. The gateway still validates the request in full.
 */
export function validateInput(spec: ModelParams, input: Record<string, unknown>): ValidationResult {
  const result: ValidationResult = { errors: [], warnings: [] };
  const rest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (key === 'model') {
      if (value !== undefined && value !== spec.model) {
        result.errors.push({ param: 'model', problem: `set the model with the model argument, not inside input (input has ${show(value)}).` });
      }
      continue;
    }
    if (BLOCKED_PARAMS[key]) {
      result.errors.push({ param: key, problem: `${BLOCKED_PARAMS[key]}.` });
      continue;
    }
    rest[key] = value;
  }
  checkObject('', spec.params, rest, result);
  return result;
}

export function formatIssues(issues: ValidationIssue[]): string[] {
  return issues.map(issue => `- ${issue.param} ${issue.problem}`);
}
