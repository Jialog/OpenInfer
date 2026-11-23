// REST client for /api/v1 (docs/API.md).
import {ApiError, networkError} from './errors';
import type {ApiErrorBody} from './types';

const REQUEST_TIMEOUT_MS = 30_000;

type Hooks = {csrfToken: () => string | null; onUnauthorized: () => void};
type CallOptions = {idempotencyKey?: string; anonymous?: boolean; file?: boolean; blob?: boolean};

export class ApiClient {
  private readonly hooks: Hooks;

  constructor(hooks: Hooks) {
    this.hooks = hooks;
  }

  get<T>(path: string, options: CallOptions = {}): Promise<T> {
    return this.call<T>('GET', path, undefined, options);
  }

  post<T>(path: string, body: unknown, options: CallOptions = {}): Promise<T> {
    return this.call<T>('POST', path, body, options);
  }

  /** Sends FILE itself as the body, with its name in the query (POST /files). */
  upload<T>(path: string, file: File): Promise<T> {
    return this.call<T>('POST', `${path}?name=${encodeURIComponent(file.name)}`, file, {file: true});
  }

  /** Reads a file the server keeps (an uploaded file, a saved result) as its bytes; a refusal is an ApiError as for any call. */
  download(path: string): Promise<Blob> {
    return this.call<Blob>('GET', path, undefined, {blob: true});
  }

  private async call<T>(method: string, path: string, body: unknown, options: CallOptions): Promise<T> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['Content-Type'] = options.file ? (body as File).type || 'text/plain' : 'application/json';
    if (method !== 'GET') {
      const csrf = this.hooks.csrfToken();
      if (csrf) headers['X-CSRF-Token'] = csrf;
    }
    if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(`/api/v1${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : options.file ? (body as File) : JSON.stringify(body),
        credentials: 'same-origin',
        signal: controller.signal,
      });
    } catch {
      throw networkError('Could not reach the server. Check the connection and try again.');
    } finally {
      clearTimeout(timer);
    }

    if (response.status === 204) return undefined as T;
    if (response.ok && options.blob) return (await response.blob()) as T;
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    if (response.ok) return payload as T;

    if (response.status === 401 && !options.anonymous) this.hooks.onUnauthorized();
    const errorBody = (payload as {error?: ApiErrorBody} | null)?.error;
    throw new ApiError(response.status, errorBody ?? {
      code: 'bad_response', message: `The server answered ${response.status}.`, field: null,
      device_id: null, phase: null, retryable: false,
    });
  }
}
