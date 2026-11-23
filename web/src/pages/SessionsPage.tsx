import {ChevronRight, Plus} from 'lucide-react';
import {PageHeader} from '@/components/page';
import {StatusIcon, type Status} from '@/components/status';
import {Button} from '@/components/ui/button';
import {Card, CardContent, CardHeader, CardList} from '@/components/ui/card';
import {Pill} from '@/components/ui/pill';
import type {SessionSummary} from '@/api/types';
import {formatLocalTime, formatRelative} from '@/lib/format';
import {deriveSessionView} from '@/state/sessionView';
import {SESSION_TONE} from './SessionPage';
import {useStore} from './Workspace';

const ICON: Record<SessionSummary['state'], Status> = {
  starting: 'running',
  ready: 'done',
  degraded: 'attention',
  stopping: 'running',
  ended: 'pending',
  failed: 'failed',
};

export function SessionsPage() {
  const {live, devices, stale} = useStore();
  const sessions = Object.values(live.sessions).sort((a, b) => b.created_at.localeCompare(a.created_at));
  // Snapshots leave out the plan; a running session's devices are known from their reservations.
  const pair = (id: string) => {
    const role = (r: 'service' | 'helper') => devices.find((d) => d.reservation?.session_id === id && d.reservation.role === r)?.name;
    const service = role('service');
    const helper = role('helper');
    return service && helper ? `${service} with ${helper}` : null;
  };
  return (
    <>
      <PageHeader
        title="Sessions"
        description="A session runs the model on the server with one helper. It keeps running until you end it, even when this page is closed."
        action={<Button asChild><a href="#/sessions/new"><Plus aria-hidden />New session</a></Button>}
      />
      <Card>
        <CardHeader title="Recent sessions" description="Running sessions and the last 20 that ended." />
        {sessions.length === 0 && <CardContent><p className="text-sm text-muted-foreground">No sessions yet.</p></CardContent>}
        {sessions.length > 0 && (
          <CardList>
            {sessions.map((session) => (
              <li key={session.id}>
                <a href={`#/sessions/${session.id}`} className="flex min-w-0 items-center gap-3 px-5 py-4 transition-colors hover:bg-subtle sm:px-6">
                  <StatusIcon status={ICON[session.state]} />
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="font-medium [overflow-wrap:anywhere]">{pair(session.id) ?? session.model}</span>
                    <span className="text-[13px] text-muted-foreground" title={formatLocalTime(session.created_at)}>
                      Started {formatRelative(session.created_at)}
                    </span>
                  </span>
                  <Pill tone={SESSION_TONE[session.state]}>{deriveSessionView(session, devices, stale).label}</Pill>
                  <ChevronRight aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                </a>
              </li>
            ))}
          </CardList>
        )}
      </Card>
    </>
  );
}
