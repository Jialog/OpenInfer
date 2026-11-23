import {useCallback, useEffect, useMemo, useReducer, useRef, useState} from 'react';
import {ApiClient} from '@/api/client';
import {ApiError} from '@/api/errors';
import type {Identity} from '@/api/types';
import {AuthPage} from '@/pages/AuthPage';
import {Workspace} from '@/pages/Workspace';
import {identityReducer, initialIdentity} from '@/state/identity';

export function App() {
  const [identity, dispatch] = useReducer(identityReducer, initialIdentity);
  const csrf = useRef<string | null>(null);
  csrf.current = identity.status === 'signed_in' ? identity.identity.csrf_token : null;

  const client = useMemo(
    () => new ApiClient({csrfToken: () => csrf.current, onUnauthorized: () => dispatch({type: 'signed_out'})}),
    [],
  );

  // Whether new accounts are allowed, so that a closed control plane shows no registration form. If it cannot be
  // read, the form is shown and a refusal is reported when it is sent.
  const [registration, setRegistration] = useState<'open' | 'closed' | null>(null);
  useEffect(() => {
    client
      .get<{registration: 'open' | 'closed'}>('/auth/registration', {anonymous: true})
      .then((r) => setRegistration(r.registration))
      .catch(() => setRegistration(null));
  }, [client]);

  useEffect(() => {
    client
      .get<Identity>('/auth/me', {anonymous: true})
      .then((me) => dispatch({type: 'succeeded', identity: me}))
      .catch(() => dispatch({type: 'restore_failed'}));
  }, [client]);

  const authenticate = useCallback(
    async (mode: 'login' | 'register', email: string, password: string) => {
      dispatch({type: 'submit', email});
      try {
        const me = await client.post<Identity>(`/auth/${mode}`, {email, password}, {anonymous: true});
        dispatch({type: 'succeeded', identity: me});
      } catch (e) {
        dispatch({type: 'failed', error: (e as ApiError).body});
      }
    },
    [client],
  );

  if (identity.status === 'signed_in') {
    return (
      <Workspace
        key={identity.identity.user_id}
        identity={identity.identity}
        client={client}
        onSignedOut={() => dispatch({type: 'signed_out'})}
      />
    );
  }
  if (identity.status === 'submitting' && identity.restoring) {
    return <p className="flex min-h-svh items-center justify-center text-sm text-muted-foreground">Loading…</p>;
  }
  return (
    <AuthPage
      submitting={identity.status === 'submitting'}
      initialEmail={identity.email}
      error={identity.status === 'signed_out' ? identity.error : null}
      registrationClosed={registration === 'closed'}
      onSubmit={authenticate}
    />
  );
}
