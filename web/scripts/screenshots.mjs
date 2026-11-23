// Screenshots of the app on the fake backend at desktop and phone width, light and dark, on a vite dev server
// at a free local port. Every shot also fails if anything overflows sideways.
// Usage: node scripts/screenshots.mjs <output directory> <step1|step2|fix|api|help>
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {chromium} from 'playwright-core';
import {createServer} from 'vite';
import {checkedText, findLeak} from './leaks.mjs';

const [out, step = 'step1'] = process.argv.slice(2);
if (!out) throw new Error('Usage: node scripts/screenshots.mjs <output directory> <step1|step2|fix|api|help>');
const WIDTHS = [{width: 1280, height: 900}, {width: 390, height: 844}];
const SCHEMES = ['light', 'dark'];


function findChromium() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const cache = path.join(os.homedir(), 'Library/Caches/ms-playwright');
  for (const dir of fs.existsSync(cache) ? fs.readdirSync(cache).sort().reverse() : []) {
    if (!dir.startsWith('chromium_headless_shell-')) continue;
    const exe = path.join(cache, dir, 'chrome-headless-shell-mac-arm64', 'chrome-headless-shell');
    if (fs.existsSync(exe)) return exe;
  }
  throw new Error('No Chromium found. Set CHROMIUM_PATH.');
}

const STEP1 = [
  ['sign-in', async (p) => { await p.open('?signed-out#/devices'); await p.page.getByRole('button', {name: 'Sign in'}).waitFor(); }],
  ['sign-in-error', async (p) => {
    await p.open('?signed-out#/devices');
    await p.page.fill('#email', 'owner@example.com');
    await p.page.fill('#password', 'wrong-password-123');
    await p.page.click('button[type=submit]');
    await p.page.getByText('Wrong email or password.').waitFor();
  }],
  ['register', async (p) => { await p.open('?signed-out#/devices'); await p.page.getByRole('button', {name: 'Create an account'}).click(); }],
  ['devices', async (p) => { await p.open('#/devices'); await p.page.getByText('Can be the server (MLX)').waitFor(); }],
  ['devices-details', async (p) => {
    await p.open('#/devices');
    await p.page.getByText('Can be a helper', {exact: false}).waitFor();
    await p.page.getByTestId('device-helper').getByText('Details').click();
  }],
  ['devices-token', async (p) => {
    await p.open('#/devices');
    await p.page.fill('#device-name', 'helper-gpu');
    await p.page.getByRole('button', {name: 'Create token'}).click();
    await p.page.getByText('One-time token').waitFor();
  }],
  ['wizard-devices', async (p) => {
    await p.open('#/sessions/new');
    await p.page.getByText('Choose devices').waitFor();
    await p.page.selectOption('#service', 'mac');
    await p.page.selectOption('#helper', 'helper');
  }],
  ['wizard-version', async (p) => {
    await p.toVersion('');
  }],
  ['preflight-passed', async (p) => { await p.toPreflight(''); }],
  ['preflight-passed-open', async (p) => {
    await p.toPreflight('');
    await p.page.getByText('Show 21 passed checks').click();
  }],
  ['preflight-failed', async (p) => { await p.toPreflight('?preflight=fail'); }],
];

