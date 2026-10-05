import { MODEL_PARAMS_JSON } from './model-params.generated.js';

export type MediaKind = 'image' | 'video' | 'audio';

/** One request parameter as documented in the docs site OpenAPI (simplified). */
export interface ParamSpec {
  type?: string;
  description?: string;
  enum?: Array<string | number | boolean>;
  default?: unknown;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  format?: string;
  items?: {
    type?: string;
    enum?: Array<string | number | boolean>;
    format?: string;
    properties?: Record<string, ParamSpec>;
  };
  properties?: Record<string, ParamSpec>;
  required?: boolean;
}

/** Everything get_model needs to explain one model's request. */
export interface ModelParams {
  model: string;
  kind: MediaKind;
  /** Gateway endpoint, e.g. /v1/images/generations */
  path: string;
  title: string;
  docs: string;
  required: string[];
  params: Record<string, ParamSpec>;
  example?: Record<string, unknown>;
}

export interface ModelParamsMeta {
  source: string;
  commit: string;
  files: number;
  endpoints: number;
  models: number;
}

interface ModelParamsIndex {
  meta: ModelParamsMeta;
  models: Record<string, ModelParams>;
}

let index: ModelParamsIndex | undefined;

function load(): ModelParamsIndex {
  index ??= JSON.parse(MODEL_PARAMS_JSON) as ModelParamsIndex;
  return index;
}

export function modelParamsMeta(): ModelParamsMeta {
  return load().meta;
}

export function allModelParams(): ModelParams[] {
  return Object.values(load().models);
}

/** Exact model ID first, then a case-insensitive match. */
export function findModelParams(model: string): ModelParams | undefined {
  const models = load().models;
  const trimmed = model.trim();
  if (models[trimmed]) return models[trimmed];
  const lower = trimmed.toLowerCase();
  return Object.values(models).find(entry => entry.model.toLowerCase() === lower);
}
