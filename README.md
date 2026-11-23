# OpenInfer: a web platform for pooling devices for language-model inference

OpenInfer lets a person who owns several computers use them together for one language model. On its website you register your devices, start an inference session in which one device serves the model and another helps it, send requests, and watch the answer and the devices live. While a helper works, the answer streams faster than the serving device could write it alone.

This repository holds the website, the server behind it, and a simulator of inference devices:

- `web/`: the website (React, TypeScript, Tailwind CSS, shadcn/ui).
- `server/`: the server (Express, a REST API, WebSockets, PostgreSQL, an S3-compatible bucket).
- `simulator/`: simulated inference devices.
- [`docs/API.md`](docs/API.md): the server's API, with a complete example in `curl`.

**The devices here are simulated.** No model runs. A simulated device is a small program that speaks the same protocol as a real one: it enrols, reports the hardware written for it in `simulator/devices.json`, shows a download, loads, streams a fixed text, and can drop off and come back. Its download and load times, its speeds and the share of tokens the helper writes are settings in that file, not measurements. Everything else is real: the accounts, the database, the REST API, the live updates, the stored results. This is the "mock backend behind the same interface" of the project plan: the server talks to the simulated devices exactly as it would to real ones.

## A Mac that answers faster with a helper

The demo plays one scenario. A Mac serves the model. A desktop PC with an NVIDIA GPU joins the session as a helper and writes part of the answer ahead of the Mac, so the text arrives faster. When the helper leaves, the Mac keeps serving on its own, at its own speed; when the helper comes back, the faster speed returns.

The speeds below are the **simulator's settings** in `simulator/devices.json`, not measurements of real hardware:

| | Output speed | Share of the output written by the helper |
| --- | --- | --- |
| Mac alone | 20 tokens/s | none |
| Mac with the GPU helper | 45 tokens/s (2.25 times as fast) | 55% |

In both cases the first token comes 0.8 s after the request reaches the Mac.