const fakeCall = (p, code) => p.page.evaluate(code);
const STEP2 = [
  ['sessions', async (p) => { await p.open('?reserve=ready#/sessions'); await p.page.getByText('Recent sessions').waitFor(); }],
  ['session-starting', async (p) => { await p.open('?reserve=starting#/sessions/starting'); await p.page.getByTestId('startup-service').waitFor(); }],
  ['session-warmup', async (p) => { await p.open('?reserve=warming#/sessions/warming'); await p.page.getByTestId('startup-warmup').waitFor(); }],
  ['session-finished', async (p) => { await p.open('?reserve=ready#/sessions/ready'); await p.page.getByText('Output complete').waitFor(); }],
  ['session-form', async (p) => {
    await p.open('?reserve=ready#/sessions/ready');
    await p.page.getByRole('button', {name: 'New request'}).click();
    await p.page.fill('#prompt', 'Write a Python function that returns the nth Fibonacci number.');
  }],
  ['session-streaming-degraded', async (p) => { await p.open('?reserve=degraded#/sessions/degraded'); await p.page.getByText(/quicksort/).waitFor(); }],
  ['session-helper-offline', async (p) => {
    await p.open('?reserve=ready#/sessions/ready');
    await p.page.getByText('Output complete').waitFor();
    await fakeCall(p, () => window.fake.updateDevice('helper', {state: 'offline'}));
    await p.page.getByText(/lost its control connection/).waitFor();
  }],
  ['session-disconnected', async (p) => {
    await p.open('?reserve=ready#/sessions/ready');
    await p.page.getByText('Output complete').waitFor();
    await p.page.getByRole('button', {name: 'New request'}).click();
    await fakeCall(p, () => { window.fake.withholdSnapshot = true; window.fake.dropSockets(); });
    await p.page.getByText(/Connection lost/).waitFor();
  }],
  ['session-refused', async (p) => {
    await p.open('?reserve=ready#/sessions/ready');
    await p.page.getByText('Output complete').waitFor();
    await fakeCall(p, () => window.fake.dropSockets(4403));
    await p.page.getByText(/Connection closed/).waitFor();
  }],
  ['session-stopping', async (p) => { await p.open('?reserve=stopping#/sessions/stopping'); await p.page.getByText(/Asking processes/).waitFor(); }],
  ['session-start-failed', async (p) => { await p.open('#/sessions/start-failed'); await p.page.getByText(/ran out of GPU memory/).waitFor(); }],
  ['session-ended', async (p) => { await p.open('#/sessions/ended'); await p.page.getByText(/engine on the server exited/).waitFor(); }],
  ['wizard-version-names', async (p) => {
    await p.toVersion('');
    await p.page.selectOption('#version', 'helper-small');
  }],
  ['preflight-unverified', async (p) => {
    await p.toPreflight('?unverified');
    await p.page.getByTestId('preflight-notices').waitFor();
  }],
  ['preflight-version-names', async (p) => { await p.toPreflight(''); }],
  ['devices-cleanup', async (p) => { await p.open('?cleanup#/devices'); await p.page.getByText(/Process group/).waitFor(); }],
  ['preflight-call-failed', async (p) => {
    await p.toVersion('');
    await fakeCall(p, () => window.fake.failNext('POST /sessions/preflight', 500,
      {code: 'internal', message: 'The database did not answer; check again in a moment.', field: null, device_id: null, phase: 'preflight', retryable: true}));
    await p.page.selectOption('#version', 'helper-small');
    await p.page.getByRole('button', {name: 'Check this version'}).click();
    await p.page.getByText(/database did not answer/).waitFor();
  }],
];

const FIX = [
  ['session-starting', async (p) => { await p.open('?reserve=starting#/sessions/starting'); await p.page.getByTestId('startup-service').waitFor(); }],
  ['session-waiting', async (p) => { await p.open('?reserve=waiting#/sessions/waiting'); await p.page.getByText('Waiting for the server').waitFor(); }],
  ['session-connecting', async (p) => { await p.open('?reserve=connecting#/sessions/connecting'); await p.page.getByText('Loading and connecting').waitFor(); }],
  ['session-warmup', async (p) => { await p.open('?reserve=warming#/sessions/warming'); await p.page.getByTestId('startup-warmup').waitFor(); }],
  ['session-finished', async (p) => { await p.open('?reserve=ready#/sessions/ready'); await p.page.getByText('Output complete').waitFor(); }],
  ['devices', async (p) => { await p.open('#/devices'); await p.page.getByText('Can be the server (MLX)').waitFor(); }],
  ['devices-details', STEP1.find(([n]) => n === 'devices-details')[1]],
  ['devices-stale-test', async (p) => { await p.open('?stale-test#/devices'); await p.page.getByText(/No longer valid/).waitFor(); }],
];

// The API keys page. Its example code blocks show API field names on purpose and are the only text the leak
// check skips (data-leak-exempt); the rest of the page is checked as usual.
const API = [
  ['api-keys', async (p) => { await p.open('#/api-keys'); await p.page.getByText('editor plugin').waitFor(); await p.page.getByTestId('api-usage').waitFor(); }],
];

