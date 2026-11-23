import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { transition } from '../src/state.ts';

describe('transition', () => {
  it('provides one entry point for every persisted state machine', () => {
    assert.deepEqual(transition('enrollment_tokens', 'none', 'create'), {
      state: 'pending', effects: [],
    });
    assert.deepEqual(transition('devices', 'none', 'enroll'), {
      state: 'idle', effects: [],
    });
    assert.deepEqual(transition('connection_tests', 'none', 'create'), {
      state: 'listening', effects: ['dispatch_listen_test'],
    });
    assert.deepEqual(transition('sessions', 'none', 'create'), {
      state: 'starting', effects: ['reserve_devices', 'dispatch_prepare'],
    });
    assert.deepEqual(transition('instances', 'none', 'create'), {
      state: 'starting', effects: [],
    });
    assert.deepEqual(transition('requests', 'none', 'submit'), {
      state: 'pending', effects: ['create_run_command'],
    });
    assert.deepEqual(transition('archives', 'pending', 'save'), {
      state: 'saved', effects: ['confirm_request_recorded'],
    });
    assert.deepEqual(transition('commands', 'none', 'create'), {
      state: 'pending', effects: [],
    });
  });

  it('returns only real effects that the caller must execute', () => {
    assert.deepEqual(transition('commands', 'sent', 'retry_unacked'), {
      state: 'sent', effects: ['queue_command'],
    });
    assert.deepEqual(transition('requests', 'running', 'no_output_timeout'), {
      state: 'cancelling', effects: ['dispatch_cancel_request'],
    });
    assert.deepEqual(transition('connection_tests', 'testing', 'reachable'), {
      state: 'reachable', effects: ['dispatch_close_test'],
    });
  });

  it('allows request-end proof to complete an undispatched, sent, or executing command', () => {
    for (const state of ['pending', 'sent', 'executing']) {
      assert.deepEqual(transition('commands', state, 'complete_internal'), {
        state: 'completed', effects: [],
      });
    }
  });

  it('rejects absent transitions and unknown machines', () => {
    assert.throws(
      () => transition('sessions', 'ready', 'warmup_succeeded'),
      /Illegal sessions transition/,
    );
    assert.throws(
      () => transition('connection_tests', 'listening', 'cancel'),
      /Illegal connection_tests transition/,
    );
    assert.throws(
      () => transition('operations' as never, 'none', 'create'),
      /Unknown state machine/,
    );
  });

  it('rejects request events that are unreachable in the control flow', () => {
    for (const [state, event] of [
      ['pending', 'restart_unproven'],
      ['recovering', 'end_failed'],
      ['recovering', 'end_cancelled'],
    ]) assert.throws(() => transition('requests', state, event), /Illegal requests transition/);
  });

  it('requires explicit confirmation before removing a device', () => {
    assert.throws(
      () => transition('devices', 'offline', 'remove'),
      /confirmUnavailable/,
    );
    assert.deepEqual(
      transition('devices', 'offline', 'remove', { confirmUnavailable: true }),
      { state: 'removed', effects: ['finalize_removed_device'] },
    );
  });

  it('derives reconciliation state from current evidence, not the prior device state', () => {
    assert.deepEqual(
      transition('devices', 'occupied', 'reconciled', { reserved: true, cleanup: false }),
      { state: 'occupied', effects: [] },
    );
    assert.deepEqual(
      transition('devices', 'idle', 'reconciled', { reserved: false, cleanup: true }),
      { state: 'cleanup_required', effects: ['dispatch_device_cleanup'] },
    );
    assert.deepEqual(
      transition('devices', 'offline', 'reconciled', { reserved: false, cleanup: false }),
      { state: 'idle', effects: [] },
    );
    assert.throws(
      () => transition('devices', 'offline', 'reconciled'),
      /reserved.*cleanup|cleanup.*reserved/,
    );
  });

  it('keeps offline cleanup evidence and lets an idle device become cleanup-required', () => {
    assert.deepEqual(transition('devices', 'offline', 'cleanup_needed'), {
      state: 'offline', effects: [],
    });
    assert.deepEqual(transition('devices', 'idle', 'cleanup_needed'), {
      state: 'cleanup_required', effects: ['dispatch_device_cleanup'],
    });
  });

  it('uses the persisted stop cause to select the terminal session state', () => {
    assert.throws(
      () => transition('sessions', 'stopping', 'all_instances_stopped'),
      /stopCause/,
    );
    assert.deepEqual(
      transition('sessions', 'stopping', 'all_instances_stopped', { stopCause: 'user' }),
      { state: 'ended', effects: ['release_confirmed_devices'] },
    );
    assert.deepEqual(
      transition('sessions', 'stopping', 'all_instances_stopped', {
        stopCause: 'service_failure',
      }),
      { state: 'failed', effects: ['release_confirmed_devices'] },
    );
  });

  it('does not turn a fault cancellation into a user cancellation', () => {
    assert.deepEqual(
      transition('requests', 'cancelling', 'cancel_released', { cancelReason: 'fault' }),
      { state: 'failed', effects: [] },
    );
    assert.deepEqual(
      transition('requests', 'cancelling', 'cancel_released', {
        cancelReason: 'session_stop',
      }),
      { state: 'cancelled', effects: [] },
    );
  });

  it('accepts cancellation output while preserving the cancelling state', () => {
    assert.deepEqual(transition('requests', 'cancelling', 'new_chunk'), {
      state: 'cancelling', effects: ['process_output_chunk'],
    });
    assert.deepEqual(transition('requests', 'cancelling', 'duplicate_chunk'), {
      state: 'cancelling', effects: ['confirm_existing_chunk'],
    });
    assert.deepEqual(transition('requests', 'cancelling', 'gap_chunk'), {
      state: 'cancelling', effects: ['process_gap_chunk'],
    });
  });

  it('fails every active request on a protocol conflict', () => {
    for (const state of ['pending', 'running', 'recovering', 'cancelling']) {
      assert.deepEqual(transition('requests', state, 'protocol_conflict'), {
        state: 'failed', effects: ['stop_session'],
      });
    }
  });

  it('accepts monotonic and repeated cleanup reports but rejects resurrection', () => {
    assert.deepEqual(
      transition('instances', 'loading', 'report', { reportedState: 'ready' }),
      { state: 'ready', effects: [] },
    );
    assert.deepEqual(
      transition('instances', 'failed', 'report', { reportedState: 'failed' }),
      { state: 'failed', effects: [] },
    );
    assert.deepEqual(
      transition('instances', 'cleanup_required', 'report', {
        reportedState: 'cleanup_required',
      }),
      { state: 'cleanup_required', effects: [] },
    );
    assert.deepEqual(
      transition('instances', 'stopping', 'report', { reportedState: 'stopped' }),
      { state: 'stopped', effects: ['handle_instance_stopped'] },
    );
    assert.throws(
      () => transition('instances', 'stopped', 'report', { reportedState: 'ready' }),
      /Illegal instances transition/,
    );
  });

  it('turns a live old-boot instance into cleanup instead of rejecting reconciliation', () => {
    assert.deepEqual(
      transition('instances', 'ready', 'report', {
        reportedState: 'ready', bootChanged: true,
      }),
      { state: 'cleanup_required', effects: ['handle_instance_failure'] },
    );
    assert.deepEqual(
      transition('instances', 'ready', 'report', {
        reportedState: 'stopped', bootChanged: true,
      }),
      { state: 'stopped', effects: ['handle_instance_stopped'] },
    );
    assert.deepEqual(
      transition('instances', 'failed', 'report', {
        reportedState: 'failed', bootChanged: true,
      }),
      { state: 'failed', effects: [] },
    );
    assert.deepEqual(
      transition('instances', 'cleanup_required', 'report', {
        reportedState: 'stopping', bootChanged: true,
      }),
      { state: 'stopping', effects: [] },
    );
  });

  it('keeps stopped instances terminal and requests cleanup for late activity', () => {
    assert.deepEqual(transition('instances', 'stopped', 'late_activity'), {
      state: 'stopped', effects: ['dispatch_late_cleanup'],
    });
  });
});
