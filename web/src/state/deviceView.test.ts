import {describe, expect, it} from 'vitest';
import {makeInventory} from '@/test/factories';
import {describeDevice} from './deviceView';

const GiB = 2 ** 30;

// Probes shaped like real ones: extra engines, absolute interpreter paths in errors.
const helperInventory = makeInventory('linux', {
  machine_model: '30E1SPR000',
  memory_total_bytes: String(Math.round(125.7 * GiB)),
  gpus: [{id: '0', model: 'RTX A5000', vendor: 'NVIDIA', total_bytes: String(24 * GiB), available_bytes: String(19.5 * GiB),
          compute_tflops: null, bandwidth_gbps: null, driver: '550'}],
  engines: [
    {name: 'sglang', version: null, available: true, build: null, error: null},
    {name: 'mlx', version: null, available: false, build: null,
     error: {code: 'engine_missing', message: 'not installed in /opt/openinfer/envs/helper/bin/python: mlx, mlx_lm', field: null, device_id: null, phase: null, retryable: false}},
    {name: 'llama.cpp', version: null, available: true, build: null, error: null},
    {name: 'ngram', version: null, available: true, build: null, error: null},
  ],
});
const macInventory = makeInventory('mac', {
  gpus: [{id: '0', model: 'Apple M2 Pro', vendor: 'Apple', total_bytes: String(32 * GiB), available_bytes: String(22 * GiB),
          compute_tflops: null, bandwidth_gbps: null, driver: null}],
  engines: [
    {name: 'sglang', version: null, available: false, build: null,
     error: {code: 'engine_missing', message: 'not installed in /opt/openinfer/envs/mlx/bin/python: sglang', field: null, device_id: null, phase: null, retryable: false}},
    {name: 'mlx', version: '0.32.3', available: true, build: null, error: null},
    {name: 'llama.cpp', version: null, available: true, build: null, error: null},
  ],
});

function visible(view: ReturnType<typeof describeDevice>): string {
  return JSON.stringify([view.roles, view.blocked, view.system, view.memory, view.gpus]);
}

describe('device view', () => {
  it('says a Mac with MLX can be the server', () => {
    const view = describeDevice(macInventory);
    expect(view.roles).toEqual(['Can be the server (MLX)']);
    expect(view.blocked).toBeNull();
  });

  it('says a Linux machine with an NVIDIA GPU and llama.cpp can be a helper, naming the GPU', () => {
    const view = describeDevice(helperInventory);
    expect(view.roles).toEqual(['Can be a helper (llama.cpp, RTX A5000 24.0 GiB)']);
  });

  it('shows memory and GPU', () => {
    expect(describeDevice(helperInventory).memory).toBe('125.7 GiB');
    expect(describeDevice(helperInventory).gpus).toBe('RTX A5000 · 24.0 GiB');
    expect(describeDevice(macInventory).gpus).toBe('Apple M2 Pro · 32.0 GiB');
    expect(describeDevice(makeInventory('mac')).gpus).toBeNull();
  });

  it('keeps paths and engines unrelated to the roles out of the summary', () => {
    for (const inventory of [helperInventory, macInventory]) {
      const text = visible(describeDevice(inventory));
      expect(text).not.toMatch(/\//);
      expect(text).not.toMatch(/sglang|ngram|not installed/i);
    }
  });

  it('says why a device cannot take a role', () => {
    const noMlx = makeInventory('mac', {engines: []});
    expect(describeDevice(noMlx).roles).toEqual([]);
    expect(describeDevice(noMlx).blocked).toBe('MLX was not found on this Mac.');
    const noGpu = makeInventory('linux', {gpus: []});
    expect(describeDevice(noGpu).blocked).toBe('A helper needs an NVIDIA GPU.');
    const noEngine = makeInventory('linux', {engines: []});
    expect(describeDevice(noEngine).blocked).toBe('llama.cpp was not found on this machine.');
  });

  it('keeps the raw probe for the details section', () => {
    const view = describeDevice(helperInventory);
    expect(view.details.engines).toContain('mlx: not installed in /opt/openinfer/envs/helper/bin/python: mlx, mlx_lm');
    expect(view.details.engines).toContain('sglang: found');
  });
});
