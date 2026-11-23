import {useEffect, useRef, useState} from 'react';
import {describeError, type ApiError} from '@/api/errors';
import type {ID, Session, SessionSummary} from '@/api/types';
import {PageHeader} from '@/components/page';
import {ProgressBar} from '@/components/progress';
import {SegmentBar} from '@/components/segments';
import {StatusIcon} from '@/components/status';
import {Alert, AlertDescription} from '@/components/ui/alert';
import {Button} from '@/components/ui/button';
import {Card, CardContent, CardHeader} from '@/components/ui/card';
import {Pill, type Tone} from '@/components/ui/pill';
import {formatLocalTime, formatRelative} from '@/lib/format';
import {useAction} from '@/lib/useAction';
import {deriveSessionView} from '@/state/sessionView';
import {addSample, downloadRate, startupProgress, type ByteSample} from '@/state/startupProgress';
import {RequestArea} from './RequestArea';
import {RequestHistory} from './RequestHistory';
import {useStore} from './Workspace';

export const SESSION_TONE: Record<SessionSummary['state'], Tone> = {
  starting: 'info',
  ready: 'success',
  degraded: 'warning',
  stopping: 'neutral',
  ended: 'neutral',
  failed: 'danger',
};

export function SessionPage({sessionId}: {sessionId: string}) {
  const {client, devices, dispatchLive, live} = useStore();
  const session = live.sessions[sessionId];
  const [loadError, setLoadError] = useState<ApiError | null>(null);

  // Snapshots leave out instances and the plan; a session may also be older than the snapshot's history.
  useEffect(() => {
    client
      .get<Session>(`/sessions/${sessionId}`)
      .then((s) => dispatchLive({type: 'session_loaded', session: s}))
      .catch((e) => setLoadError(e as ApiError));
  }, [client, dispatchLive, sessionId, live.snapshotCount]);

  if (!session) {
    if (loadError) return <p className="text-sm text-muted-foreground">{loadError.status === 404 ? 'Session not found.' : describeError(loadError.body, devices)}</p>;
    return <p className="text-sm text-muted-foreground">Loading…</p>;
  }
  return <SessionBody session={session} />;
}

function SessionBody({session}: {session: SessionSummary}) {
  const {client, devices, live, stale} = useStore();
  const view = deriveSessionView(session, devices, stale);
  const stop = useAction(() => client.post(`/sessions/${session.id}/stop`, {}));
  const reconnect = useAction(() => client.post(`/sessions/${session.id}/helpers/${view.helperDeviceId}/reconnect`, {}));
  const actionError = stop.error ?? reconnect.error;
  const details = live.sessionDetails[session.id];
  const reserved = (role: 'service' | 'helper') => devices.find((d) => d.reservation?.session_id === session.id && d.reservation.role === role)?.id ?? null;
  const serviceId = details?.plan.service_device_id ?? reserved('service');
  const helperId = details?.plan.helpers[0]?.device_id ?? reserved('helper');
  const name = (id: string) => live.devices[id]?.name ?? id;
  const helperVersion = details?.versions.find((v) => v.id === details.plan.helpers[0]?.version_id)?.label;
  const summary = [
    serviceId && helperId ? `${name(serviceId)} with ${name(helperId)}` : null,
    helperVersion ?? null,
    `started ${formatRelative(session.created_at)}`,
  ].filter(Boolean).join(' · ');
  const active = session.state === 'ready' || session.state === 'degraded';

  return (
    <>
      <PageHeader
        title="Session"
        aside={
          <>
            <Pill tone={SESSION_TONE[session.state]}>{view.label}</Pill>
            {active && (session.state === 'ready'
              ? <Pill tone="success">Helper connected</Pill>
              : <Pill tone="warning">Helper degraded</Pill>)}
          </>
        }
        description={<span title={formatLocalTime(session.created_at)}>{summary}</span>}
        action={
          <>
            {view.canReconnect && (
              <Button variant="outline" disabled={reconnect.pending} onClick={() => void reconnect.run()}>Reconnect helper</Button>
            )}
            {view.canStop && (
              <Button variant="outline" disabled={stop.pending} onClick={() => void stop.run()}>End session</Button>
            )}
          </>
        }
      />
      {actionError && <Alert variant="destructive"><AlertDescription>{describeError(actionError.body, devices)}</AlertDescription></Alert>}
      {session.error && (
        <Alert variant="destructive"><AlertDescription>{describeError(session.error, devices)}</AlertDescription></Alert>
      )}
      {view.warnings.map((text) => <Alert key={text} variant="warning"><AlertDescription>{text}</AlertDescription></Alert>)}
      {view.uncleared.length > 0 && (
        <Alert variant="warning">
          <AlertDescription>
            <span>{view.uncleared.join(', ')}: stopping was not confirmed.</span>{' '}
            <a href="#/devices">Open the Devices page</a>
          </AlertDescription>
        </Alert>
      )}
      {view.stopping && (
        <Card>
          <CardContent className="flex items-center gap-2.5 pt-5 text-sm">
            <StatusIcon status="running" />
            <span>
              {view.stopping.label}
              {view.stopping.deadline && <span className="text-muted-foreground">{` (by ${new Date(view.stopping.deadline).toLocaleTimeString()})`}</span>}
            </span>
          </CardContent>
        </Card>
      )}
      {view.starting && (
        <StartupCard session={session} serviceId={serviceId} helperId={helperId} />
      )}
      <RequestArea session={session} canSubmit={view.canSubmit} blockedReason={view.blockedReason} />
      <RequestHistory session={session} />
    </>
  );
}

