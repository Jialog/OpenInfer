// Preflight checks as the user reads them. The codes are the ones server/src/control.ts check()
// emits (docs/API.md); a code not listed here is shown by its message.
import type {PreflightCheck} from '@/api/types';
import {formatBytes} from '@/lib/format';

export type CheckRow = {
  key: string;
  label: string;
  /** Name of the device the check is about, or null for a check on the whole plan. */
  device: string | null;
  passed: boolean;
  /** One line under the name: byte amounts, or the reason a check failed. */
  detail: string | null;
  /** What the user can do about a failure, when the reason does not already say. */
  remedy: string | null;
};

/** notices: checks that pass but that the user should see, such as an unverified service machine. */
export type PreflightView = {total: number; passed: number; failed: CheckRow[]; notices: CheckRow[]; passedRows: CheckRow[]};

export type PreflightContext = {
  deviceName: (id: string) => string;
  roleOf: (id: string) => 'service' | 'helper' | null;
  /** The preflight left the helper version to Placement and no version fits: the helper's failing memory or disk check
   *  then carries the smallest need of any version (docs/API.md), and a smaller version is no way out. */
  noVersionFits?: boolean;
  /** Whether the device has folders of model files of its own: then its disk check passes and the device checks the bytes
   *  really missing when the session prepares (the server's disk rule, diskFits). */
  localModelFolders?: (id: string) => boolean;
};

type Role = 'service' | 'helper' | null;
type Known = {label: (role: Role, check: PreflightCheck) => string; passedDetail?: string;
               remedy?: (role: Role, check: PreflightCheck, noVersionFits: boolean) => string};

const KNOWN: Record<string, Known> = {
  distinct_devices: {label: () => 'Two different devices'},
  control_online: {label: () => 'Online and free'},
  unsupported_platform: {label: () => 'Platform'},
  hardware_unvalidated: {label: () => 'Hardware'},
  // A Mac without the measured chip may serve; the check passes and says it is unverified.
  hardware_unverified: {label: () => 'Unverified hardware'},
  // The same code is reported per device (is the chosen version fully set up?) and once for the plan
  // (is the choice to run with or without the draft model backed by a complete setup?).
  version_setup_missing: {label: (_role, check) => (check.device_id ? 'Version setup' : 'Draft model setup')},
  role: {label: () => 'Version fits the role'},
  build_match: {label: () => 'Engine build', passedDetail: 'A matching build is already on the device'},
  build_preparation_required: {label: () => 'Engine build', passedDetail: 'Will be prepared when the session starts'},
  capacity_insufficient: {
    label: (role) => (role === 'helper' ? 'GPU memory' : 'Memory'),
    remedy: (role, check, noVersionFits) => role !== 'helper'
      ? 'Close other programs on this machine to free memory, then check again.'
      : noVersionFits
        ? `No helper version fits in the free GPU memory of this card: the smallest needs ${formatBytes(check.required_bytes)}. Free GPU memory on the helper, then check again.`
        : 'Free GPU memory on the helper or choose a smaller helper version.',
  },
  disk_insufficient: {
    label: () => 'Disk',
    remedy: (role, check, noVersionFits) => role === 'helper' && noVersionFits
      ? `No helper version fits in the free disk space: the smallest needs ${formatBytes(check.required_bytes)}. Free disk space on the helper, then check again.`
      : 'Free disk space on this device, then check again.',
  },
  version_compatibility: {label: () => 'Model version'},
  direction_unreachable: {label: () => 'Connection from helper to server'},
  port_busy: {label: () => 'Test port free'},
};

function bytesLine(check: PreflightCheck): string | null {
  if (check.required_bytes === null || check.available_bytes === null) return null;
  return `Needs ${formatBytes(check.required_bytes)}, ${formatBytes(check.available_bytes)} available`;
}

const NOTICES = new Set(['hardware_unverified']);
const LATER_DISK_CHECK = 'This device has model files of its own, so it checks the free disk for the files still missing when the session prepares, before it downloads anything.';

function toRow(check: PreflightCheck, index: number, context: PreflightContext): CheckRow {
  const role = check.device_id ? context.roleOf(check.device_id) : null;
  const known = KNOWN[check.code];
  const bytes = bytesLine(check);
  const row = {
    key: `${check.code}:${check.device_id ?? ''}:${index}`,
    device: check.device_id ? context.deviceName(check.device_id) : null,
    passed: check.passed,
  };
  if (!known) return {...row, label: check.message, detail: bytes, remedy: null};
  if (check.passed && NOTICES.has(check.code)) return {...row, label: known.label(role, check), detail: check.message, remedy: null};
  if (check.passed && check.code === 'disk_insufficient' && check.device_id && context.localModelFolders?.(check.device_id)) {
    return {...row, label: known.label(role, check), detail: LATER_DISK_CHECK, remedy: null};
  }
  if (check.passed) return {...row, label: known.label(role, check), detail: bytes ?? known.passedDetail ?? null, remedy: null};
  // A failure with byte amounts says so in GiB; the server's message then repeats raw byte counts.
  return {
    ...row,
    label: known.label(role, check),
    detail: bytes ?? check.message,
    remedy: bytes && known.remedy ? known.remedy(role, check, context.noVersionFits ?? false) : null,
  };
}

export function describePreflight(checks: PreflightCheck[], context: PreflightContext): PreflightView {
  const rows = checks.map((check, index) => toRow(check, index, context));
  const failed = rows.filter((r) => !r.passed);
  const notice = rows.map((r, index) => r.passed && NOTICES.has(checks[index].code));
  return {total: rows.length, passed: rows.length - failed.length, failed, notices: rows.filter((_, index) => notice[index]),
          passedRows: rows.filter((r, index) => r.passed && !notice[index])};
}
