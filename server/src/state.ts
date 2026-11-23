export type StateTable =
  | 'enrollment_tokens'
  | 'devices'
  | 'connection_tests'
  | 'sessions'
  | 'instances'
  | 'requests'
  | 'archives'
  | 'commands';

export type TransitionContext = Record<string, unknown>;
export type TransitionResult = { state: string; effects: string[] };

type Rule = readonly [state: string, effects: readonly string[]];
type Rules = Readonly<Record<string, Readonly<Record<string, Rule>>>>;

const rule = (table: StateTable, rules: Rules, state: string, event: string): TransitionResult => {
  const next = rules[state]?.[event];
  if (!next) throw new Error(`Illegal ${table} transition: ${state} + ${event}`);
  return { state: next[0], effects: [...next[1]] };
};

const enrollmentRules: Rules = {
  none: { create: ['pending', []] },
  pending: {
    consume: ['consumed', ['create_device']],
    expire: ['expired', []],
  },
};

const testRules: Rules = {
  none: { create: ['listening', ['dispatch_listen_test']] },
  listening: {
    listener_ready: ['testing', ['dispatch_connect_test']],
    fail: ['unreachable', ['dispatch_close_test']],
  },
  testing: {
    reachable: ['reachable', ['dispatch_close_test']],
    unreachable: ['unreachable', ['dispatch_close_test']],
    fail: ['unreachable', ['dispatch_close_test']],
  },
  reachable: { cleanup_confirmed: ['reachable', []] },
  unreachable: { cleanup_confirmed: ['unreachable', []] },
};

const sessionRules: Rules = {
  none: { create: ['starting', ['reserve_devices', 'dispatch_prepare']] },
  starting: {
    startup_progress: ['starting', ['advance_startup']],
    warmup_succeeded: ['ready', []],
    serving_ready: ['ready', []],
    user_stop: ['stopping', ['begin_session_stop']],
    startup_failure: ['stopping', ['begin_session_stop']],
  },
  ready: {
    helper_disconnected: ['degraded', []],
    service_disconnected: ['ready', ['mark_requests_disconnected']],
    service_reconciled: ['ready', ['resume_requests']],
    user_stop: ['stopping', ['begin_session_stop']],
    service_failure: ['stopping', ['begin_session_stop']],
    service_timeout: ['stopping', ['begin_session_stop']],
    request_cleanup_failure: ['stopping', ['begin_session_stop']],
  },
  degraded: {
    helper_reconnect_requested: ['degraded', ['begin_helper_reconnect']],
    helper_reconnected: ['ready', []],
    helper_reconnect_failed: ['degraded', []],
    service_disconnected: ['degraded', ['mark_requests_disconnected']],
    service_reconciled: ['degraded', ['resume_requests']],
    user_stop: ['stopping', ['begin_session_stop']],
    service_failure: ['stopping', ['begin_session_stop']],
    service_timeout: ['stopping', ['begin_session_stop']],
    request_cleanup_failure: ['stopping', ['begin_session_stop']],
  },
  ended: { late_activity: ['ended', ['dispatch_late_cleanup']] },
  failed: { late_activity: ['failed', ['dispatch_late_cleanup']] },
};

const commandRules: Rules = {
  none: { create: ['pending', []] },
  pending: {
    dispatch: ['sent', ['queue_command']],
    complete_internal: ['completed', []],
    complete: ['completed', ['handle_command_result']],
    fail: ['failed', ['handle_command_result']],
    cancel: ['cancelled', ['handle_command_result']],
    deadline_expired: ['failed', ['handle_command_timeout']],
    supersede: ['cancelled', []],
  },
  sent: {
    retry_unacked: ['sent', ['queue_command']],
    acknowledge: ['executing', []],
    complete_internal: ['completed', []],
    complete: ['completed', ['handle_command_result']],
    fail: ['failed', ['handle_command_result']],
    cancel: ['cancelled', ['handle_command_result']],
    deadline_expired: ['failed', ['handle_command_timeout']],
    supersede: ['cancelled', []],
  },
  executing: {
    complete_internal: ['completed', []],
    complete: ['completed', ['handle_command_result']],
    fail: ['failed', ['handle_command_result']],
    cancel: ['cancelled', ['handle_command_result']],
    deadline_expired: ['failed', ['handle_command_timeout']],
    supersede: ['cancelled', []],
  },
  completed: { late_result: ['completed', ['dispatch_late_cleanup']] },
  failed: { late_result: ['failed', ['dispatch_late_cleanup']] },
  cancelled: { late_result: ['cancelled', ['dispatch_late_cleanup']] },
};

