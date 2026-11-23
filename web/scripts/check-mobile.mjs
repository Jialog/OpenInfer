// Opens every page at phone width in a real browser and fails if anything overflows sideways. jsdom has no
// layout, so component tests cannot check this. Uses a Chromium already on the machine: set CHROMIUM_PATH,
// or it looks in the Playwright cache. Pass a directory as the first argument to save screenshots.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {chromium} from 'playwright-core';
import {createServer} from 'vite';

const WIDTH = 360;
const shots = process.argv[2];

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

const server = await createServer({server: {host: '127.0.0.1', port: 0}, logLevel: 'error'});
await server.listen();
const base = server.resolvedUrls.local[0];
const browser = await chromium.launch({executablePath: findChromium()});
const page = await browser.newPage({viewport: {width: WIDTH, height: 740}});
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e)));

let failures = 0;
async function check(name) {
  await page.waitForTimeout(150);
  const result = await page.evaluate(() => {
    const viewport = document.documentElement.clientWidth;
    const offenders = [...document.querySelectorAll('body *')]
      .filter((el) => {
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && (rect.right > viewport + 0.5 || rect.left < -0.5);
      })
      .slice(0, 5)
      .map((el) => `${el.tagName.toLowerCase()}.${String(el.className).slice(0, 60)}`);
    return {viewport, scrollWidth: document.documentElement.scrollWidth, offenders};
  });
  const ok = result.scrollWidth <= result.viewport && result.offenders.length === 0;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: scrollWidth=${result.scrollWidth} viewport=${result.viewport}${ok ? '' : ` ${result.offenders.join(' | ')}`}`);
  if (!ok) failures += 1;
  if (shots) {
    fs.mkdirSync(shots, {recursive: true});
    await page.screenshot({path: path.join(shots, `${name}.png`), fullPage: true});
  }
}

async function open(suffix) {
  // Long unbroken names everywhere, unless the suffix already sets the query.
  await page.goto(`${base}preview.html${suffix.startsWith('?') ? suffix : `?stress${suffix}`}`);
  await page.reload();
  await page.waitForTimeout(300);
}

await open('?signed-out&stress#/devices');
await check('sign-in');
await page.fill('#email', `${'x'.repeat(60)}@example.com`);
await page.fill('#password', 'wrong-password-123');
await page.click('button[type=submit]');
await check('sign-in-error');

await open('#/devices');
await check('devices');
await page.fill('#device-name', 'x'.repeat(80));
await page.getByRole('button', {name: 'Create token'}).click();
await page.getByText('One-time token').waitFor();
await check('enrollment-token');

await open('#/sessions');
await check('sessions');

await open('#/sessions/new');
await page.getByText('Choose devices').waitFor();
await check('wizard-devices');
await page.selectOption('#service', 'mac');
await page.selectOption('#helper', 'helper');
await page.getByRole('button', {name: 'Continue'}).click();
await page.getByRole('progressbar').waitFor();
await page.getByRole('button', {name: 'Change version'}).click();
await check('wizard-version');
await page.selectOption('#version', 'helper-v2');
await page.getByRole('button', {name: 'Check this version'}).click();
await page.getByText('Not enough room').waitFor();
await check('wizard-preflight');

await open('#/sessions/starting-session');
await check('session-starting');
await open('#/sessions/ready-session');
await page.getByTestId('output').waitFor();
await check('session-output');
await page.getByTestId('thinking').first().locator('summary').click();
await check('session-thinking');
await page.getByTestId('request-history').getByRole('button', {name: /API/}).click();
await page.getByTestId('history-output').waitFor();
await check('session-history');
await page.evaluate(() => {
  window.fake.finishRequest(window.previewRequestId, {state: 'failed', error: {code: 'x', message: 'y'.repeat(300), field: null, device_id: null, phase: 'serve', retryable: false}});
});
await check('session-terminal');
await page.getByRole('button', {name: 'New request'}).click();
await check('session-form');

await open('#/api-keys');
await page.getByTestId('api-keys').getByText('Revoked', {exact: true}).waitFor();
await check('api-keys');
await page.getByRole('button', {name: 'Revoke', exact: true}).first().click();
await check('api-key-revoke');
await page.fill('#key-name', 'x'.repeat(80));
await page.getByRole('button', {name: 'Generate key'}).click();
await page.getByText('shown only once', {exact: false}).waitFor();
await check('api-key-created');

await browser.close();
await server.close();
if (pageErrors.length) console.log(`page errors: ${pageErrors.join('; ')}`);
if (failures || pageErrors.length) process.exit(1);
console.log(`All pages fit ${WIDTH} px.`);
