import type {ApiErrorBody, DeviceSummary} from './types';

/** A rejected or failed REST call. `status` is 0 when no HTTP response was received. */
export class ApiError extends Error {
  readonly status: number;
  readonly body: ApiErrorBody;

  constructor(status: number, body: ApiErrorBody) {
    super(body.message);
    this.status = status;
    this.body = body;
  }

  /** No response arrived, so the operation may or may not have taken effect. */
  get outcomeUnknown(): boolean {
    return this.status === 0;
  }

  get code(): string {
    return this.body.code;
  }
}

/** The one place that turns an error into display text: its phase, device and reason. */
export function describeError(error: ApiErrorBody, devices: DeviceSummary[]): string {
  const device = error.device_id ? devices.find((d) => d.id === error.device_id)?.name ?? error.device_id : null;
  return [error.phase, device, error.message].filter(Boolean).join(' · ');
}

export function networkError(message: string): ApiError {
  return new ApiError(0, {
    code: 'network_error',
    message,
    field: null,
    device_id: null,
    phase: null,
    retryable: true,
  });
}
