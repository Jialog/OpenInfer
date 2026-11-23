import {describe, expect, it} from 'vitest';
import {makeDevice, makeEnrollment} from '@/test/factories';
import {enrollmentReducer, initialEnrollment, type EnrollmentState} from './enrollment';

const enrollment = makeEnrollment({device_name: 'studio', created_at: '2026-11-08T12:00:00Z', expires_at: '2026-11-09T12:00:00Z'});
const waiting: EnrollmentState = {status: 'awaiting_device', enrollment};

// Adding a device.
describe('enrollment', () => {
  it('awaiting token + request -> marks the request in flight', () => {
    const next = enrollmentReducer(initialEnrollment, {type: 'request'});
    expect(next).toEqual({status: 'awaiting_token', requesting: true});
  });

  it('token issued -> awaiting device', () => {
    const next = enrollmentReducer({status: 'awaiting_token', requesting: true}, {type: 'issued', enrollment});
    expect(next).toEqual(waiting);
  });

  it('enrollment reported as consumed -> enrolled', () => {
    const update = {...enrollment, state: 'consumed' as const, device_id: 'dev-1', token: null};
    expect(enrollmentReducer(waiting, {type: 'updated', enrollment: update})).toEqual({
      status: 'enrolled', enrollment, deviceId: 'dev-1',
    });
  });

  it('keeps showing the token when an update carries token=null', () => {
    const update = {...enrollment, token: null};
    const next = enrollmentReducer(waiting, {type: 'updated', enrollment: update});
    expect(next).toEqual(waiting);
  });

  it('ignores updates for other enrollments', () => {
    const other = makeEnrollment({state: 'consumed', device_id: 'x', token: null});
    expect(enrollmentReducer(waiting, {type: 'updated', enrollment: other})).toEqual(waiting);
  });

  it('token expired on the server -> failed', () => {
    const update = {...enrollment, state: 'expired' as const, token: null};
    const next = enrollmentReducer(waiting, {type: 'updated', enrollment: update});
    expect(next.status).toBe('failed');
  });

  it('token past expires_at by the local clock -> failed', () => {
    const next = enrollmentReducer(waiting, {type: 'clock', now: '2026-11-09T12:00:01Z'});
    expect(next.status).toBe('failed');
    expect(enrollmentReducer(waiting, {type: 'clock', now: '2026-11-09T11:59:59Z'})).toEqual(waiting);
  });

  it('token request rejected -> failed with the reason', () => {
    const next = enrollmentReducer({status: 'awaiting_token', requesting: true}, {type: 'issue_failed', reason: 'Device name too long.'});
    expect(next).toEqual({status: 'failed', reason: 'Device name too long.'});
  });

  it('failed + new token request -> requests again', () => {
    expect(enrollmentReducer({status: 'failed', reason: 'x'}, {type: 'request'})).toEqual({status: 'awaiting_token', requesting: true});
  });

  it('enrolled + add another -> awaiting token', () => {
    expect(enrollmentReducer({status: 'enrolled', enrollment, deviceId: 'd'}, {type: 'restart'})).toEqual(initialEnrollment);
  });

  it('a device seen in a snapshot with the same name, created after the token -> enrolled', () => {
    const device = makeDevice({name: 'studio', created_at: '2026-11-08T12:05:00Z'});
    expect(enrollmentReducer(waiting, {type: 'devices_seen', devices: [device]})).toEqual({
      status: 'enrolled', enrollment, deviceId: device.id,
    });
  });

  it('ignores an older device with the same name', () => {
    const device = makeDevice({name: 'studio', created_at: '2026-11-01T00:00:00Z'});
    expect(enrollmentReducer(waiting, {type: 'devices_seen', devices: [device]})).toEqual(waiting);
  });
});
