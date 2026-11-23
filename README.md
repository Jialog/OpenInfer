# OpenInfer: the website and its server, with simulated devices

OpenInfer lets several devices work on one request to a language model: one device serves the model, and a helper device writes part of the answer ahead of it, so the text arrives faster. This repository holds the website and the server behind it:

- `web/`: the website (React, TypeScript, Tailwind CSS).
- `server/`: the server (Express, a REST API, WebSockets, PostgreSQL, an S3-compatible bucket).
- `simulator/`: simulated inference devices.
- [`docs/API.md`](docs/API.md): the server's API, with a complete example in `curl`.

**The devices here are simulated.** No model runs. A simulated device is a small program that speaks the same protocol as a real one: it enrols, reports the hardware written for it in `simulator/devices.json`, shows a download, loads, streams a fixed text, and can drop off and come back. Its download and load times, its speeds and the share of tokens the helper writes are settings in that file, not measurements. Everything else is real: the accounts, the database, the REST API, the live updates, the stored results.

## Run it

You need Node.js 22.18 or newer and `openssl`.

```sh
npm install                  # installs the three parts
npm run demo                 # terminal 1: the server and the website, at https://localhost:8443
npm run devices -- --seed    # terminal 2: the simulated devices, enrolled into a demo account
```

`npm run demo` makes what it needs on the first start, under `./data`: a self-signed certificate for `localhost` and a PostgreSQL database of its own. Your browser warns about the certificate once; continue to the page (or trust `data/tls.crt` on your machine). Delete `./data` to start again from nothing.

`npm run devices -- --seed` creates the account `demo@example.com`, prints its password once, and enrols the two described devices into it: a Mac that serves and a GPU machine that helps. Sign in with that account and you will find both on the Devices page.

To add the devices to an account of your own instead, run `npm run devices` without `--seed`, create a token under "Add a device" on the Devices page, and type `enroll mac <token>` (then `enroll gpu <token>`) in the simulator's terminal.

## What to try

1. On the Devices page, run the connection test from the GPU machine to the Mac.
2. Under Sessions, start a new session with both devices: the checks pass, both devices show their download, load, and the session becomes ready.
3. Send a request. The text streams in; when it ends the page shows the speed and how many tokens the helper wrote.
4. Instead of typing a prompt, choose a `.txt` or `.md` file under "Prompt from a file". The file is uploaded to the storage bucket, the request reads its prompt from it, and the request keeps a link to the file. When the request has ended, "Download result" saves its result, the object the server wrote to the bucket.
5. In the simulator's terminal type `leave gpu`. The session becomes degraded, and the next request arrives at the speed of the Mac alone. Type `join gpu`, press "Reconnect helper", and the faster speed returns.

The simulator's commands:

| Command | What happens |
| --- | --- |
| `enroll <device> <token>` | enrols a device with a token from the website |
| `leave <device>` | the device drops off the network |
| `join <device>` | the device comes back |
| `fail <device>` | the engine process on the device exits |
| `list` | the devices and what they run |
| `quit` | stops the simulator |

## Storage

Two kinds of files are stored as objects in an S3-compatible bucket: each request's result (`requests/<request id>.json`) and each uploaded prompt file (`files/<file id>`). The database records which user uploaded a file and which request used it.

The bucket is configured in `.env` (copy `.env.example`): `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` and, if your service needs it, `S3_REGION`. The bucket must exist. Without these settings the server keeps the objects in the memory of its own process until it stops, which is enough to try everything but stores nothing. It says so when it starts, and the website says so where a file is uploaded and where files are downloaded. After a restart the records are still in the database but the objects are gone, and a download answers that the file is no longer stored.

## Tests

```sh
npm test
```

runs the server's tests (with a real PostgreSQL from the `embedded-postgres` package), the simulator's test against the real server, and the website's tests.