To see it, start the demo (see [Run it](#run-it)), start a session with both devices and send a request: the page shows the speed and how many tokens the helper wrote. Then type `leave gpu` in the simulator's terminal and send the same request again: it streams at the Mac's own speed. Steps 3 and 5 of [What to try](#what-to-try) walk through it.

## Motivation

Open-source language models have made it possible for individuals to run capable models on their own hardware. A single consumer GPU, or a laptop with enough unified memory, can serve a quantized model at usable speed, and a research lab or a small team often owns several such machines.

These resources are scattered. One person has a workstation with two GPUs, another a laptop, a third a server that is idle at night. Each device has its own drivers, supports its own quantization formats, and is available at its own times. Together they could serve larger models, or serve one model faster, than any one of them alone, but nothing ties them together.

Pooling heterogeneous devices with existing inference engines is possible but tedious. Someone has to write and update configuration files, track which machine holds which model, decide which device serves and which ones help, and restart everything by hand when a device goes offline. This takes systems expertise that many users do not have, and it does not scale past a handful of machines.

OpenInfer is for researchers, developers and small teams who own several devices and want to pool them for inference. It gives them a website where they register their devices, configure a collaborative inference session through a graphical interface, send requests, and watch them run. The inference itself is done by an inference engine on each device; OpenInfer removes the manual orchestration around it.

## Objectives and features

The project has four objectives, following the path a user takes from signing up to reading a result. Under each, what the website does today.

### 1. User and group management

The plan: users register with an email address and a password, log in, and form groups for a lab or a team; a group owner invites other users by email; membership decides which devices and sessions a user can see and act on.

Today: you register with an email address and a password, sign in and sign out. Every record (devices, connection tests, sessions, requests, files, API keys) belongs to a group, and every route checks that the caller is a member of the record's group. **Each account has exactly one group of its own, created when it registers.** Inviting others into a group by email, and roles within a group, are not built: a group has one member. An administrator can close registration on a server (`OPENINFER_REGISTRATION=closed`). Signed-in users can also create API keys, so that programs can use their sessions.

### 2. Device management

The plan: a user registers each machine once, with its GPU, its memory and its availability; within a session a device either serves the model or helps; each device declares what it can run, so that the platform rejects an invalid configuration before anything starts.

Today: on the Devices page you create a one-time enrolment token and give it to the device, which joins your group with a credential of its own. The device reports its hardware itself (system, processor, memory, disk, graphics cards, network addresses, inference engines), and the page shows it. A device is idle, occupied by a session, offline (no heartbeat for 30 seconds), waiting for cleanup, or removed. A connection test measures the network path between two devices (round-trip time and an 8 MB transfer) before one can help the other. Which model versions a device can run is described in a catalog file on the server; before a session starts, the server checks the plan against what each device reports (platform, free memory and disk, engine version, whether the device is online) and refuses a plan that does not fit.

### 3. Collaborative inference sessions

The plan: a user creates a session by choosing devices, their roles, a model and parameters such as context length and temperature, submits jobs to it, and starts, stops or reruns them.

Today: under Sessions you choose the serving device and, optionally, a helper, whose connection test to the serving device must have passed (it can be run again from the same page). For the helper you choose a version of the model, the most precise first; a less precise one needs less GPU memory and disk. The server runs its checks and the page shows each one; you start the session when they pass. Each device then downloads and loads its part, and the session becomes ready. You send requests to it from the website (a typed prompt or an uploaded `.txt` or `.md` file, with an optional maximum output length) or from any program through the OpenAI-compatible API with an API key. A session runs one request at a time and lists its recent requests; a result can be downloaded. If the helper is lost, the session keeps serving with the serving device alone and the helper can be reconnected; you end a session with "End session".

What differs from the plan: the catalog holds one simulated model, and its context length and sampling settings are fixed in the catalog; the website does not let you change them (a program using the OpenAI-compatible API can set temperature, top-p, top-k and a seed per request). There is no button to stop a single request or to rerun one: ending the session stops a running request, and you send a request again to rerun it. The website starts a session with one serving device and at most one helper.

### 4. Real-time monitoring

The plan: a dashboard that shows whether each device is online, the state of each session and job, and their output, updated as events arrive.

Today: the website receives every change over a WebSocket as it is committed and never polls: device heartbeats and states, connection tests as they run, each device's download and load during startup, session states, and the output of a request as it streams, split into the model's thinking and its answer. When a request ends, the page shows its end-to-end and decode speed and how many tokens the helper wrote.

## Architecture and technical stack

OpenInfer has three layers, so that each can be developed and tested on its own.

- **Frontend**: a single-page application in React and TypeScript, styled with Tailwind CSS and shadcn/ui (`web/`). It talks to the server only through the server's public API: the REST API and one WebSocket.
- **Control plane**: an Express server in TypeScript (`server/`). It holds all application state, exposes the REST API for accounts, devices, connection tests, sessions, requests, files and API keys, and an OpenAI-compatible API for programs. It validates and records every action, sends commands to the devices, and pushes every change to the browser.
- **Inference devices**: each device runs a small agent that connects to the server over its own WebSocket, reports its hardware and heartbeats, receives commands (prepare, start, run a request, stop) and sends back progress, output and results. In this repository the devices are simulated (`simulator/`), behind the same protocol (`server/src/protocol.ts`).

Persistent data lives in two places. **PostgreSQL** stores users, groups, memberships, devices, connection tests, sessions and the devices in each, requests and their output, uploaded files' records and API keys, with the relations between them. **An S3-compatible bucket** holds the larger objects: each request's result and each uploaded prompt file; the database record points to the object, so large files do not pass through the database.

The data flow follows the layers. A request made on the website reaches the server, which checks it, records it, and sends the work to the serving device. The device streams its output and status back; the server records them and pushes each change to the browser.

Real-time updates use **WebSockets** (the browser's channel and the devices' channel). The OpenAI-compatible API streams its answers to programs as **server-sent events**, as OpenAI's API does.

## Advanced features

**Authentication and authorization.** Passwords are stored only as Argon2id hashes. Signing in sets a session cookie (`HttpOnly`, `Secure`, `SameSite=Strict`, valid for seven days); every change also needs a CSRF token and the server's own `Origin`. Devices authenticate with a credential they create when they enrol, of which the server keeps only a hash; programs use API keys, also stored as hashes, which can be revoked. Every API route checks that the record belongs to the caller's group and answers `403` otherwise. Roles within a group are not built (see objective 1).

**Real-time updates.** The website opens one WebSocket, receives a snapshot of everything in its group, and then every change in the order it was committed. After a disconnection it reconnects and starts again from a new snapshot; output chunks are numbered, so none is lost or shown twice. The server pings every 10 seconds and checks the session cookie each time, so a signed-out browser stops receiving updates.

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

To use a session from a program, create an API key on the website and point any OpenAI-compatible client at `https://localhost:8443/v1`; [`docs/API.md`](docs/API.md) has the details and a complete example.

## Storage

Two kinds of files are stored as objects in an S3-compatible bucket: each request's result (`requests/<request id>.json`) and each uploaded prompt file (`files/<file id>`). The database records which user uploaded a file and which request used it.

The bucket is configured in `.env` (copy `.env.example`): `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` and, if your service needs it, `S3_REGION`. The bucket must exist. Without these settings the server keeps the objects in the memory of its own process until it stops, which is enough to try everything but stores nothing. It says so when it starts, and the website says so where a file is uploaded and where files are downloaded. After a restart the records are still in the database but the objects are gone, and a download answers that the file is no longer stored.

## Tests

```sh
npm test
```

runs the server's tests (with a real PostgreSQL from the `embedded-postgres` package), the simulator's test against the real server, and the website's tests. [`server/README.md`](server/README.md) and [`web/README.md`](web/README.md) describe each part's own checks.
