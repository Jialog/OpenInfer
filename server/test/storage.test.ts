import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import http from "node:http";
import { describe, it } from "node:test";

import { MemoryObjectStore, S3ObjectStore, type ObjectStore } from "../src/storage.ts";

async function exerciseObjectStore(store: ObjectStore): Promise<void> {
  const original = Buffer.from("first value", "utf8");
  await store.put("requests/request-1.json", original);

  original.fill(0);
  assert.equal(
    (await store.get("requests/request-1.json")).toString("utf8"),
    "first value",
    "put must retain the bytes supplied at call time",
  );

  const fetched = await store.get("requests/request-1.json");
  fetched.fill(0);
  assert.equal(
    (await store.get("requests/request-1.json")).toString("utf8"),
    "first value",
    "get must return independent bytes",
  );

  await store.put("requests/request-1.json", Buffer.from("replacement", "utf8"));
  assert.equal(
    (await store.get("requests/request-1.json")).toString("utf8"),
    "replacement",
    "put to an existing key must replace the object",
  );
}

describe("MemoryObjectStore", () => {
  it("matches the object put/get and overwrite contract", async () => {
    await exerciseObjectStore(new MemoryObjectStore());
  });

  it("rejects reads of missing keys", async () => {
    await assert.rejects(new MemoryObjectStore().get("missing"), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.name, "NoSuchKey");
      return true;
    });
  });
});

describe("S3ObjectStore", () => {
  it("aborts a stalled SDK operation after five seconds", async () => {
    const server = http.createServer(() => {
      // Deliberately never send response headers or a body.
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const store = new S3ObjectStore({
      endpoint: `http://127.0.0.1:${address.port}`,
      region: "test-only",
      bucket: "test-only",
      accessKeyId: randomUUID(),
      secretAccessKey: randomUUID(),
    });
    const started = Date.now();
    try {
      await assert.rejects(store.put("stalled", Buffer.from("body")), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.name, "AbortError");
        return true;
      });
      const elapsed = Date.now() - started;
      assert.ok(elapsed >= 4_500, `aborted too early after ${elapsed} ms`);
      assert.ok(elapsed < 8_000, `abort did not bound the request: ${elapsed} ms`);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
