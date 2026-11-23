// The signed-in identity.
import type {ApiErrorBody, Identity} from '@/api/types';

export type IdentityState =
  | {status: 'signed_out'; email: string; error: ApiErrorBody | null}
  | {status: 'submitting'; email: string; restoring: boolean}
  | {status: 'signed_in'; identity: Identity};

export type IdentityEvent =
  | {type: 'submit'; email: string}
  | {type: 'succeeded'; identity: Identity}
  | {type: 'failed'; error: ApiErrorBody}
  | {type: 'restore_failed'}
  | {type: 'signed_out'};

/** On load the page asks the server whether the login cookie is still good. */
export const initialIdentity: IdentityState = {status: 'submitting', email: '', restoring: true};

const signedOut: IdentityState = {status: 'signed_out', email: '', error: null};

function isValidIdentity(identity: Identity): boolean {
  return Boolean(identity.user_id && identity.group_id && identity.email && identity.csrf_token);
}

export function identityReducer(state: IdentityState, event: IdentityEvent): IdentityState {
  switch (event.type) {
    case 'submit':
      return state.status === 'signed_out'
        ? {status: 'submitting', email: event.email, restoring: false}
        : state;
    case 'succeeded':
      if (state.status !== 'submitting') return state;
      if (!isValidIdentity(event.identity)) {
        return {
          status: 'signed_out',
          email: state.email,
          error: {code: 'invalid_response', message: 'The server sent an invalid login response.',
                  field: null, device_id: null, phase: null, retryable: true},
        };
      }
      return {status: 'signed_in', identity: event.identity};
    case 'failed':
      return state.status === 'submitting' ? {status: 'signed_out', email: state.email, error: event.error} : state;
    case 'restore_failed':
    case 'signed_out':
      return signedOut;
  }
}
