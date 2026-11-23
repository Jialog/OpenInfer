# Control plane server

The HTTPS server of the control plane: TypeScript and Express, HTTPS and WSS, PostgreSQL and an S3-compatible object store. Its interface, the REST API, the OpenAI-compatible API and the real-time channels, is described in [docs/API.md](../docs/API.md). This version serves one person, two devices and one running request; sessions and requests have their own records and idempotency keys.

## Checks

Run in this directory (Node.js 22.18 or newer):

```sh
npm ci --ignore-scripts
npm run typecheck
npm test
npm run build
node test/mutations.mjs
```

The tests run a real PostgreSQL from the `embedded-postgres` package in `node_modules`, in a temporary directory, on a random loopback port with random credentials, and stop and delete it at the end. The object-store tests use an in-memory store. The HTTPS and WSS tests create temporary certificates and check them; they need `openssl` on the `PATH`. The tests install no system service, run no Docker, and touch no real inference device or existing database. The models, capacities and build data of the fake devices in the tests are test data only.

`node test/mutations.mjs` changes the code in each of the ways it lists, one at a time, and checks that a behavior test fails for each change (a change that does not compile, does not apply or times out does not count as caught, and none is skipped). `--list` shows the changes and the test each one is bound to, `--only M01` runs one, and `--validate-mutants` only checks that each change applies and compiles.

`src/state.ts` holds the state transitions as pure functions; `src/control.ts` keeps the state in the database and sends the device commands. Short database transactions run one after another in the single server process, and object-store writes happen outside them. Run one server process per database; the server is not meant to run as several replicas. After a restart, devices get a new 30-second window to reconnect; each phase of a session still keeps its original deadline, and an inference request that had already started is not sent again.

## Running it

The server needs PostgreSQL, an HTTPS certificate that the devices and the browser trust and, to keep files, an existing S3 bucket. `npm run demo` in the repository's root provides the first two on one machine (see the end of this section and the [root README](../README.md)).

Every setting comes from the environment; the repository has no built-in passwords:

| Variable | Meaning |
| --- | --- |
| `DATABASE_URL` | PostgreSQL connection string |
| `OPENINFER_ORIGIN` | the full HTTPS origin browsers use, for the same-origin and CSRF checks |
| `OPENINFER_LOCAL_URL` | the HTTPS address the enrollment instructions give the machine that runs the server |
| `OPENINFER_TLS_CERT`, `OPENINFER_TLS_KEY` | paths of the PEM certificate and its private key |
| `S3_ENDPOINT`, `S3_BUCKET` | the S3-compatible endpoint and an existing bucket; without `S3_ENDPOINT` the stored objects are kept in memory and are lost when the server stops |
| `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | object-store credentials |
| `S3_REGION` | optional, default `us-east-1` |
| `HOST`, `PORT` | optional, default `0.0.0.0` and `8443` |
| `OPENINFER_CATALOG_FILE` | optional: the version catalog, a JSON file; the repository's is `simulator/catalog.json`, for the simulated devices |
| `OPENINFER_WEB_DIR` | optional: the website build (`web/dist/`, made by `npm run build` in `web/`); when set, the same HTTPS server serves the website |

```sh
npm run build
npm run migrate
npm start
```

`npm run demo` in the repository's root sets all of this up on one machine (`src/demo.ts`): a self-signed certificate and a PostgreSQL of its own under `./data`, the simulator's catalog, and the built website.

Starting the server also applies the migrations in `migrations/`, in file-name order. The migration runner holds a PostgreSQL advisory lock and records the SHA-256 of every applied file in `schema_migrations`; if an applied file has changed, the server refuses to start. Do not apply the SQL by hand to a database and then let the server initialise it again.

### The version catalog

The catalog file has the shape `{catalog, requirements, warmup, acceptance?}`, checked at start by `src/config.ts`:

- `catalog` has `models` and `versions`. A model names its context length, the id of the token that ends its thinking, and the sampling its requests use. A version names its model, its role (`service` or `helper`), its repository, a fixed revision, every file with its SHA-256 and size, its engine, what it requires of the engine build on any machine (`build_requirements`), its draft model (`draft_model`, helpers only), the entry the device starts it with, and its validation evidence. The repository's catalog, `simulator/catalog.json`, describes one simulated model.
- `requirements` maps a version ID to `{memory_bytes, disk_bytes, precision_rank?, without_draft_allowed?}`, with the byte counts as decimal strings. They must cover the model (and the draft model when it is on), the cache and the working space. `precision_rank` is a positive integer, 1 the most precise, and every helper version with a draft model must have one.
- When the New session page does not name a helper version, the server picks one: by `precision_rank` from small to large (at the same precision, more drafts per round first), the first version whose `memory_bytes` fits the free memory of the helper's GPU and whose `disk_bytes` fits the helper's free disk.
- `warmup` is `{resource_id, sha256, max_output_tokens: 256}`: a resource the device holds, named by its id and the SHA-256 of its bytes, that it runs once before the session is ready; `acceptance` is an optional list of fixed test prompts.

These numbers live only in this file: when a measurement changes, only the data changes. The browser can neither upload nor change launch settings. Without a catalog the version list is empty: accounts, enrollment and connection tests work, but no session can be created.

### Data

A prompt uploaded as a file (`POST /api/v1/files`, a `.txt` or `.md` file of up to 64 KiB as the request body) is stored as `files/{file_id}` in the bucket, with a row in `files` that names its user; a request that takes its prompt from it (`prompt_file_id`) keeps that id. `GET /api/v1/files/{id}/content` downloads it again, and `GET /api/v1/requests/{id}/result?download` a request's saved result. An object the store no longer has answers 410 `not_stored`; without a bucket that is every object after a restart. The snapshot's `storage` field (`bucket` or `memory`) tells the website where the objects are kept.

When a request ends, its result is stored as `requests/{request_id}.json` in the bucket. A failed upload is not retried; the output chunks stay in the database. There is no delete API. A session's push key is cleared when the session ends; device credentials and login tokens are stored only as hashes. Back up the database and the object store as your setup needs.
