import {describe, expect, it} from 'vitest';
import type {DeviceSummary} from '@/api/types';
import {makeDevice, makeError, makeSession} from '@/test/factories';
import {describeError} from '@/api/errors';
import {deriveSessionView} from './sessionView';

const mac = makeDevice({id: 'mac', kind: 'mac', name: 'studio'});
function helperDevice(state: DeviceSummary['state'], session: string): DeviceSummary {
  return {...makeDevice({id: 'helper', kind: 'linux', name: 'gpu-box', state}), reservation: {session_id: session, role: 'helper'}};
}

// The session page and the transitions it displays.
describe('session page', () => {
  it('starting: says so; the steps of each device come from startupProgress', () => {
    const view = deriveSessionView(makeSession({state: 'starting', phase: 'load'}), [], false);
    expect(view.label).toBe('Starting');
    expect(view.starting).toBe(true);
    expect(view.canSubmit).toBe(false);
  });

  it('ready: can submit, can stop, no progress list', () => {
    const view = deriveSessionView(makeSession({state: 'ready', phase: 'serve'}), [], false);
    expect(view.label).toBe('Ready');
    expect(view.starting).toBe(false);
    expect(view.canSubmit).toBe(true);
    expect(view.canStop).toBe(true);
  });

  it('degraded: can still submit and can reconnect the helper', () => {
    const s = makeSession({state: 'degraded', phase: 'serve'});
    const view = deriveSessionView(s, [mac, helperDevice('occupied', s.id)], false);
    expect(view.label).toBe('Degraded');
    expect(view.canSubmit).toBe(true);
    expect(view.canReconnect).toBe(true);
    expect(view.helperDeviceId).toBe('helper');
  });

  it('degraded with the helper device offline: cannot reconnect yet', () => {
    const s = makeSession({state: 'degraded', phase: 'serve'});
    expect(deriveSessionView(s, [mac, helperDevice('offline', s.id)], false).canReconnect).toBe(false);
  });

  it('only degraded offers reconnect', () => {
    const s = makeSession({state: 'ready', phase: 'serve'});
    expect(deriveSessionView(s, [mac, helperDevice('occupied', s.id)], false).canReconnect).toBe(false);
  });

  it('stopping: cannot stop again or submit', () => {
    const view = deriveSessionView(makeSession({state: 'stopping', phase: 'drain'}), [], false);
    expect(view.label).toBe('Stopping');
    expect(view.canStop).toBe(false);
    expect(view.canSubmit).toBe(false);
  });

  it.each([['ended', 'Ended'], ['failed', 'Failed']] as const)('%s: terminal, no actions', (state, label) => {
    const view = deriveSessionView(makeSession({state, phase: 'kill'}), [], false);
    expect(view.label).toBe(label);
    expect(view.terminal).toBe(true);
    expect(view.canStop).toBe(false);
    expect(view.canSubmit).toBe(false);
    expect(view.canReconnect).toBe(false);
  });

  it('starting can be stopped', () => {
    expect(deriveSessionView(makeSession({state: 'starting'}), [], false).canStop).toBe(true);
  });

  it.each([
    ['drain', /running request/i],
    ['term', /asking/i],
    ['kill', /forcing/i],
  ])('stopping shows the actual %s phase', (phase, text) => {
    const view = deriveSessionView(makeSession({state: 'stopping', phase, stop_deadline_at: '2026-11-08T12:01:00Z'}), [], false);
    expect(view.stopping?.label).toMatch(text);
    expect(view.stopping?.deadline).toBe('2026-11-08T12:01:00Z');
  });

  it('shows an unlisted stopping phase as it is', () => {
    expect(deriveSessionView(makeSession({state: 'stopping', phase: 'reconcile'}), [], false).stopping?.label).toBe('reconcile');
  });

  it('only a stopping session has stop progress', () => {
    expect(deriveSessionView(makeSession({state: 'ready', phase: 'serve'}), [], false).stopping).toBeNull();
  });

  it('stale data blocks submitting but not stopping', () => {
    const view = deriveSessionView(makeSession({state: 'ready', phase: 'serve'}), [], true);
    expect(view.canSubmit).toBe(false);
    expect(view.blockedReason).toMatch(/connection/i);
    expect(view.canStop).toBe(true);
  });

  it('submissions_blocked blocks submitting with a reason', () => {
    const view = deriveSessionView(makeSession({state: 'ready', submissions_blocked: true}), [], false);
    expect(view.canSubmit).toBe(false);
    expect(view.blockedReason).toMatch(/service/i);
  });

  it('an active request blocks submitting', () => {
    const view = deriveSessionView(makeSession({state: 'ready', active_request_ids: ['r']}), [], false);
    expect(view.canSubmit).toBe(false);
  });

  it('warns when only the helper control connection is offline, keeping the state', () => {
    const s = makeSession({state: 'ready', phase: 'serve'});
    const view = deriveSessionView(s, [mac, helperDevice('offline', s.id)], false);
    expect(view.label).toBe('Ready');
    expect(view.warnings.join(' ')).toMatch(/gpu-box.*control connection/i);
  });

  it('lists devices that were not cleared', () => {
    const s = makeSession({state: 'ended', uncleared_device_ids: ['mac']});
    expect(deriveSessionView(s, [mac], false).uncleared).toEqual(['studio']);
  });
});

describe('describeError', () => {
  it('names the phase, device and reason', () => {
    const text = describeError(makeError({phase: 'load', device_id: 'mac', message: 'Out of memory.'}), [mac]);
    expect(text).toBe('load · studio · Out of memory.');
  });

  it('omits what is unknown', () => {
    expect(describeError(makeError({message: 'Rejected.'}), [])).toBe('Rejected.');
  });
});