function StartupCard({session, serviceId, helperId}: {session: SessionSummary; serviceId: string | null; helperId: string | null}) {
  const {live} = useStore();
  const instances = live.sessionDetails[session.id]?.instances ?? [];
  // The download speed comes from the reports this page has seen. A report is kept once, so a repeated render
  // changes nothing; the clock below lets a stalled download lose its speed.
  const samples = useRef(new Map<ID, ByteSample[]>());
  const downloading = instances.filter((i) => i.phase === 'download' && i.progress);
  const [, setClock] = useState(0);
  useEffect(() => {
    if (downloading.length === 0) return;
    const timer = setInterval(() => setClock((n) => n + 1), 5000);
    return () => clearInterval(timer);
  }, [downloading.length > 0]);
  const now = Date.now();
  const rates: Record<ID, number | null> = {};
  for (const instance of downloading) {
    const list = addSample(samples.current.get(instance.instance_id) ?? [], instance.progress!, now);
    samples.current.set(instance.instance_id, list);
    rates[instance.instance_id] = downloadRate(list, now);
  }
  const progress = startupProgress({
    session,
    serviceId,
    helperId,
    instances,
    deviceName: (id) => live.devices[id]?.name ?? id,
  }, rates);
  return (
    <Card>
      <CardHeader title="Starting up" description="Each device gets ready on its own. The warm-up runs once, after the helper has connected to the server. The downloads are simulated: their sizes and rates are the simulator's settings, not measurements." />
      <CardContent className="flex flex-col gap-5">
        {progress.rows.map((row) => (
          <div key={row.key} className="flex flex-col gap-2">
            <span className="text-[13px] font-medium [overflow-wrap:anywhere] text-muted-foreground">{row.title}</span>
            <SegmentBar segments={row.segments} testId={`startup-${row.key}`} />
            {row.download && (row.download.total
              ? <ProgressBar value={row.download.completed} max={row.download.total} label={row.download.label} />
              : <span className="text-[13px] text-muted-foreground">{row.download.label}</span>)}
          </div>
        ))}
        <div className="flex flex-col gap-2">
          <span className="text-[13px] font-medium text-muted-foreground">Both devices</span>
          <SegmentBar segments={[progress.warmup]} testId="startup" />
        </div>
      </CardContent>
    </Card>
  );
}
