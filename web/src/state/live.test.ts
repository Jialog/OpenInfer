import {describe, expect, it} from 'vitest';
import type {Chunk, Snapshot, WsMessage} from '@/api/types';
import {NOW, makeDevice, makeRequest, makeSession, makeTest} from '@/test/factories';
import {initialLive, isStale, liveReducer, reconnectDelayMs, type LiveState} from './live';

function snapshot(patch: Partial<Snapshot> = {}): WsMessage {
  return {v: 1, type: 'snapshot', connection_id: 'c1', seq: '0', at: NOW,
          payload: {at: NOW, group_id: 'g', storage: 'memory', devices: [], connection_tests: [], sessions: [], requests: [], output_watermarks: [], ...patch}};
}
function msg(m: Omit<WsMessage, 'v' | 'connection_id' | 'seq' | 'at'>): WsMessage {
  return {v: 1, connection_id: 'c1', seq: '1', at: NOW, ...m} as WsMessage;
}
const connected: LiveState = liveReducer(initialLive, {type: 'message', message: snapshot()});

// The realtime connection.
describe('realtime connection', () => {
  it('starts connecting and is stale', () => {
    expect(initialLive.connection).toBe('connecting');
    expect(isStale(initialLive)).toBe(true);
  });

  it('connecting + snapshot -> connected, no longer stale', () => {
    expect(connected.connection).toBe('connected');
    expect(isStale(connected)).toBe(false);
  });

  it('connected + disconnect -> reconnecting, stale', () => {
    const next = liveReducer(connected, {type: 'disconnected'});
    expect(next.connection).toBe('reconnecting');
    expect(isStale(next)).toBe(true);
  });

  it('connecting + handshake timeout -> reconnecting', () => {
    expect(liveReducer(initialLive, {type: 'disconnected'}).connection).toBe('reconnecting');
  });

  it('connected + refused by the server -> refused, stale, with the reason', () => {
    const refused = liveReducer(connected, {type: 'refused', reason: 'No permission.'});
    expect(refused.connection).toBe('refused');
    expect(refused.refusedReason).toBe('No permission.');
    expect(isStale(refused)).toBe(true);
  });

  it('a plain disconnect is not refused', () => {
    const next = liveReducer(connected, {type: 'disconnected'});
    expect(next.connection).toBe('reconnecting');
    expect(next.refusedReason).toBeNull();
  });

  it('reconnecting + snapshot -> connected', () => {
    const next = liveReducer(liveReducer(connected, {type: 'disconnected'}), {type: 'message', message: snapshot()});
    expect(next.connection).toBe('connected');
  });

  it('login expired -> leaves the connection', () => {
    expect(liveReducer(connected, {type: 'session_expired'}).connection).toBe('signed_out');
  });

  it('resync_required -> reconnecting', () => {
    const next = liveReducer(connected, {type: 'message', message: msg({type: 'resync_required', payload: {reason: 'buffer'}})});
    expect(next.connection).toBe('reconnecting');
  });

  it('backs off exponentially and caps', () => {
    expect([0, 1, 2, 3].map(reconnectDelayMs)).toEqual([1000, 2000, 4000, 8000]);
    expect(reconnectDelayMs(10)).toBe(30000);
  });
});