const activeRequests = ['pending', 'running', 'recovering', 'cancelling'] as const;
const chunkEffects: Record<string, string[]> = {
  new_chunk: ['process_output_chunk'],
  duplicate_chunk: ['confirm_existing_chunk'],
  gap_chunk: ['process_gap_chunk'],
};

function requestTransition(state: string, event: string, context: TransitionContext): TransitionResult {
  if (activeRequests.includes(state as (typeof activeRequests)[number]) && event === 'protocol_conflict') {
    return { state: 'failed', effects: ['stop_session'] };
  }
  if (['running', 'recovering', 'cancelling'].includes(state) && event in chunkEffects) {
    return { state, effects: [...chunkEffects[event]] };
  }
  if (state === 'cancelling' && event === 'cancel_released') {
    if (typeof context.cancelReason !== 'string') {
      throw new Error('requests cancel_released requires cancelReason');
    }
    return { state: context.cancelReason === 'fault' ? 'failed' : 'cancelled', effects: [] };
  }

  const rules: Rules = {
    none: { submit: ['pending', ['create_run_command']] },
    pending: {
      dispatch: ['running', []],
      session_stop: ['cancelled', []],
      client_disconnected: ['cancelled', []],
      service_failed: ['failed', ['stop_session']],
      disconnect_timeout: ['failed', ['stop_session']],
    },
    running: {
      no_output_timeout: ['cancelling', ['dispatch_cancel_request']],
      drain_timeout: ['cancelling', ['dispatch_cancel_request']],
      fault_unreleased: ['cancelling', ['dispatch_cancel_request']],
      client_disconnected: ['cancelling', ['dispatch_cancel_request']],
      end_completed: ['recovering', ['archive_if_complete']],
      end_failed: ['failed', []],
      end_cancelled: ['cancelled', []],
      service_failed: ['failed', ['stop_session']],
      disconnect_timeout: ['failed', ['stop_session']],
      restart_unproven: ['failed', ['stop_session']],
    },
    recovering: {
      no_output_timeout: ['cancelling', ['dispatch_cancel_request']],
      drain_timeout: ['cancelling', ['dispatch_cancel_request']],
      fault_unreleased: ['cancelling', ['dispatch_cancel_request']],
      archive_saved: ['completed', []],
      persistence_failed: ['failed', []],
      service_failed: ['failed', ['stop_session']],
      disconnect_timeout: ['failed', ['stop_session']],
      restart_unproven: ['failed', ['stop_session']],
    },
    cancelling: {
      cancel_timeout: ['failed', ['stop_session']],
      service_failed: ['failed', ['stop_session']],
      disconnect_timeout: ['failed', ['stop_session']],
      restart_unproven: ['failed', ['stop_session']],
    },
    completed: { late_data: ['completed', ['handle_late_request_data']] },
    failed: { late_data: ['failed', ['handle_late_request_data']] },
    cancelled: { late_data: ['cancelled', ['handle_late_request_data']] },
  };
  return rule('requests', rules, state, event);
}

const normalInstanceStates = ['starting', 'loading', 'connectable', 'ready', 'stopping', 'stopped'] as const;
const activeInstanceStates = normalInstanceStates.slice(0, -1);

