// What a device can do, read from its probe (docs/API.md). The summary names only the
// two roles of this version: the Mac serves with MLX, a Linux machine with an
// NVIDIA GPU helps with llama.cpp. Everything else the probe found stays in the details.
import type {Inventory} from '@/api/types';
import {formatBytes} from '@/lib/format';

export type DeviceView = {
  /** One line per role this device can take. */
  roles: string[];
  /** Why it can take no role, when `roles` is empty. */
  blocked: string | null;
  system: string;
  memory: string;
  gpus: string | null;
  /** The raw probe, for a section that starts closed. */
  details: {system: string; engines: string[]; interpreters: string[]; addresses: string[]; agent: string; prepared: string[]};
};

const SERVICE_ENGINE = {name: 'mlx', label: 'MLX'};
const HELPER_ENGINE = {name: 'llama.cpp', label: 'llama.cpp'};

function hasEngine(inventory: Inventory, name: string): boolean {
  return inventory.engines.some((e) => e.name === name && e.available);
}

function gpuText(gpu: Inventory['gpus'][number]): string {
  return `${gpu.model} ${formatBytes(gpu.total_bytes)}`;
}

function rolesOf(inventory: Inventory): {roles: string[]; blocked: string | null} {
  if (inventory.os === 'darwin') {
    return hasEngine(inventory, SERVICE_ENGINE.name)
      ? {roles: [`Can be the server (${SERVICE_ENGINE.label})`], blocked: null}
      : {roles: [], blocked: `${SERVICE_ENGINE.label} was not found on this Mac.`};
  }
  const gpu = inventory.gpus.find((g) => g.vendor === 'NVIDIA');
  if (!gpu) return {roles: [], blocked: 'A helper needs an NVIDIA GPU.'};
  return hasEngine(inventory, HELPER_ENGINE.name)
    ? {roles: [`Can be a helper (${HELPER_ENGINE.label}, ${gpuText(gpu)})`], blocked: null}
    : {roles: [], blocked: `${HELPER_ENGINE.label} was not found on this machine.`};
}

const OS_NAME: Record<string, string> = {darwin: 'macOS', linux: 'Linux'};

export function describeDevice(inventory: Inventory): DeviceView {
  return {
    ...rolesOf(inventory),
    system: [OS_NAME[inventory.os] ?? inventory.os, inventory.os === 'darwin' ? inventory.cpu_model : inventory.arch].join(' · '),
    memory: formatBytes(inventory.memory_total_bytes),
    gpus: inventory.gpus.length ? inventory.gpus.map((g) => `${g.model} · ${formatBytes(g.total_bytes)}`).join(', ') : null,
    details: {
      system: `${inventory.os} ${inventory.arch} · ${inventory.machine_model} · ${inventory.cpu_model}`,
      engines: inventory.engines.map((e) => `${e.name}: ${e.available ? 'found' : e.error?.message ?? 'not found'}`),
      interpreters: inventory.python_executables.map((p) => `${p.purpose}: ${p.path} (${p.version})`),
      addresses: inventory.addresses.map((a) => `${a.address} (${a.interface})`),
      agent: `${inventory.agent_version} · ${inventory.openinfer_revision.slice(0, 12)}`,
      prepared: inventory.prepared_versions.map((v) => v.version_id),
    },
  };
}
