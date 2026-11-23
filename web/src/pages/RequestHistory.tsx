import {useEffect, useState} from 'react';
import {ChevronRight} from 'lucide-react';
import {describeError, type ApiError} from '@/api/errors';
import type {ID, Request, RequestSummary, SessionSummary} from '@/api/types';
import {Alert, AlertDescription} from '@/components/ui/alert';
import {Button} from '@/components/ui/button';
import {Card, CardContent, CardHeader, CardList} from '@/components/ui/card';
import {Pill} from '@/components/ui/pill';
import {formatLocalTime, formatRelative} from '@/lib/format';
import {cn} from '@/lib/utils';
import {emptyOutput} from '@/state/output';
import {OutputView, RequestFiles, SOURCE, STATE} from './RequestArea';
import {useBackfill} from './useBackfill';
import {useStore} from './Workspace';

const LIMIT = 20;

/** The session's latest requests from the website and from programs. Read again on
 *  every snapshot and whenever the active request changes, so a request that starts or ends shows up. */
export function RequestHistory({session}: {session: SessionSummary}) {
  const {client, devices, live} = useStore();
  const [rows, setRows] = useState<RequestSummary[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [open, setOpen] = useState<ID | null>(null);
  const activeId = session.active_request_ids[0] ?? null;

  useEffect(() => {
    let current = true;
    client
      .get<{requests: RequestSummary[]}>(`/sessions/${session.id}/requests?limit=${LIMIT}`)
      .then((r) => {
        if (!current) return;
        setRows(r.requests);
        setError(null);
      })
      .catch((e) => current && setError(e as ApiError));
    return () => {
      current = false;
    };
  }, [client, session.id, live.snapshotCount, activeId, attempt]);

  return (
    <Card data-testid="request-history">
      <CardHeader title="Recent requests" description={`The last ${LIMIT} requests on this session, from this website and from programs with an API key.`} />
      {error && (
        <CardContent>
          <Alert variant="destructive">
            <AlertDescription>
              {describeError(error.body, devices)}{' '}
              <Button size="sm" variant="outline" onClick={() => setAttempt((n) => n + 1)}>Read the list again</Button>
            </AlertDescription>
          </Alert>
        </CardContent>
      )}
      {!error && rows?.length === 0 && <CardContent><p className="text-sm text-muted-foreground">No requests yet.</p></CardContent>}
      {rows && rows.length > 0 && (
        <CardList>
          {rows.map((row) => {
            // The socket's copy is newer than the list while the request runs.
            const request = live.requests[row.id] ?? row;
            const state = STATE[request.state];
            const expanded = open === row.id;
            return (
              <li key={row.id}>
                <button type="button" aria-expanded={expanded} onClick={() => setOpen(expanded ? null : row.id)}
                        className="flex w-full min-w-0 items-center gap-3 px-5 py-3.5 text-left transition-colors hover:bg-subtle sm:px-6">
                  <ChevronRight aria-hidden className={cn('size-4 shrink-0 text-muted-foreground transition-transform', expanded && 'rotate-90')} />
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="font-medium">{SOURCE[request.source]}</span>
                    <span className="text-[13px] text-muted-foreground" title={formatLocalTime(request.received_at)}>
                      {`${formatRelative(request.received_at)} · ${request.output_tokens} tokens`}
                    </span>
                  </span>
                  <Pill tone={state.tone}>{state.label}</Pill>
                </button>
                {expanded && <HistoryOutput requestId={row.id} />}
              </li>
            );
          })}
        </CardList>
      )}
    </Card>
  );
}

/** One request's output, read by ID the way the request area reads a remembered request. */
function HistoryOutput({requestId}: {requestId: ID}) {
  const {client, devices, dispatchLive, live} = useStore();
  const request = live.requests[requestId];
  const output = live.outputs[requestId] ?? emptyOutput;
  const missing = !request;
  const {snapshotCount} = live;
  const [readError, setReadError] = useState<ApiError | null>(null);
  const [readAttempt, setReadAttempt] = useState(0);

  // Snapshots leave out finished requests, so a held copy can disappear; read it again then.
  useEffect(() => {
    if (!missing) return;
    setReadError(null);
    client
      .get<Request>(`/requests/${requestId}`)
      .then((r) => dispatchLive({type: 'request_loaded', request: r}))
      .catch((e) => setReadError(e as ApiError));
  }, [client, dispatchLive, requestId, missing, snapshotCount, readAttempt]);

  const backfill = useBackfill(requestId, request, snapshotCount);
  const failure = readError ?? backfill.error;

  return (
    <div className="flex flex-col gap-3 px-5 pb-4 sm:px-6">
      <OutputView output={output} testId="history-output" />
      {request && <RequestFiles request={request} />}
      {request?.error && <Alert variant="destructive"><AlertDescription>{describeError(request.error, devices)}</AlertDescription></Alert>}
      {failure && (
        <Alert variant="destructive">
          <AlertDescription>
            {describeError(failure.body, devices)}{' '}
            <Button size="sm" variant="outline" onClick={() => (readError ? setReadAttempt((n) => n + 1) : backfill.retry())}>Read the output again</Button>
          </AlertDescription>
        </Alert>
      )}
    </div>
  );
}
