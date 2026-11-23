// Adding a device. The API has no enrollment listing or revocation, so a token
// fails only by expiry or a rejected token request.
import type {DeviceSummary, Enrollment, ID, Time} from '@/api/types';

export type EnrollmentState =
  | {status: 'awaiting_token'; requesting: boolean}
  | {status: 'awaiting_device'; enrollment: Enrollment}
  | {status: 'enrolled'; enrollment: Enrollment; deviceId: ID}
  | {status: 'failed'; reason: string};

export type EnrollmentEvent =
  | {type: 'request'}
  | {type: 'issued'; enrollment: Enrollment}
  | {type: 'issue_failed'; reason: string}
  | {type: 'updated'; enrollment: Enrollment}
  | {type: 'clock'; now: Time}
  | {type: 'devices_seen'; devices: DeviceSummary[]}
  | {type: 'restart'};

export const initialEnrollment: EnrollmentState = {status: 'awaiting_token', requesting: false};

const EXPIRED = 'The token has expired. Request a new one.';

export function enrollmentReducer(state: EnrollmentState, event: EnrollmentEvent): EnrollmentState {
  switch (event.type) {
    case 'request':
      return state.status === 'awaiting_token' || state.status === 'failed'
        ? {status: 'awaiting_token', requesting: true}
        : state;
    case 'issued':
      return {status: 'awaiting_device', enrollment: event.enrollment};
    case 'issue_failed':
      return {status: 'failed', reason: event.reason};
    case 'restart':
      return initialEnrollment;
    case 'updated':
      if (state.status !== 'awaiting_device' || event.enrollment.id !== state.enrollment.id) return state;
      if (event.enrollment.state === 'consumed' && event.enrollment.device_id) {
        return {status: 'enrolled', enrollment: state.enrollment, deviceId: event.enrollment.device_id};
      }
      return event.enrollment.state === 'expired' ? {status: 'failed', reason: EXPIRED} : state;
    case 'clock':
      if (state.status !== 'awaiting_device') return state;
      return Date.parse(event.now) > Date.parse(state.enrollment.expires_at) ? {status: 'failed', reason: EXPIRED} : state;
    case 'devices_seen': {
      // Snapshots do not carry enrollments, so a consumed event lost to a disconnect shows up as a new device.
      if (state.status !== 'awaiting_device') return state;
      const {device_name: name, created_at: issuedAt} = state.enrollment;
      const device = event.devices.find((d) => d.name === name && Date.parse(d.created_at) >= Date.parse(issuedAt));
      return device ? {status: 'enrolled', enrollment: state.enrollment, deviceId: device.id} : state;
    }
  }
}
