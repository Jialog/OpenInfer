// The session page. Everything here is read from server state.
import type {DeviceSummary, ID, SessionSummary, Time} from '@/api/types';
import {isOnline} from './connectivity';

export type SessionView = {
  label: string;
  terminal: boolean;
  /** Startup is under way; its progress is per device (startupProgress.ts), not read from Session.phase. */
  starting: boolean;
  canStop: boolean;
  canSubmit: boolean;
  canReconnect: boolean;
  helperDeviceId: ID | null;
  blockedReason: string | null;
  stopping: {label: string; deadline: Time | null} | null;
  warnings: string[];
  uncleared: string[];
};

const LABELS: Record<SessionSummary['state'], string> = {
  starting: 'Starting',
  ready: 'Ready',
  degraded: 'Degraded',
  stopping: 'Stopping',
  ended: 'Ended',
  failed: 'Failed',
};

const STOP_PHASES: Record<string, string> = {
  drain: 'Waiting for the running request to finish',
  term: 'Asking processes to exit',
  kill: 'Forcing processes to exit',
};

function submitBlock(session: SessionSummary, stale: boolean): string | null {
  if (stale) return 'No connection to the server. New requests are paused.';
  if (session.state !== 'ready' && session.state !== 'degraded') return 'The session is not ready.';
  if (session.submissions_blocked) return 'The service machine is out of contact. New requests are paused.';
  if (session.active_request_ids.length > 0) return 'A request is running. This session runs one at a time.';
  return null;
}

export function deriveSessionView(session: SessionSummary, devices: DeviceSummary[], stale: boolean): SessionView {
  const helper = devices.find((d) => d.reservation?.session_id === session.id && d.reservation.role === 'helper') ?? null;
  const active = session.state === 'ready' || session.state === 'degraded';
  const blockedReason = submitBlock(session, stale);
  const warnings: string[] = [];
  if (active && helper && !isOnline(helper)) {
    warnings.push(`${helper.name} lost its control connection. The session keeps running.`);
  }
  return {
    label: LABELS[session.state],
    terminal: session.state === 'ended' || session.state === 'failed',
    starting: session.state === 'starting',
    canStop: session.state === 'starting' || active,
    canSubmit: blockedReason === null,
    canReconnect: session.state === 'degraded' && helper !== null && isOnline(helper),
    helperDeviceId: helper?.id ?? null,
    blockedReason,
    stopping: session.state === 'stopping'
      ? {label: STOP_PHASES[session.phase] ?? session.phase, deadline: session.stop_deadline_at}
      : null,
    warnings,
    uncleared: session.uncleared_device_ids.map((id) => devices.find((d) => d.id === id)?.name ?? id),
  };
}