// The places where a new user needs help: a long first download, a test that no longer counts, a device token, the
// certificate path and closed registration.
const HELP = [
  ['session-download', async (p) => {
    await p.open('?reserve=downloading#/sessions/downloading');
    await p.page.getByRole('progressbar').waitFor();
    // A second report 10 s after the first, at 14.3 MB/s: the speed and the time left appear.
    await fakeCall(p, () => window.fake.updateInstance('downloading', 'helper', {phase: 'download',
      progress: {completed_bytes: '6263000000', total_bytes: '18702184960', at: new Date().toISOString()}}));
    await p.page.getByText(/MB\/s/).waitFor();
  }],
  ['wizard-retest', async (p) => {
    await p.open('?stale-test#/sessions/new');
    await p.page.getByText('Choose devices').waitFor();
    await p.page.selectOption('#service', 'mac');
    await p.page.selectOption('#helper', 'helper');
    await p.page.getByRole('button', {name: 'Test both directions again'}).waitFor();
  }],
  ['devices-token', STEP1.find(([n]) => n === 'devices-token')[1]],
  ['api-keys', async (p) => {
    await p.open('?certificate=~/openinfer/tls.crt#/api-keys');
    await p.page.getByText('~/openinfer/tls.crt').waitFor();
  }],
  ['register-closed', async (p) => {
    await p.open('?signed-out&registration=closed#/devices');
    await p.page.getByRole('button', {name: 'Create an account'}).click();
    await p.page.getByTestId('registration-closed').waitFor();
  }],
];

const SCENES = {step1: STEP1, step2: STEP2, fix: FIX, api: API, help: HELP};

const server = await createServer({server: {host: '127.0.0.1', port: 0}, logLevel: 'error'});
await server.listen();
const base = server.resolvedUrls.local[0];
const browser = await chromium.launch({executablePath: findChromium()});
fs.mkdirSync(out, {recursive: true});
let failures = 0;
const pageErrors = [];

for (const scheme of SCHEMES) {
  for (const viewport of WIDTHS) {
    const context = await browser.newContext({viewport, colorScheme: scheme, deviceScaleFactor: 2});
    const page = await context.newPage();
    page.on('pageerror', (e) => pageErrors.push(String(e)));
    const p = {
      page,
      async open(suffix) {
        await page.goto(`${base}preview.html${suffix}`);
        await page.reload();
        await page.waitForTimeout(300);
      },
      // Choosing the devices runs the checks with the version Placement chose; changing the version is optional.
      async toPreflight(query) {
        await this.open(`${query}#/sessions/new`);
        await page.getByText('Choose devices').waitFor();
        await page.selectOption('#service', 'mac');
        await page.selectOption('#helper', 'helper');
        await page.getByRole('button', {name: 'Continue'}).click();
        await page.getByRole('progressbar').waitFor();
      },
      async toVersion(query) {
        await this.toPreflight(query);
        await page.getByRole('button', {name: 'Change version'}).click();
        await page.locator('#version').waitFor();
      },
    };
    for (const [name, run] of SCENES[step]) {
      await run(p);
      await page.waitForTimeout(200);
      const result = await page.evaluate(() => ({
        viewport: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
      }));
      // Visible text only (innerText skips a closed Details section), without the marked code blocks: no task numbers,
      // paths or raw probe.
      const leak = name === 'devices-details' ? null : findLeak(await page.evaluate(checkedText, await page.$('body')));
      const ok = result.scrollWidth <= result.viewport && leak === null;
      const file = `${scheme}-${viewport.width}-${name}.png`;
      console.log(`${ok ? 'ok  ' : 'FAIL'} ${file}: scrollWidth=${result.scrollWidth} viewport=${result.viewport}${leak ? ` shows "${leak}"` : ''}`);
      if (!ok) failures += 1;
      await page.screenshot({path: path.join(out, file), fullPage: true});
    }
    await context.close();
  }
}

await browser.close();
await server.close();
if (pageErrors.length) console.log(`page errors: ${pageErrors.join('; ')}`);
if (failures || pageErrors.length) process.exit(1);
console.log(`Saved ${SCHEMES.length * WIDTHS.length * SCENES[step].length} screenshots to ${out}.`);
