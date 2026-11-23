import {describe, expect, it} from 'vitest';
import type {Identity} from '@/api/types';
import {makeError} from '@/test/factories';
import {identityReducer, initialIdentity, type IdentityState} from './identity';

const identity: Identity = {user_id: 'u', email: 'a@example.com', group_id: 'g', csrf_token: 'csrf', expires_at: '2026-11-15T00:00:00Z'};
const signedOut: IdentityState = {status: 'signed_out', email: '', error: null};
const submitting: IdentityState = {status: 'submitting', email: 'a@example.com', restoring: false};
const signedIn: IdentityState = {status: 'signed_in', identity};

// The signed-in identity.
describe('identity', () => {
  it('starts by checking the existing login', () => {
    expect(initialIdentity.status).toBe('submitting');
  });

  it('signed out + submit -> submitting', () => {
    expect(identityReducer(signedOut, {type: 'submit', email: 'a@example.com'})).toEqual(submitting);
  });

  it('submitting + valid identity -> signed in', () => {
    expect(identityReducer(submitting, {type: 'succeeded', identity})).toEqual(signedIn);
  });

  it('submitting + response that is not a valid identity -> signed out with an error', () => {
    const next = identityReducer(submitting, {type: 'succeeded', identity: {...identity, csrf_token: ''}});
    expect(next.status).toBe('signed_out');
  });

  it('submitting + field or password error -> signed out, form and error kept', () => {
    const error = makeError({code: 'unauthenticated', message: 'Wrong email or password.'});
    expect(identityReducer(submitting, {type: 'failed', error})).toEqual({status: 'signed_out', email: 'a@example.com', error});
  });

  it('submitting + network timeout -> signed out, retryable form kept', () => {
    const error = makeError({code: 'network_error', message: 'No response.', retryable: true});
    const next = identityReducer(submitting, {type: 'failed', error});
    expect(next).toEqual({status: 'signed_out', email: 'a@example.com', error});
  });

  it('checking the login + no session -> signed out without an error', () => {
    expect(identityReducer(initialIdentity, {type: 'restore_failed'})).toEqual(signedOut);
  });

  it('signed in + 401 or sign out -> signed out', () => {
    expect(identityReducer(signedIn, {type: 'signed_out'})).toEqual(signedOut);
  });

  it('ignores a late success after signing out', () => {
    expect(identityReducer(signedOut, {type: 'succeeded', identity})).toEqual(signedOut);
  });
});
