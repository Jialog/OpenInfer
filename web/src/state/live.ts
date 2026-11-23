// Realtime connection and the browser's copy of server state (docs/API.md).
import type {
  Chunk,
  ConnectionTest,
  Device,
  DeviceSummary,
  ID,
  Instance,
  Inventory,
  Request,
  RequestSummary,
  Session,
  SessionPlan,
  SessionSummary,
  Snapshot,
  Statistics,
  U64,
  VersionConfig,
  WsMessage,
} from '@/api/types';
import {applyChunks, emptyOutput, isTerminalRequest, type OutputState} from './output';

export type ConnectionStatus = 'connecting' | 'connected' | 'reconnecting' | 'refused' | 'signed_out';

export type DeviceDetails = {inventory: Inventory};
export type SessionDetails = {plan: SessionPlan; instances: Instance[]; versions: VersionConfig[]};
/** A request as held: snapshots leave out its statistics, `request.updated` and REST reads carry them. */
export type HeldRequest = RequestSummary & {statistics?: Statistics};

export type LiveState = {
  connection: ConnectionStatus;
  /** Why the server refused this connection; only a page refresh tries again. */
  refusedReason: string | null;
  /** Number of snapshots received; effects keyed on it re-read what snapshots omit. */
  snapshotCount: number;
  /** Where the server keeps files and results (Snapshot.storage); null until the first snapshot. */
  storage: 'bucket' | 'memory' | null;
  devices: Record<ID, DeviceSummary>;
  deviceDetails: Record<ID, DeviceDetails>;
  connectionTests: Record<ID, ConnectionTest>;
  sessions: Record<ID, SessionSummary>;
  sessionDetails: Record<ID, SessionDetails>;
  requests: Record<ID, HeldRequest>;
  watermarks: Record<ID, U64>;
  outputs: Record<ID, OutputState>;
};

export type LiveEvent =
  | {type: 'message'; message: WsMessage}
  | {type: 'disconnected'}
  | {type: 'refused'; reason: string}
  | {type: 'session_expired'}
  | {type: 'device_loaded'; device: Device}
  | {type: 'test_loaded'; test: ConnectionTest}
  | {type: 'session_loaded'; session: Session}
  | {type: 'request_loaded'; request: Request}
  | {type: 'chunks_loaded'; requestId: ID; chunks: Chunk[]};

export const initialLive: LiveState = {
  connection: 'connecting',
  refusedReason: null,
  snapshotCount: 0,
  storage: null,
  devices: {},
  deviceDetails: {},
  connectionTests: {},
  sessions: {},
  sessionDetails: {},
  requests: {},
  watermarks: {},
  outputs: {},
};

export function isStale(state: LiveState): boolean {
  return state.connection !== 'connected';
}

export function reconnectDelayMs(attempt: number): number {
  return Math.min(30_000, 1000 * 2 ** attempt);
}

function byId<T extends {id: ID}>(items: T[]): Record<ID, T> {
  return Object.fromEntries(items.map((item) => [item.id, item]));
}

function keepPresent<T>(details: Record<ID, T>, present: Record<ID, unknown>): Record<ID, T> {
  return Object.fromEntries(Object.entries(details).filter(([id]) => id in present));
}

function applySnapshot(state: LiveState, snapshot: Snapshot): LiveState {
  const devices = byId(snapshot.devices);
  const sessions = byId(snapshot.sessions);
  return {
    ...state,
    connection: 'connected',
    refusedReason: null,
    snapshotCount: state.snapshotCount + 1,
    storage: snapshot.storage,
    devices,
    deviceDetails: keepPresent(state.deviceDetails, devices),
    connectionTests: byId(snapshot.connection_tests),
    sessions,
    sessionDetails: keepPresent(state.sessionDetails, sessions),
    requests: byId(snapshot.requests),
    watermarks: Object.fromEntries(snapshot.output_watermarks.map((w) => [w.request_id, w.contiguous_seq])),
  };
}

function addChunks(state: LiveState, requestId: ID, chunks: Chunk[]): LiveState {
  const output = applyChunks(state.outputs[requestId] ?? emptyOutput, chunks);
  return {...state, outputs: {...state.outputs, [requestId]: output}};
}

function withSession(state: LiveState, session: Session): LiveState {
  return {
    ...state,
    sessions: {...state.sessions, [session.id]: session},
    sessionDetails: {...state.sessionDetails, [session.id]: {plan: session.plan, instances: session.instances, versions: session.effective_config.versions}},
  };
}

function withDevice(state: LiveState, device: Device): LiveState {
  return {
    ...state,
    devices: {...state.devices, [device.id]: device},
    deviceDetails: {...state.deviceDetails, [device.id]: {inventory: device.inventory}},
  };
}

function applyMessage(state: LiveState, message: WsMessage): LiveState {
  if (message.type === 'snapshot') return applySnapshot(state, message.payload);
  if (state.connection !== 'connected') return state;
  switch (message.type) {
    case 'device.updated':
      return withDevice(state, message.payload);
    case 'connection_test.updated':
      return {...state, connectionTests: {...state.connectionTests, [message.payload.id]: message.payload}};
    case 'session.updated':
      return withSession(state, message.payload);
    case 'request.updated':
      return {...state, requests: {...state.requests, [message.payload.id]: message.payload}};
    case 'output.chunk':
      return addChunks(state, message.payload.request_id, [message.payload]);
    case 'resync_required':
      return {...state, connection: 'reconnecting'};
    case 'enrollment.updated':
      return state;
  }
}

export function liveReducer(state: LiveState, event: LiveEvent): LiveState {
  switch (event.type) {
    case 'message':
      return applyMessage(state, event.message);
    case 'disconnected':
      return state.connection === 'signed_out' ? state : {...state, connection: 'reconnecting'};
    case 'refused':
      return {...state, connection: 'refused', refusedReason: event.reason};
    case 'session_expired':
      return {...state, connection: 'signed_out'};
    // REST reads may be older than the socket, so they fill gaps and never replace held state.
    case 'device_loaded':
      return {
        ...state,
        devices: event.device.id in state.devices ? state.devices : {...state.devices, [event.device.id]: event.device},
        deviceDetails: {...state.deviceDetails, [event.device.id]: {inventory: event.device.inventory}},
      };
    case 'test_loaded':
      return event.test.id in state.connectionTests
        ? state
        : {...state, connectionTests: {...state.connectionTests, [event.test.id]: event.test}};
    case 'session_loaded':
      return {
        ...state,
        sessions: event.session.id in state.sessions ? state.sessions : {...state.sessions, [event.session.id]: event.session},
        sessionDetails: {...state.sessionDetails, [event.session.id]: {plan: event.session.plan, instances: event.session.instances, versions: event.session.effective_config.versions}},
      };
    case 'request_loaded': {
      const held = state.requests[event.request.id];
      if (held && (isTerminalRequest(held.state) || !isTerminalRequest(event.request.state))) return state;
      return {...state, requests: {...state.requests, [event.request.id]: event.request}};
    }
    case 'chunks_loaded':
      return addChunks(state, event.requestId, event.chunks);
  }
}
