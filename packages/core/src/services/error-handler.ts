// --- HTTP-level error handling (non-2xx responses) ---

export interface EvolinkApiError {
  error: {
    code: number;
    message: string;
    type: string;
    param?: string;
    fallback_suggestion?: string;
  };
}

const HTTP_ERROR_MESSAGES: Record<number, string> = {
  400: 'Invalid request parameters',
  401: 'Invalid or expired API Key. Check EVOLINK_API_KEY',
  402: 'Insufficient balance. Top up at https://evolink.ai/dashboard/credits',
  403: 'Access denied',
  404: 'Resource not found',
  413: 'Request too large. Compress images to under 4MB',
  429: 'Rate limit exceeded. Please retry later',
  500: 'Evolink internal server error',
  502: 'Upstream service unavailable',
  503: 'Service temporarily unavailable. Please retry later',
};

const BUSINESS_ERROR_MESSAGES: Record<string, string> = {
  content_policy_violation: 'Prompt triggered content safety review. Please revise your description and retry.',
  model_unavailable: 'This model is currently unavailable. Use list_models to see available models.',
  insufficient_quota: 'Insufficient account balance. Top up at https://evolink.ai/dashboard/credits',
};

export function formatApiError(status: number, body: unknown): string {
  const apiError = body as EvolinkApiError;
  if (apiError?.error?.message) {
    const businessHint = BUSINESS_ERROR_MESSAGES[apiError.error.type] ?? '';
    const suggestion = apiError.error.fallback_suggestion
      ? `\nSuggestion: ${apiError.error.fallback_suggestion}`
      : '';
    const hint = businessHint ? `\nHint: ${businessHint}` : '';
    return `[${status}] ${apiError.error.message}${suggestion}${hint}`;
  }
  return `[${status}] ${HTTP_ERROR_MESSAGES[status] ?? 'Unknown error'}`;
}

// --- Task-level error handling (status: "failed" in check_task) ---

export type TaskErrorCode =
  | 'content_policy_violation'
  | 'invalid_parameters'
  | 'image_dimension_mismatch'
  | 'image_processing_error'
  | 'request_cancelled'
  | 'resource_not_found'
  | 'generation_timeout'
  | 'quota_exceeded'
  | 'resource_exhausted'
  | 'generation_failed_no_content'
  | 'service_error'
  | 'service_unavailable'
  | 'unknown_error';

export interface TaskErrorInfo {
  suggestion: string;
  retryable: boolean;
}

const TASK_ERROR_MAP: Record<TaskErrorCode, TaskErrorInfo> = {
  content_policy_violation: {
    suggestion: 'Revise your prompt — avoid real person photos, celebrity names, copyrighted content, NSFW, or violence. Try illustration style instead.',
    retryable: false,
  },
  invalid_parameters: {
    suggestion: 'Check parameter values — prompt length, image dimensions, duration, and resolution must be within the model\'s supported range.',
    retryable: false,
  },
  image_dimension_mismatch: {
    suggestion: 'Input image dimensions don\'t match the requested aspect ratio. Resize your image to match (e.g., 1280x720 for 16:9).',
    retryable: false,
  },
  image_processing_error: {
    suggestion: 'Failed to process the input image. Check: format (JPG/PNG/WebP), size (<10MB), and that the URL is publicly accessible.',
    retryable: false,
  },
  request_cancelled: {
    suggestion: 'This task was cancelled. If unintentional, submit a new request.',
    retryable: false,
  },
  resource_not_found: {
    suggestion: 'Task ID not found or expired. Verify the task ID is correct.',
    retryable: false,
  },
  generation_timeout: {
    suggestion: 'Generation timed out — the system may be under high load. Retry, or try simplifying your prompt/lowering resolution.',
    retryable: true,
  },
  quota_exceeded: {
    suggestion: 'Account quota exceeded or rate limited. Wait a moment, then retry. Top up at https://evolink.ai/dashboard/credits',
    retryable: true,
  },
  resource_exhausted: {
    suggestion: 'Server resources temporarily exhausted. Wait 30-60 seconds and retry.',
    retryable: true,
  },
  generation_failed_no_content: {
    suggestion: 'Model produced no output — the prompt or image may involve watermark removal or protected content. Modify and retry.',
    retryable: true,
  },
  service_error: {
    suggestion: 'Internal service error (temporary). Retry after 1 minute.',
    retryable: true,
  },
  service_unavailable: {
    suggestion: 'Service temporarily unavailable. Retry after 1-2 minutes.',
    retryable: true,
  },
  unknown_error: {
    suggestion: 'An unknown error occurred. Retry after 1 minute. If it persists, provide the task ID to support.',
    retryable: true,
  },
};

export function getTaskErrorInfo(code: string): TaskErrorInfo {
  return TASK_ERROR_MAP[code as TaskErrorCode] ?? TASK_ERROR_MAP.unknown_error;
}

export function formatTaskError(error: { code?: string; message?: string }): string {
  const code = error.code ?? 'unknown_error';
  const info = getTaskErrorInfo(code);
  const lines: string[] = [
    `Error code: ${code}`,
    `Message: ${error.message ?? 'No details provided'}`,
    `Retryable: ${info.retryable ? 'Yes — you can retry this request' : 'No — modify your input before retrying'}`,
    `Suggestion: ${info.suggestion}`,
  ];
  return lines.join('\n');
}