function instanceTransition(state: string, event: string, context: TransitionContext): TransitionResult {
  if (state === 'none' && event === 'create') return { state: 'starting', effects: [] };
  if (state === 'stopped' && event === 'late_activity') {
    return { state: 'stopped', effects: ['dispatch_late_cleanup'] };
  }
  if (event !== 'report' || typeof context.reportedState !== 'string') {
    if (event === 'report') throw new Error('instances report requires reportedState');
    throw new Error(`Illegal instances transition: ${state} + ${event}`);
  }

  let reported = context.reportedState;
  if (
    context.bootChanged === true
    && reported !== 'stopped'
    && state !== 'failed'
    && state !== 'cleanup_required'
  ) reported = 'cleanup_required';

  let legal = false;
  if (activeInstanceStates.includes(state as (typeof activeInstanceStates)[number])) {
    if (reported === 'failed' || reported === 'cleanup_required') legal = true;
    else {
      const from = normalInstanceStates.indexOf(state as (typeof normalInstanceStates)[number]);
      const to = normalInstanceStates.indexOf(reported as (typeof normalInstanceStates)[number]);
      legal = to >= from;
    }
  } else if (state === 'failed' || state === 'cleanup_required') {
    legal = reported === state || reported === 'stopping' || reported === 'stopped';
  }
  if (!legal) throw new Error(`Illegal instances transition: ${state} + ${event}`);

  if (reported === state) return { state, effects: [] };
  if (reported === 'failed' || reported === 'cleanup_required') {
    return { state: reported, effects: ['handle_instance_failure'] };
  }
  if (reported === 'stopped') return { state: reported, effects: ['handle_instance_stopped'] };
  return { state: reported, effects: [] };
}

const stopCauses = new Set([
  'user',
  'startup_failure',
  'service_failure',
  'service_offline',
  'cancel_timeout',
  'reconcile_failure',
]);

function sessionTransition(state: string, event: string, context: TransitionContext): TransitionResult {
  if (state === 'stopping' && (event === 'all_instances_stopped' || event === 'stop_timeout')) {
    if (typeof context.stopCause !== 'string' || !stopCauses.has(context.stopCause)) {
      throw new Error('sessions stopping transition requires a valid stopCause');
    }
    return {
      state: context.stopCause === 'user' ? 'ended' : 'failed',
      effects: event === 'all_instances_stopped'
        ? ['release_confirmed_devices']
        : ['mark_uncleared_devices'],
    };
  }
  return rule('sessions', sessionRules, state, event);
}

function deviceTransition(state: string, event: string, context: TransitionContext): TransitionResult {
  if (state === 'offline' && event === 'remove') {
    if (context.confirmUnavailable !== true) {
      throw new Error('devices remove requires confirmUnavailable=true');
    }
    return { state: 'removed', effects: ['finalize_removed_device'] };
  }
  if (state !== 'removed' && event === 'reconciled') {
    if (typeof context.reserved !== 'boolean' || typeof context.cleanup !== 'boolean') {
      throw new Error('devices reconciled requires reserved and cleanup evidence');
    }
    if (context.cleanup) {
      return { state: 'cleanup_required', effects: ['dispatch_device_cleanup'] };
    }
    return { state: context.reserved ? 'occupied' : 'idle', effects: [] };
  }
  if (state !== 'removed' && event === 'cleanup_needed') {
    return state === 'offline'
      ? { state: 'offline', effects: [] }
      : { state: 'cleanup_required', effects: ['dispatch_device_cleanup'] };
  }
  if (state !== 'removed' && event === 'heartbeat_timeout') {
    if (state === 'offline') throw new Error(`Illegal devices transition: ${state} + ${event}`);
    return { state: 'offline', effects: ['handle_device_offline'] };
  }
  const rules: Rules = {
    none: { enroll: ['idle', []] },
    idle: { reserve: ['occupied', []] },
    occupied: { instances_stopped: ['idle', ['release_device_reservations']] },
    cleanup_required: {
      instances_stopped: ['idle', ['release_device_reservations']],
      recheck_clear: ['idle', ['release_device_reservations']],
      recheck_residual: ['cleanup_required', []],
      recheck_timeout: ['cleanup_required', []],
    },
  };
  return rule('devices', rules, state, event);
}

const archiveRules: Rules = {
  pending: {
    save: ['saved', ['confirm_request_recorded']],
    fail: ['failed', ['retain_device_buffer']],
  },
};

export function transition(
  table: StateTable,
  state: string,
  event: string,
  context: TransitionContext = {},
): TransitionResult {
  switch (table) {
    case 'enrollment_tokens': return rule(table, enrollmentRules, state, event);
    case 'devices': return deviceTransition(state, event, context);
    case 'connection_tests': return rule(table, testRules, state, event);
    case 'sessions': return sessionTransition(state, event, context);
    case 'instances': return instanceTransition(state, event, context);
    case 'requests': return requestTransition(state, event, context);
    case 'archives': return rule(table, archiveRules, state, event);
    case 'commands': return rule(table, commandRules, state, event);
    default: throw new Error(`Unknown state machine: ${String(table)}`);
  }
}
