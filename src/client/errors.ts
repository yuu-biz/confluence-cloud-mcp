export class ConfluenceApiError extends Error {
  readonly status: number;
  readonly requestId?: string;
  readonly retryAfterMs?: number;

  constructor(message: string, status: number, requestId?: string, retryAfterMs?: number) {
    super(message);
    this.name = 'ConfluenceApiError';
    this.status = status;
    if (requestId !== undefined) this.requestId = requestId;
    if (retryAfterMs !== undefined) this.retryAfterMs = retryAfterMs;
  }
}

export function publicErrorMessage(error: unknown): string {
  if (error instanceof ConfluenceApiError) {
    const suffix = error.requestId ? ` (request id: ${error.requestId})` : '';
    return `Confluence API error ${error.status}: ${error.message}${suffix}`;
  }
  if (error instanceof Error) return error.message;
  return 'Unknown error';
}
