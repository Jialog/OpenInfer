// The simulator's program: it reads the device descriptions, connects the devices enrolled in an earlier run, and takes
// commands on its terminal (Fleet.command).
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { localOrigin } from '../../server/src/config.ts';
import { Fleet, HELP, readAnswer, readDevices } from './device.ts';

const root = (path: string) => fileURLToPath(new URL(`../../${path}`, import.meta.url));
const { values } = parseArgs({ options: {
  url: { type: 'string', default: localOrigin(process.env) },
  cert: { type: 'string', default: process.env.OPENINFER_TLS_CERT ?? root('data/tls.crt') },
  devices: { type: 'string', default: root('simulator/devices.json') },
  state: { type: 'string', default: root('data/simulator.json') },
  seed: { type: 'boolean', default: false },
  email: { type: 'string', default: 'demo@example.com' },
} });

const say = (line: string) => { if (line) console.log(line); };
const stamped = (line: string) => console.log(`[${new Date().toLocaleTimeString('en-GB')}] ${line}`);
const ca = await readFile(values.cert).catch(() => null);
if (!ca) {
  console.error(`The server's certificate is not at ${values.cert}. Start the server first (npm run demo); it makes the certificate.`);
  process.exit(1);
}
const specs = await readDevices(values.devices);
const fleet = new Fleet(specs, { url: values.url, ca, answer: await readAnswer(root('simulator/answer.txt')), statePath: values.state, log: stamped });
await fleet.start();
if (values.seed) say(await fleet.seed(values.email).catch((error: Error) => `Could not seed the demo account: ${error.message || `no answer from ${values.url}; is the server running (npm run demo)?`}`));

say(`Simulated devices for ${values.url}. Their speeds are settings in ${values.devices}, not measurements.\n`);
say(fleet.list());
say(`\nCommands:\n${HELP}\n`);
for (const spec of specs) for (const event of spec.timeline ?? []) setTimeout(() => { stamped(`timeline: ${event.event} ${spec.name}`); void fleet.command(`${event.event} ${spec.name}`).then(say); }, event.at_seconds * 1000);

const terminal = createInterface({ input: process.stdin, output: process.stdout, prompt: '> ' });
// `quit` and Ctrl-C stop the simulator; the end of its input alone does not, so it can also run without a terminal
const quit = () => { fleet.close(); process.exit(0); };
terminal.on('line', (line) => {
  if (line.trim() === 'quit') quit();
  else void fleet.command(line).then((reply) => { say(reply); terminal.prompt(); });
});
terminal.on('SIGINT', quit);
process.on('SIGTERM', quit);
terminal.prompt();
