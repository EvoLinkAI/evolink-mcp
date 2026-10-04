export interface RouterApiError {
  error: {
    code: number;
    message: string;
    type: string;
  };
}

const HTTP_ERROR_MESSAGES: Record<number, string> = {
  400: 'Invalid request parameters',
  401: 'Invalid or expired API Key. Check EVOLINK_API_KEY',
  402: 'Insufficient balance. Top up at https://evolink.ai/dashboard/credits',
  403: 'Access denied',
  404: 'Model not found or endpoint unavailable',
  429: 'Rate limit exceeded. Please retry after 30s',
  500: 'Internal server error',
  502: 'Upstream model service unavailable',
  503: 'Service temporarily unavailable. Please retry later',
};

export function formatApiError(status: number, body: unknown): string {
  const apiError = body as RouterApiError;
  if (apiError?.error?.message) {
    return `[${status}] ${apiError.error.message}`;
  }
  return `[${status}] ${HTTP_ERROR_MESSAGES[status] ?? 'Unknown error'}`;
}
