import type { ApiFormat } from '../data/text-models.js';

// --- Unified interface ---

export interface ChatRequest {
  model: string;
  prompt: string;
  systemPrompt?: string;
  maxTokens?: number;
}

export interface ChatResponse {
  content: string;
  model: string;
  requestId?: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
  };
}

// --- Adapter types ---

interface AdapterResult {
  path: string;
  body: Record<string, unknown>;
}

type ResponseParser = (data: unknown) => ChatResponse;

export interface ApiAdapter {
  buildRequest(req: ChatRequest): AdapterResult;
  parseResponse: ResponseParser;
}

// --- Anthropic adapter (/v1/messages) ---

interface AnthropicResponse {
  content: { type: string; text: string }[];
  model: string;
  usage?: { input_tokens: number; output_tokens: number };
}

const anthropicAdapter: ApiAdapter = {
  buildRequest(req: ChatRequest): AdapterResult {
    const body: Record<string, unknown> = {
      model: req.model,
      max_tokens: req.maxTokens ?? 4096,
      messages: [{ role: 'user', content: req.prompt }],
    };
    if (req.systemPrompt) {
      body.system = req.systemPrompt;
    }
    return { path: '/v1/messages', body };
  },
  parseResponse(data: unknown): ChatResponse {
    const res = data as AnthropicResponse;
    const text = res.content?.find(c => c.type === 'text')?.text ?? '';
    return {
      content: text,
      model: res.model ?? '',
      usage: res.usage ? {
        inputTokens: res.usage.input_tokens,
        outputTokens: res.usage.output_tokens,
      } : undefined,
    };
  },
};

// --- OpenAI adapter (/v1/chat/completions) ---

interface OpenAIResponse {
  choices: { message: { content: string } }[];
  model: string;
  usage?: { prompt_tokens: number; completion_tokens: number };
}

const openaiAdapter: ApiAdapter = {
  buildRequest(req: ChatRequest): AdapterResult {
    const messages: { role: string; content: string }[] = [];
    if (req.systemPrompt) {
      messages.push({ role: 'system', content: req.systemPrompt });
    }
    messages.push({ role: 'user', content: req.prompt });

    const body: Record<string, unknown> = {
      model: req.model,
      messages,
    };
    if (req.maxTokens) {
      body.max_tokens = req.maxTokens;
    }
    return { path: '/v1/chat/completions', body };
  },
  parseResponse(data: unknown): ChatResponse {
    const res = data as OpenAIResponse;
    const text = res.choices?.[0]?.message?.content ?? '';
    return {
      content: text,
      model: res.model ?? '',
      usage: res.usage ? {
        inputTokens: res.usage.prompt_tokens,
        outputTokens: res.usage.completion_tokens,
      } : undefined,
    };
  },
};

// --- Gemini adapter (/v1beta/models/{model}:generateContent) ---

interface GeminiResponse {
  candidates: { content: { parts: { text: string }[] } }[];
  modelVersion?: string;
  usageMetadata?: { promptTokenCount: number; candidatesTokenCount: number };
}

const geminiAdapter: ApiAdapter = {
  buildRequest(req: ChatRequest): AdapterResult {
    const body: Record<string, unknown> = {
      contents: [{ parts: [{ text: req.prompt }] }],
    };
    if (req.systemPrompt) {
      body.systemInstruction = { parts: [{ text: req.systemPrompt }] };
    }
    if (req.maxTokens) {
      body.generationConfig = { maxOutputTokens: req.maxTokens };
    }
    return {
      path: `/v1beta/models/${req.model}:generateContent`,
      body,
    };
  },
  parseResponse(data: unknown): ChatResponse {
    const res = data as GeminiResponse;
    const text = res.candidates?.[0]?.content?.parts
      ?.map(p => p.text)
      .join('') ?? '';
    return {
      content: text,
      model: res.modelVersion ?? '',
      usage: res.usageMetadata ? {
        inputTokens: res.usageMetadata.promptTokenCount,
        outputTokens: res.usageMetadata.candidatesTokenCount,
      } : undefined,
    };
  },
};

// --- Adapter registry ---

const ADAPTERS: Record<ApiFormat, ApiAdapter> = {
  anthropic: anthropicAdapter,
  openai: openaiAdapter,
  gemini: geminiAdapter,
};

export function getAdapter(format: ApiFormat): ApiAdapter {
  return ADAPTERS[format];
}