describe('server state', () => {
  it('does not change a running request when the connection drops', () => {
    const req = makeRequest({state: 'running'});
    const before = liveReducer(connected, {type: 'message', message: msg({type: 'request.updated', payload: req})});
    const after = liveReducer(before, {type: 'disconnected'});
    expect(after.requests[req.id].state).toBe('running');
  });

  it('keeps where the server says its files are, as the newest snapshot says it', () => {
    expect(initialLive.storage).toBeNull();
    expect(connected.storage).toBe('memory');
    expect(liveReducer(connected, {type: 'message', message: snapshot({storage: 'bucket'})}).storage).toBe('bucket');
  });

  it('replaces all server state with a new snapshot', () => {
    const a = makeDevice({name: 'old'});
    const b = makeDevice({name: 'new'});
    const s = makeSession({state: 'ready'});
    const t = makeTest();
    let state = liveReducer(connected, {type: 'message', message: msg({type: 'device.updated', payload: a})});
    state = liveReducer(state, {type: 'message', message: msg({type: 'session.updated', payload: s})});
    state = liveReducer(state, {type: 'message', message: msg({type: 'connection_test.updated', payload: t})});
    state = liveReducer(state, {type: 'message', message: snapshot({devices: [b], sessions: [{...s, state: 'ended'}]})});
    expect(Object.keys(state.devices)).toEqual([b.id]);
    expect(state.sessions[s.id].state).toBe('ended');
    expect(state.connectionTests).toEqual({});
  });

  it('keeps device details only for devices still present after a snapshot', () => {
    const a = makeDevice();
    const b = makeDevice();
    let state = liveReducer(connected, {type: 'message', message: msg({type: 'device.updated', payload: a})});
    state = liveReducer(state, {type: 'message', message: msg({type: 'device.updated', payload: b})});
    const {inventory: _i, instances: _n, ...summary} = a;
    state = liveReducer(state, {type: 'message', message: snapshot({devices: [summary]})});
    expect(Object.keys(state.deviceDetails)).toEqual([a.id]);
    expect(state.deviceDetails[a.id]).toEqual({inventory: a.inventory});
  });

  it('records snapshot watermarks and counts snapshots', () => {
    const state = liveReducer(connected, {type: 'message', message: snapshot({output_watermarks: [{request_id: 'r', contiguous_seq: '5'}]})});
    expect(state.watermarks.r).toBe('5');
    expect(state.snapshotCount).toBe(2);
  });

  it('applies deltas only after a snapshot', () => {
    const device = makeDevice();
    const next = liveReducer(initialLive, {type: 'message', message: msg({type: 'device.updated', payload: device})});
    expect(next.devices).toEqual({});
  });

  it('routes output chunks to the output buffer and keeps it across snapshots', () => {
    const chunk: Chunk = {request_id: 'r', seq: '1', text: 'hi', token_count: 1, committed_position: '11', segment: 'answer',
                          engine_first_output_ns: null, engine_last_output_ns: null, engine_first_chunk_tokens: null, received_at: NOW};
    let state = liveReducer(connected, {type: 'message', message: msg({type: 'output.chunk', payload: chunk})});
    expect(state.outputs.r.answer).toBe('hi');
    state = liveReducer(state, {type: 'message', message: snapshot()});
    expect(state.outputs.r.answer).toBe('hi');
  });

  it('merges REST chunks with the same deduplication', () => {
    const chunk: Chunk = {request_id: 'r', seq: '1', text: 'hi', token_count: 1, committed_position: '11', segment: 'answer',
                          engine_first_output_ns: null, engine_last_output_ns: null, engine_first_chunk_tokens: null, received_at: NOW};
    let state = liveReducer(connected, {type: 'chunks_loaded', requestId: 'r', chunks: [chunk]});
    state = liveReducer(state, {type: 'chunks_loaded', requestId: 'r', chunks: [chunk]});
    expect(state.outputs.r.answer).toBe('hi');
  });

  it('adds a REST-loaded request that is missing', () => {
    const req = makeRequest({state: 'completed'});
    expect(liveReducer(connected, {type: 'request_loaded', request: req}).requests[req.id].state).toBe('completed');
  });

  it('lets a REST-loaded terminal request replace a non-terminal one', () => {
    const req = makeRequest({state: 'running'});
    const state = liveReducer(connected, {type: 'message', message: msg({type: 'request.updated', payload: req})});
    expect(liveReducer(state, {type: 'request_loaded', request: {...req, state: 'failed'}}).requests[req.id].state).toBe('failed');
  });

  it('does not let a REST-loaded request overwrite a request already held', () => {
    const req = makeRequest({state: 'running', contiguous_seq: '7'});
    const state = liveReducer(connected, {type: 'message', message: msg({type: 'request.updated', payload: req})});
    expect(liveReducer(state, {type: 'request_loaded', request: {...req, contiguous_seq: '3'}}).requests[req.id].contiguous_seq).toBe('7');
  });

  it('fills session details from REST without overwriting session state', () => {
    const s = makeSession({state: 'ready'});
    const state = liveReducer(connected, {type: 'message', message: msg({type: 'session.updated', payload: s})});
    const next = liveReducer(state, {type: 'session_loaded', session: {...s, state: 'starting'}});
    expect(next.sessions[s.id].state).toBe('ready');
    expect(next.sessionDetails[s.id].plan).toEqual(s.plan);
  });

  it('adds a REST-loaded session that is not in the snapshot', () => {
    const s = makeSession({state: 'ended'});
    expect(liveReducer(connected, {type: 'session_loaded', session: s}).sessions[s.id].state).toBe('ended');
  });

  it('adds a REST-loaded connection test and does not overwrite a held one', () => {
    const t = makeTest({state: 'reachable'});
    const state = liveReducer(connected, {type: 'test_loaded', test: t});
    expect(state.connectionTests[t.id].state).toBe('reachable');
    expect(liveReducer(state, {type: 'test_loaded', test: {...t, state: 'testing'}}).connectionTests[t.id].state).toBe('reachable');
  });
});
