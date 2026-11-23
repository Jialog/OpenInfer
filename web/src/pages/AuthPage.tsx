import {type FormEvent, useState} from 'react';
import type {ApiErrorBody} from '@/api/types';
import {Alert, AlertDescription} from '@/components/ui/alert';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {Label} from '@/components/ui/label';

type Props = {
  submitting: boolean;
  initialEmail: string;
  error: ApiErrorBody | null;
  /** The control plane said it refuses new accounts: the registration form is not shown. */
  registrationClosed: boolean;
  onSubmit: (mode: 'login' | 'register', email: string, password: string) => void;
};

const REGISTRATION_CLOSED =
  'Registration is closed on this control plane. To get an account, ask the administrator of this control plane (the person who installed it).';

export function AuthPage({submitting, initialEmail, error, registrationClosed, onSubmit}: Props) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  // An error belongs to the form that was submitted; switching forms hides it.
  const [submittedMode, setSubmittedMode] = useState(mode);
  const [email, setEmail] = useState(initialEmail);
  const [password, setPassword] = useState('');
  const registering = mode === 'register';

  function submit(event: FormEvent) {
    event.preventDefault();
    setSubmittedMode(mode);
    onSubmit(mode, email, password);
  }

  const idleLabel = registering ? 'Create account' : 'Sign in';
  const busyLabel = registering ? 'Creating account' : 'Signing in';

  return (
    <main className="mx-auto flex min-h-svh w-full max-w-[26rem] flex-col justify-center gap-6 px-4 py-12">
      <p className="text-center text-[15px] font-semibold tracking-tight">OpenInfer</p>
      <section className="flex flex-col gap-5 rounded-xl border bg-card p-6 shadow-[0_1px_2px_rgb(0_0_0/0.04)]">
        <div className="flex flex-col gap-1.5">
          <h1 className="text-xl font-semibold tracking-tight">{registering ? 'Create your OpenInfer account' : 'Sign in to OpenInfer'}</h1>
          {!(registering && registrationClosed) && (
            <p className="text-sm text-muted-foreground">
              {registering
                ? 'The account and its devices stay on this control plane.'
                : 'Use the account you created on this control plane.'}
            </p>
          )}
        </div>
        {registering && registrationClosed ? (
          <p data-testid="registration-closed" className="text-sm">{REGISTRATION_CLOSED}</p>
        ) : (
          <form className="flex flex-col gap-4" onSubmit={submit}>
            <div className="flex flex-col gap-2">
              <Label htmlFor="email">Email</Label>
              <Input id="email" type="email" autoComplete="username" required value={email}
                     onChange={(e) => setEmail(e.target.value)} />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="password">Password</Label>
              <Input id="password" type="password" required value={password}
                     autoComplete={registering ? 'new-password' : 'current-password'}
                     onChange={(e) => setPassword(e.target.value)} />
              {registering && <p className="text-[13px] text-muted-foreground">Use 12 to 128 characters.</p>}
            </div>
            {error && submittedMode === mode && (
              <Alert variant="destructive">
                <AlertDescription>{error.code === 'registration_closed' ? REGISTRATION_CLOSED : error.message}</AlertDescription>
              </Alert>
            )}
            <Button type="submit" size="lg" className="w-full" disabled={submitting}>{submitting ? busyLabel : idleLabel}</Button>
          </form>
        )}
        <div className="flex flex-wrap items-center justify-center gap-1 border-t pt-4 text-sm text-muted-foreground">
          <span>{registering ? 'Already registered?' : 'New here?'}</span>
          <Button type="button" variant="link" className="h-auto" onClick={() => setMode(registering ? 'login' : 'register')}>
            {registering ? 'I already have an account' : 'Create an account'}
          </Button>
        </div>
      </section>
    </main>
  );
}
