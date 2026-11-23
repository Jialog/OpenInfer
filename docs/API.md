# The server's API

The server (`server/`) has three interfaces on one HTTPS address, `https://localhost:8443` when started with `npm run demo`:

| Interface | Path | Who uses it | How it authenticates |
| --- | --- | --- | --- |
| REST API | `/api/v1/…` | the website, and any script acting as a signed-in user | session cookie and CSRF token |
| OpenAI-compatible API | `/v1/…` | programs | API key |
| Real-time channels | `/api/v1/ws/browser`, `/api/v1/ws/device` | the website; devices | session cookie; device credential |

Sections: [Conventions](#conventions) · [Authentication](#authentication) · [Devices and enrolment](#devices-and-enrolment) · [Connection tests](#connection-tests) · [Catalog](#catalog) · [Sessions](#sessions) · [Requests and their output](#requests-and-their-output) · [Files](#files) · [API keys](#api-keys) · [The OpenAI-compatible API](#the-openai-compatible-api) · [The real-time channel](#the-real-time-channel) · [Error codes](#error-codes) · [A complete example](#a-complete-example-from-an-uploaded-prompt-file-to-the-downloaded-result)

## Conventions

- **HTTPS only.** The demo's certificate is self-signed (`data/tls.crt`); give it to your client (`curl --cacert data/tls.crt`) instead of turning certificate checks off.
- **JSON.** Request and response bodies are JSON (`Content-Type: application/json`), at most 1 MiB, except a file upload and a file download, which carry the file itself.
- **Identifiers** are UUIDs. **Times** are ISO 8601 strings in UTC. **Large counters** (byte counts, token counts, sequence numbers) are decimal strings, so they never lose precision; small counts are numbers. **Digests** are SHA-256 in lowercase hex.
- **Unknown fields are refused** under `/api/v1`: a body with a field the route does not know answers `400 invalid_input`.
- **Errors.** Every route under `/api/v1` answers a failure with an HTTP status and this body:

  ```json
  {"error": {"code": "session_not_ready", "message": "The service instance is not ready or its control connection has not reconciled.",
             "field": null, "device_id": "71194769-9889-470a-86b0-b5d4051ccde2", "phase": "serve", "retryable": false}}
  ```

  `code` is stable and listed under [Error codes](#error-codes); `message` is a sentence for a person; `field` names the offending input field when there is one; `device_id` and `phase` say which device and which stage of a session the error is about; `retryable` says whether the same call may succeed later.
- **Idempotency.** The two calls that start work, creating a session and submitting a request, take an `Idempotency-Key` header holding a UUID you make. Sending the same call again with the same key returns the resource the first call created instead of creating a second one, so a call whose answer was lost can be repeated safely.
- **Ownership.** Every record belongs to the group of the account that created it (each account has its own group). Reading or using another group's record answers `403 forbidden`; an identifier that does not exist answers `404 not_found`.

## Authentication

### Accounts and the session cookie

| Method and path | Body | Answer |
| --- | --- | --- |
| `GET /api/v1/auth/registration` | – | `200 {"registration": "open" \| "closed"}`: whether new accounts can be created |
| `POST /api/v1/auth/register` | `{"email", "password"}` | `201` identity, and the session cookie |
| `POST /api/v1/auth/login` | `{"email", "password"}` | `200` identity, and the session cookie |
| `GET /api/v1/auth/me` | – | `200` identity of the signed-in user |
| `POST /api/v1/auth/logout` | `{}` | `204`; the session is revoked and the cookie cleared |

The password has 12 to 128 characters and is stored only as an Argon2id hash. The identity is:

```json
{"user_id": "96a82d61-…", "email": "demo@example.com", "group_id": "416da526-…",
 "csrf_token": "…", "expires_at": "2026-11-30T04:37:47.000Z"}
```

Signing in sets the cookie `__Host-openinfer_session` (`HttpOnly`, `Secure`, `SameSite=Strict`), valid for seven days. Every route under `/api/v1` needs it, except `registration`, `register` and `login` above and `POST /api/v1/device/enroll`.

**Every `POST` of a signed-in user also needs two headers**: `Origin`, equal to the server's own address (`https://localhost:8443`), and `X-CSRF-Token`, the `csrf_token` of the identity. `register` and `login` need only `Origin`. `POST /api/v1/device/enroll` needs neither: a device is not a browser and has no session, and the enrolment token in its body is what admits it. A browser sends `Origin` by itself; a script adds it.

Errors: `400 invalid_input` (a malformed email, a password of the wrong length, an extra field; registering an email that exists answers `409 invalid_input` with `field: "email"`), `401 unauthenticated` (wrong email or password, or no valid cookie), `403 forbidden` (a missing or wrong `Origin` or CSRF token), `403 registration_closed`.

### API keys

Programs do not sign in. They send an API key, made on the website or with the routes under [API keys](#api-keys), as `Authorization: Bearer oi_…` to the routes under `/v1`. A key acts as the user who made it. The two kinds of authentication do not mix: `/v1` takes only a key, `/api/v1` only the cookie.

## Devices and enrolment

A device joins an account in two steps: a signed-in user creates a one-time enrolment token, and the device presents it once together with a credential it makes for itself. In this repository the devices are simulated (`simulator/`); they use exactly these calls.

| Method and path | Body | Answer |
| --- | --- | --- |
| `GET /api/v1/snapshot` | – | `200` the snapshot: every device, running connection test, session and active request of the group (see [The real-time channel](#the-real-time-channel)) |
| `POST /api/v1/enrollment-tokens` | `{"device_name"}` (1 to 80 characters) | `201` the enrolment, with its `token` |
| `POST /api/v1/device/enroll` (no cookie) | `{"enrollment_token", "credential", "agent_boot_id", "inventory"}` | `201 {"device_id", "group_id", "protocol_version": 1, "heartbeat_interval_ms": 10000}` |
| `GET /api/v1/devices/{id}` | – | `200` the device with its inventory and instances |
| `POST /api/v1/devices/{id}/recheck` | `{}` | `202 {"command_id", "device_id"}`: asks a device in `cleanup_required` to report what is still running on it |
| `POST /api/v1/devices/{id}/remove` | `{"confirm_unavailable": true}` | `200` the device, now `removed`; only for an offline device that could not be cleaned up |

The enrolment as `POST /api/v1/enrollment-tokens` returns it:

```json
{"id": "…", "group_id": "…", "device_name": "my mac", "state": "pending", "device_id": null,
 "created_at": "…", "expires_at": "…", "token": "<43 characters, shown only in this answer>",
 "control_urls": {"local": "https://localhost:8443", "lan": "https://localhost:8443"}, "certificate_sha256": "…"}
```

The token is valid for 24 hours and for one device. `credential` is 32 random bytes in base64url that the device generates and keeps; the server stores only its hash. `inventory` is the device's report of its hardware (system, processor, memory, disk, graphics cards, addresses, engines); its exact shape is `inventorySchema` in `server/src/protocol.ts`.

A device as the website reads it:

```json
{"id": "71194769-…", "group_id": "…", "name": "Mac (simulated)", "state": "idle", "cleanup_required": false,
 "agent_boot_id": "…", "reconciled_at": "…", "last_heartbeat_at": "…", "heartbeat_deadline_at": "…",
 "address_revision": "1", "removed_at": null, "created_at": "…", "error": null,
 "reservation": null, "inventory": {"os": "darwin", "arch": "arm64", "…": "…"}, "instances": []}
```

`state` is `idle` (free), `occupied` (reserved by a session, named in `reservation`), `cleanup_required`, `offline` (no heartbeat for 30 seconds) or `removed`. The snapshot lists devices without `inventory` and `instances`.

Errors: `401 unauthenticated` (unknown token), `401 token_expired`, `409 device_busy`.

## Connection tests

Before a helper can join a session, the path from the helper to the serving device is tested: the target device listens, the source device connects, measures ten round trips and sends 8 MB.

| Method and path | Body | Answer |
| --- | --- | --- |
| `POST /api/v1/connection-tests` | `{"source_device_id", "target_device_id", "target_addresses": ["192.0.2.10"], "port": 40360, "listener_python": "/simulated/python3"}` | `202 {"test": …}` |
| `GET /api/v1/connection-tests/{id}` | – | `200` the test |

`target_addresses` and `listener_python` must be values the target device reports in its inventory (`addresses`, `python_executables`). The test:

```json
{"id": "5897b391-…", "source_device_id": "…", "target_device_id": "…", "target_addresses": ["192.0.2.10"], "port": 40360,
 "state": "reachable", "valid": true, "invalid_reason": null, "source_address": "192.0.2.20", "target_address": "192.0.2.10",
 "rtt_median_ms": 0.594, "transfer_bytes": "8000000", "transfer_ms": 68.1, "error": null,
 "started_at": "…", "listener_ready_at": "…", "finished_at": "…", "listener_closed_at": "…", "valid_until": "…", "deadline_at": "…"}
```

`state` goes `listening` → `testing` → `reachable` or `unreachable`. A session accepts a test whose `valid` is true and whose `listener_closed_at` is set; a test stops being valid after seven days, or when either device restarts or changes its addresses.

Errors: `409 device_busy` (a device is reserved, offline or the same device twice), `400 invalid_input` (an address or interpreter the target does not report), `409 port_busy`.

## Catalog

`GET /api/v1/catalog` → `200` the models and versions sessions can run:

```json
{"models": {"simulated-lm": {"context_length": 8192, "think_end_id": 2, "sampling": {"temperature": 0.6, "top_p": 0.95, "top_k": 20, "min_p": 0, "presence_penalty": 0}}},
 "service_version_id": "demo-serve-4bit",
 "versions": [{"id": "demo-serve-4bit", "role": "service", "label": "…", "model": "simulated-lm", "engine": "mlx", "platform": {"os": "darwin", "arch": "arm64", "gpu_vendor": null}, "…": "…"}],
 "placement": {"demo-serve-4bit": [{"version_id": "demo-help-8bit", "memory_bytes": "21474836480", "disk_bytes": "12000000000"}, {"version_id": "demo-help-4bit", "…": "…"}]}}
```

A version has the role `service` (the device that serves the model) or `helper`. `placement` lists, for each service version, the helper versions the server chooses from, the most precise first, with the free memory and disk each needs. The catalog is a file the server reads at start (`OPENINFER_CATALOG_FILE`); here it is `simulator/catalog.json`.

## Sessions

A session is one model running on a serving device, with or without a helper device.

| Method and path | Body | Answer |
| --- | --- | --- |
| `POST /api/v1/sessions/preflight` | a plan | `200` the checks, and the plan with the helper version filled in |
| `POST /api/v1/sessions` (`Idempotency-Key`) | a plan that names its helper version | `201 {"session": …}` |
| `GET /api/v1/sessions/{id}` | – | `200` the session |
| `POST /api/v1/sessions/{id}/stop` | `{}` | `202 {"session": …}`, now `stopping` |
| `POST /api/v1/sessions/{id}/helpers/{device_id}/reconnect` | `{}` | `202 {"session": …}`: replaces the helper of a `degraded` session |
| `GET /api/v1/sessions/{id}/requests?limit=20` | – | `200 {"requests": […]}`: the session's latest requests, newest first (`limit` 1 to 100) |

A plan:

```json
{"service_device_id": "71194769-…", "service_version_id": "demo-serve-4bit",
 "helpers": [{"device_id": "c4c7ba29-…", "version_id": null, "draft_model": "enabled",
              "acknowledge_no_draft_model": false, "connection_test_id": "5897b391-…"}]}
```

`helpers` is empty for a serving device alone. `draft_model` is `enabled` to run the helper with its draft model; `disabled`, with `acknowledge_no_draft_model: true`, runs it without one where the catalog allows that. With `version_id: null` the preflight chooses the most precise helper version that fits the helper's free memory and disk. The preflight answers:

```json
{"checked_at": "…", "allowed": true, "config_sha256": "…",
 "plan": {"…": "the plan, with the chosen helpers[0].version_id"},
 "checks": [{"code": "control_online", "passed": true, "device_id": "…", "message": "Check control online passed.", "required_bytes": null, "available_bytes": null},
            {"code": "capacity_insufficient", "passed": true, "device_id": "…", "message": "…", "required_bytes": "21474836480", "available_bytes": "25232932864"}]}
```

A check is named by the error code it would fail with. Create the session with the `plan` the preflight returned; the server checks it again and answers `409 preflight_failed` if anything changed.

A session:

```json
{"id": "fb83848b-…", "state": "ready", "phase": "serve", "model": "simulated-lm", "submissions_blocked": false,
 "active_request_ids": [], "error": null, "stop_cause": null, "created_at": "…", "ended_at": null,
 "plan": {"…": "…"}, "effective_config": {"…": "…"},
 "instances": [{"instance_id": "2141dd16-…", "device_id": "…", "generation": 1, "state": "ready", "phase": "serve",
                "progress": null, "push_connection_id": null, "error": null, "…": "…"}]}
```

`state`: `starting` (each device prepares, downloads, loads; then the helper connects and one warm-up request runs) → `ready` → `stopping` → `ended`. A session whose helper is lost is `degraded`: it still serves, at the serving device's own speed, until the helper is replaced with `…/reconnect`. A session that stops because something failed ends as `failed`, with `stop_cause` and `error`. While an instance downloads, its `progress` is `{"completed_bytes", "total_bytes", "at"}`. The snapshot lists sessions without `plan`, `effective_config` and `instances`.

Errors: `409 preflight_failed`, `409 session_not_ready` (reconnect on a session that is not degraded), `409 device_busy`, `409 direction_unreachable`, `400 invalid_input` (a missing `Idempotency-Key`, a plan without a helper version).

## Requests and their output

| Method and path | Body | Answer |
| --- | --- | --- |
| `POST /api/v1/sessions/{id}/requests` (`Idempotency-Key`) | request input | `201 {"request": …}` |
| `GET /api/v1/requests/{id}` | – | `200` the request |
| `GET /api/v1/requests/{id}/chunks?after=0&limit=100` | – | `200` the output chunks after sequence number `after` (`limit` 1 to 1000) |
| `GET /api/v1/requests/{id}/result` | – | `200` the saved result |
| `GET /api/v1/requests/{id}/result?download` | – | the same, as a file (`Content-Disposition: attachment; filename=request-{id}.json`) |

The input names exactly one source of the prompt:

```json
{"prompt": "Explain what a helper device does.", "max_output_tokens": 256}
```

```json
{"prompt_file_id": "afe9cd4f-…"}
```

`prompt` is at most 65536 bytes of text. `prompt_file_id` is a file uploaded with `POST /api/v1/files`: the server reads its text from storage and uses it as the prompt. A third source, `acceptance_prompt_id`, names a fixed test prompt of the catalog; `GET /api/v1/acceptance-prompts` lists them as `{"enabled", "prompts": [{"id", "label", "resource_sha256", "max_output_tokens"}]}`, and the catalog of this repository has none (`{"enabled": false, "prompts": []}`). `max_output_tokens` is optional; without it the output may use what is left of the model's context. A session runs one request at a time.

A request:

```json
{"id": "65df86fa-…", "session_id": "fb83848b-…", "user_id": "…", "state": "completed", "source": "web",
 "input": {"prompt": "What does a helper device do?\n"}, "prompt_file_id": "afe9cd4f-…",
 "prompt_file": {"id": "afe9cd4f-…", "name": "question.md", "size_bytes": 30},
 "prompt_tokens": 6, "requested_max_output": null, "effective_max_output": 8186,
 "contiguous_seq": "113", "final_seq": "113", "output_tokens": "263",
 "timing": {"engine_received_ns": "…", "engine_first_output_ns": "…", "engine_last_output_ns": "…", "engine_first_chunk_tokens": 1, "…": "…"},
 "statistics": {"accepted_external_tokens": "145", "think_end_position": "77", "…": null},
 "archive_state": "saved", "result_sha256": "e967f9d9…", "error": null,
 "received_at": "…", "started_at": "…", "ended_at": "…"}
```

`state`: `pending` → `running` → `recovering` (the device has finished; the server is saving the result) → `completed`; or `cancelling` → `cancelled`; or `failed` with `error`. `output_tokens` and `contiguous_seq` grow while the request runs. `statistics.accepted_external_tokens` is the number of output tokens the helper wrote. `archive_state` is `pending`, `saved` or `failed`: the result can be read once it is `saved`. `source` is `web` or `api` (a program, through `/v1`).

**The output arrives as chunks**, numbered from 1 without gaps. Read them by polling `…/chunks?after=<last seq you have>` until the request has ended and `after` equals its `final_seq`, or receive them over the [real-time channel](#the-real-time-channel) as the website does.

```json
{"request_id": "65df86fa-…", "contiguous_seq": "113", "next": "1",
 "chunks": [{"request_id": "65df86fa-…", "seq": "1", "text": "The ", "token_count": 1, "segment": "think",
             "committed_position": "7", "received_at": "…", "…": "…"}]}
```

`segment` is `think` (the model's thinking) or `answer`. `next` is the `after` value for the following page, or `null` when this page reached the end of what is stored.

The saved result is one JSON object; among its fields are `request_id`, `session_id`, `outcome`, `input`, `prompt_file_id`, `seed`, `sampling`, `prompt_tokens`, `output_tokens`, `text` (the whole output), `chunks`, `timing`, `statistics` and `error`.

Errors: `409 session_not_ready`, `409 request_busy`, `400 invalid_input`, `400 context_budget_exceeded` (`max_output_tokens` does not fit the context), `403`/`404`/`410` for a `prompt_file_id` that is another group's, unknown, or no longer stored; for the result, `409 result_pending` (not saved yet), `409 archive_failed`, `410 not_stored`, `502 file_store_failed`.

## Files

A prompt can be uploaded as a text file and used by requests. The file's bytes are an object in the storage bucket (`files/{id}`); the database records who uploaded it, and each request that used it points to it.

| Method and path | Body | Answer |
| --- | --- | --- |
| `POST /api/v1/files?name=question.md` | **the file itself** (not JSON) | `201 {"file": …}` |
| `GET /api/v1/files/{id}/content` | – | the file's bytes, as an attachment under its name |

The upload takes a `.txt` or `.md` file (the name is in the query, at most 255 characters, without a path) of 1 to 65536 bytes that is UTF-8 text and not blank. Send any `Content-Type` except `application/json`, for example `text/plain` or `text/markdown`.

```json
{"file": {"id": "afe9cd4f-…", "name": "question.md", "content_type": "text/markdown", "size_bytes": 30,
          "sha256": "…", "created_at": "…"}}
```

The download answers with `Content-Type: text/markdown; charset=utf-8` (or `text/plain`) and `Content-Disposition: attachment`.

**Where files are kept.** With `S3_ENDPOINT` and the other `S3_*` settings, files and results are objects in that bucket. Without them the server keeps them in the memory of its own process, and they are lost when it stops; the records remain, and a download then answers `410 not_stored`. The snapshot's `storage` field says which is the case: `"bucket"` or `"memory"`.

Errors: `400 invalid_input` with `field: "name"` (not a `.txt` or `.md` name) or `field: "file"` (empty, not UTF-8, or a JSON body), `413 invalid_input` (over 65536 bytes), `410 not_stored`, `502 file_store_failed` (the bucket could not be reached; `retryable: true`).

## API keys

| Method and path | Body | Answer |
| --- | --- | --- |
| `GET /api/v1/api-keys` | – | `200 {"api_keys": […], "certificate_path": "~/…/data/tls.crt"}` |
| `POST /api/v1/api-keys` | `{"name"}` (1 to 80 characters) | `201 {"api_key": …, "secret": "oi_…"}` |
| `POST /api/v1/api-keys/{id}/revoke` | `{}` | `200 {"api_key": …}` |

```json
{"api_key": {"id": "…", "name": "laptop scripts", "hint": "oi_pwlw", "created_at": "…", "last_used_at": null, "revoked_at": null},
 "secret": "oi_<43 characters>"}
```

The `secret` is shown only in this answer; the server stores its hash, and lists show the `hint` (its last four characters). A key cannot be changed or deleted, only revoked. A user sees and revokes only their own keys.

## The OpenAI-compatible API

Two routes that follow OpenAI's chat completions API, so that an existing client works by changing its base address to `https://localhost:8443/v1` and its key. Both need `Authorization: Bearer oi_…`. Errors here have OpenAI's shape, `{"error": {"message", "type", "param", "code"}}`.

**`GET /v1/models`** → `{"object": "list", "data": [{"id": "simulated-lm", "object": "model", "created": 1795300000, "owned_by": "openinfer"}]}`

**`POST /v1/chat/completions`**

```json
{"model": "simulated-lm", "messages": [{"role": "user", "content": "Hello"}], "max_tokens": 64, "stream": false}
```

The request goes to the user's running session, as a request from the website does, and appears in the session's list of requests with `source: "api"`.

| Field | Meaning |
| --- | --- |
| `model` | required; one of `/v1/models` |
| `messages` | required; roles `system` (or `developer`), `user`, `assistant`; `content` a string or a list of text parts; 64 KiB together |
| `max_tokens` or `max_completion_tokens` | the output budget; a budget larger than what fits the context is cut to what fits |
| `stream` | `true` for server-sent events; `stream_options.include_usage` adds a final usage event |
| `temperature`, `top_p`, `top_k`, `seed`, `stop` | sampling; `temperature` must be above 0 (default 1.0) |

Tools, function calls, log probabilities, several choices (`n` other than 1), JSON response formats and non-text content answer `400 unsupported_parameter` or `invalid_value`. Fields the server does not know are ignored.

The answer, not streamed:

```json
{"id": "chatcmpl-<request id>", "object": "chat.completion", "created": 1795300000, "model": "simulated-lm",
 "choices": [{"index": 0, "finish_reason": "stop", "logprobs": null,
              "message": {"role": "assistant", "content": "the answer", "reasoning_content": "the thinking"}}],
 "usage": {"prompt_tokens": 4, "completion_tokens": 40, "total_tokens": 44},
 "openinfer": {"request_id": "…", "session_id": "…", "seed": "…", "sampling": {"…": "…"}, "effective_max_output": 40}}
```

`finish_reason` is `length` when the budget ended the output, else `stop`. Streamed, the events are `chat.completion.chunk` objects: first the role, then `delta.reasoning_content` for the thinking and `delta.content` for the answer, a final event with `finish_reason`, the usage event if asked for, and `data: [DONE]`. A request that fails after the stream began ends with an error event and no `[DONE]`. Closing the connection cancels the request.

| Status | `code` | When |
| --- | --- | --- |
| 401 | `invalid_api_key`, `api_key_revoked` | no key, an unknown key, a revoked key |
| 400 | `invalid_value`, `unsupported_parameter`, `context_length_exceeded` | a field's value, an unsupported feature, a prompt that does not fit |
| 404 | `model_not_found`, `not_found` | an unknown model, another path under `/v1` |
| 413 | `request_too_large` | a body over 1 MiB |
| 429 | `request_busy` | the session is running another request; `Retry-After: 10` |
| 503 | `session_not_ready`, `request_cancelled`, `server_stopping` | no session is running (start one on the website), the session stopped, the server is stopping |

## The real-time channel

The website does not poll. It opens one WebSocket and receives every change of its group's records as it is committed.

**`wss://localhost:8443/api/v1/ws/browser`**, subprotocol `openinfer.browser.v1`, with the session cookie and an `Origin` equal to the server's address. The server sends; a client that sends anything is disconnected.

Every message has this envelope, with `seq` counting from 0 on each connection:

```json
{"v": 1, "type": "request.updated", "connection_id": "…", "seq": "17", "at": "2026-11-23T04:38:32.531Z", "payload": {"…": "…"}}
```

| `type` | `payload` | Sent |
| --- | --- | --- |
| `snapshot` | `{"at", "group_id", "storage", "devices", "connection_tests", "sessions", "requests", "output_watermarks"}` | first, once: the same object as `GET /api/v1/snapshot` |
| `enrollment.updated` | an enrolment, without its token | after the snapshot for each enrolment, and when a device uses its token |
| `device.updated` | a device, as `GET /api/v1/devices/{id}` | on every change: a heartbeat, a reservation, going offline |
| `connection_test.updated` | a connection test | as the test advances |
| `session.updated` | a session, as `GET /api/v1/sessions/{id}` | on every change of the session or its instances, download progress included |
| `request.updated` | a request, as `GET /api/v1/requests/{id}` | on every change of the request |
| `output.chunk` | one output chunk | for each chunk, in order, before the `request.updated` that counts it |
| `resync_required` | `{"reason"}` | when the server cannot continue the stream; the connection then closes |

The snapshot holds the devices that are not removed, the connection tests still running, the sessions that have not ended together with the latest 20 that have, and the requests that have not ended. `output_watermarks` gives, for each of those requests, the `contiguous_seq` up to which its chunks existed when the snapshot was taken; chunks before it are read with `GET …/chunks`. `storage` is `"bucket"` or `"memory"` (see [Files](#files)).

After a disconnection, or `resync_required`, a client connects again and starts from the new snapshot. The server sends a WebSocket ping every 10 seconds and checks the session cookie again each time; the close code is `4401` once the session is no longer valid and `4400` for a message from the client.

**Devices** use the second channel, `wss://…/api/v1/ws/device` with subprotocol `openinfer.device.v1` and the headers `Authorization: Bearer <credential>` and `X-OpenInfer-Device-Id`. Over it a device reports its inventory and heartbeats, receives commands (prepare, start, run a request, stop) and sends back progress, output chunks and results. The messages a device sends are defined, with their schemas, in `server/src/protocol.ts`; `simulator/src/device.ts` is a complete device written against them.

## Error codes

The codes of `/api/v1`. The status is the usual one; a few codes appear with more than one.

| `code` | Status | Meaning |
| --- | --- | --- |
| `invalid_input` | 400, 409, 413 | a field is missing, malformed or not allowed here (`field` names it); a body or file that is too large |
| `unauthenticated` | 401 | no valid session cookie, or wrong email or password |
| `token_expired` | 401 | the enrolment token has expired |
| `credential_revoked` | 401 | the device's credential is no longer valid |
| `forbidden` | 403 | the record belongs to another group, or the `Origin` or CSRF token is wrong |
| `registration_closed` | 403 | new accounts cannot be created on this server |
| `not_found` | 404 | no such record, or no such route |
| `device_busy` | 409 | the device is reserved, offline, or needs cleanup |
| `port_busy` | 409 | a test listener on that port has not been closed yet |
| `preflight_failed` | 409 | a check of the plan failed; run the preflight to see which |
| `session_not_ready` | 409 | the session is not ready, or its serving device is not connected |
| `request_busy` | 409 | the session is running another request |
| `direction_unreachable` | 409 | the connection test of the plan is not valid (any more) |
| `result_pending` | 409 | the request's result is not saved yet |
| `archive_failed` | 409 | the request's result could not be saved; its chunks can still be read |
| `not_stored` | 410 | the file or result is no longer in storage |
| `context_budget_exceeded` | 400 | the prompt and the requested output do not fit the model's context |
| `file_store_failed` | 502 | the storage bucket could not be reached |
| `internal_error` | 500 | the server could not complete the call |

Preflight checks and the `error` of a failed session or request use further codes that describe a device or a stage: `unsupported_platform`, `hardware_unvalidated`, `capacity_insufficient`, `disk_insufficient`, `version_compatibility`, `control_online`, `build_mismatch`, `startup_failure`, `service_failure`, `service_offline`, `cancel_timeout`, `stop_timeout`, `deadline_exceeded`, `reconcile_failed`, `cleanup_required`, `persistence_failed`, `chunk_conflict`, `instance_mismatch`, `http_error`. Each comes with a `message` that says what happened; the full list with its messages is at the top of `server/src/protocol.ts`.

## A complete example: from an uploaded prompt file to the downloaded result

With `npm run demo` and `npm run devices -- --seed` running, this signs in as the demo account, tests the connection between the two simulated devices, starts a session, uploads a prompt file, sends a request that reads its prompt from the file, and downloads the result and the file. It is a Bash script and needs `curl`, `jq` and `uuidgen`; run it in the repository's root. Set `EMAIL` to `demo@example.com` and `PASSWORD` to the password the simulator printed. Both devices must be idle: end any session that is still open first, or step 3 answers `409 device_busy`. A call that is refused prints the server's answer and stops the script.

```sh
set -euo pipefail
BASE=https://localhost:8443          # where `npm run demo` serves
CA=data/tls.crt                      # its certificate
JAR=$(mktemp)                        # holds the session cookie
get()   { curl -sS --cacert $CA -b $JAR "$BASE$1"; }
post()  { curl -sS --cacert $CA -b $JAR -H "Origin: $BASE" -H "X-CSRF-Token: $CSRF" -H 'Content-Type: application/json' -d "$2" "$BASE$1" "${@:3}"; }
field() { jq -er "$1" <<<"$2" || { echo "$2" >&2; return 1; }; }      # one field of an answer; a refusal is shown and stops the script

# 1. Sign in. The reply carries the CSRF token; the cookie goes to the jar.
REPLY=$(curl -sS --cacert $CA -c $JAR -H "Origin: $BASE" -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}" $BASE/api/v1/auth/login)
CSRF=$(field .csrf_token "$REPLY")

# 2. The two devices the simulator enrolled.
REPLY=$(get /api/v1/snapshot)
MAC=$(field '.devices[] | select(.name=="Mac (simulated)").id' "$REPLY")
GPU=$(field '.devices[] | select(.name=="GPU helper (simulated)").id' "$REPLY")

# 3. A connection test from the helper to the serving device, with what the serving device reports about itself.
MAC_DETAILS=$(get /api/v1/devices/$MAC)
BODY=$(jq -n --arg s $GPU --arg t $MAC --argjson d "$MAC_DETAILS" \
  '{source_device_id:$s, target_device_id:$t, target_addresses:[$d.inventory.addresses[].address], port:40360,
    listener_python:$d.inventory.python_executables[0].path}')
REPLY=$(post /api/v1/connection-tests "$BODY")
TEST=$(field .test.id "$REPLY")
until [ "$(get /api/v1/connection-tests/$TEST | jq -r '.valid and .listener_closed_at != null')" = true ]; do sleep 1; done

# 4. Check a plan (the server chooses the helper version), start the session it returns, and wait until it is ready.
BODY=$(jq -n --arg m $MAC --arg g $GPU --arg t $TEST \
  '{service_device_id:$m, service_version_id:"demo-serve-4bit",
    helpers:[{device_id:$g, version_id:null, draft_model:"enabled", acknowledge_no_draft_model:false, connection_test_id:$t}]}')
REPLY=$(post /api/v1/sessions/preflight "$BODY")
PLAN=$(field '.plan | tojson' "$REPLY")
REPLY=$(post /api/v1/sessions "$PLAN" -H "Idempotency-Key: $(uuidgen)")
SESSION=$(field .session.id "$REPLY")
until [ "$(get /api/v1/sessions/$SESSION | jq -r .state)" = ready ]; do sleep 1; done

# 5. Upload a prompt file: the file itself is the body, its name is in the query.
printf 'What does a helper device do?\n' > question.md
REPLY=$(curl -sS --cacert $CA -b $JAR -H "Origin: $BASE" -H "X-CSRF-Token: $CSRF" -H 'Content-Type: text/markdown' \
  --data-binary @question.md "$BASE/api/v1/files?name=question.md")
FILE=$(field .file.id "$REPLY")

# 6. A request that takes its prompt from the file; wait until its result is saved.
REPLY=$(post /api/v1/sessions/$SESSION/requests "{\"prompt_file_id\":\"$FILE\"}" -H "Idempotency-Key: $(uuidgen)")
REQUEST=$(field .request.id "$REPLY")
until [ "$(get /api/v1/requests/$REQUEST | jq -r .archive_state)" = saved ]; do sleep 1; done
get "/api/v1/requests/$REQUEST/chunks?limit=3" | jq -c '.chunks[] | {seq, segment, token_count, text}'

# 7. Download the result and the uploaded file, as files.
curl -sS --cacert $CA -b $JAR -o result.json "$BASE/api/v1/requests/$REQUEST/result?download"
curl -sS --cacert $CA -b $JAR -o question-again.md "$BASE/api/v1/files/$FILE/content"
jq '{outcome, output_tokens, prompt_file_id, prompt: .input.prompt}' result.json
cmp question.md question-again.md && echo "the downloaded file is the uploaded one"

# 8. End the session.
REPLY=$(post /api/v1/sessions/$SESSION/stop '{}')
field .session.state "$REPLY"
```

It prints the first three chunks of the output, a summary of the downloaded result, the comparison of the two files, and the session's new state:

```text
{"seq":"1","segment":"think","token_count":1,"text":"The "}
{"seq":"2","segment":"think","token_count":2,"text":"user sent "}
{"seq":"3","segment":"think","token_count":2,"text":"a prompt "}
{
  "outcome": "completed",
  "output_tokens": "263",
  "prompt_file_id": "afe9cd4f-8c0e-4c8c-a37c-69f70a7e9722",
  "prompt": "What does a helper device do?\n"
}
the downloaded file is the uploaded one
stopping
```

The same session can then be used from a program: create an API key (`post /api/v1/api-keys '{"name":"example"}' | jq -r .secret`) before step 8 and call

```sh
curl -sS --cacert data/tls.crt https://localhost:8443/v1/chat/completions \
  -H "Authorization: Bearer $OPENINFER_API_KEY" -H 'Content-Type: application/json' \
  -d '{"model": "simulated-lm", "messages": [{"role": "user", "content": "Hello"}], "max_tokens": 40}'
```
