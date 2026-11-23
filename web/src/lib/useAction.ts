import {useCallback, useRef, useState} from 'react';
import type {ApiError} from '@/api/errors';

/** Runs a write call. `pending` drives the button's disabled state; a second run while pending is ignored. */
export function useAction<A extends unknown[]>(action: (...args: A) => Promise<unknown>) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const running = useRef(false);

  const run = useCallback(
    async (...args: A) => {
      if (running.current) return;
      running.current = true;
      setPending(true);
      setError(null);
      try {
        await action(...args);
      } catch (e) {
        setError(e as ApiError);
      } finally {
        running.current = false;
        setPending(false);
      }
    },
    [action],
  );

  return {run, pending, error};
}
