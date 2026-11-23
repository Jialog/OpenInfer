import {useCallback, useEffect, useRef, useState} from 'react';
import type {ApiError} from '@/api/errors';
import type {Chunk, RequestSummary} from '@/api/types';
import {isTerminalRequest} from '@/state/output';
import {useStore} from './Workspace';

/** Reads chunks the socket did not deliver: after a reconnect, or when a gap or a finished request shows some are missing. */
export function useBackfill(requestId: string | null, request: RequestSummary | undefined, snapshotCount: number) {
  const {client, dispatchLive, live} = useStore();
  const liveRef = useRef(live);
  liveRef.current = live;
  const inFlight = useRef(false);
  /** Something changed while a read was running; the running read may have missed it. */
  const rerun = useRef(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [attempt, setAttempt] = useState(0);

  const output = requestId ? live.outputs[requestId] : undefined;
  const contiguous = output?.contiguous ?? 0;
  const held = Number(request?.contiguous_seq ?? 0);
  const hasGap = output ? Object.keys(output.pending).length > 0 : false;
  const finishedShort = request ? isTerminalRequest(request.state) && contiguous < held : false;
  const behindWatermark = requestId ? Number(live.watermarks[requestId] ?? 0) > contiguous : false;

  useEffect(() => {
    if (!requestId) return;
    if (!hasGap && !finishedShort && !behindWatermark) return;
    if (inFlight.current) {
      rerun.current = true;
      return;
    }
    inFlight.current = true;
    setError(null);
    (async () => {
      type Page = {chunks: Chunk[]; next: string | null};
      let after = String(liveRef.current.outputs[requestId]?.contiguous ?? 0);
      for (;;) {
        const page = await client.get<Page>(`/requests/${requestId}/chunks?after=${after}&limit=1000`);
        dispatchLive({type: 'chunks_loaded', requestId, chunks: page.chunks});
        if (page.next === null) return;
        after = page.next;
      }
    })()
      .catch((e) => setError(e as ApiError))
      .finally(() => {
        inFlight.current = false;
        if (rerun.current) {
          rerun.current = false;
          setAttempt((n) => n + 1);
        }
      });
  }, [client, dispatchLive, requestId, hasGap, finishedShort, behindWatermark, snapshotCount, attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return {error, retry};
}
