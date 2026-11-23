/// <reference types="node" />

import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { Buffer } from "node:buffer";

export interface ObjectStore {
  put(key: string, body: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
}

export interface S3ObjectStoreOptions {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export class S3ObjectStore implements ObjectStore {
  readonly #bucket: string;
  readonly #client: S3Client;

  constructor(options: S3ObjectStoreOptions) {
    this.#bucket = options.bucket;
    this.#client = new S3Client({
      endpoint: options.endpoint,
      region: options.region,
      credentials: {
        accessKeyId: options.accessKeyId,
        secretAccessKey: options.secretAccessKey,
      },
      forcePathStyle: true,
    });
  }

  async put(key: string, body: Buffer): Promise<void> {
    await this.#client.send(
      new PutObjectCommand({
        Bucket: this.#bucket,
        Key: key,
        Body: body,
      }),
      { abortSignal: AbortSignal.timeout(5_000) },
    );
  }

  async get(key: string): Promise<Buffer> {
    const result = await this.#client.send(
      new GetObjectCommand({ Bucket: this.#bucket, Key: key }),
      { abortSignal: AbortSignal.timeout(5_000) },
    );
    if (result.Body === undefined) {
      throw new Error(`S3 returned no body for object key: ${key}`);
    }

    return Buffer.from(await result.Body.transformToByteArray());
  }
}

export class MemoryObjectStore implements ObjectStore {
  readonly #objects = new Map<string, Buffer>();

  async put(key: string, body: Buffer): Promise<void> {
    this.#objects.set(key, Buffer.from(body));
  }

  async get(key: string): Promise<Buffer> {
    const body = this.#objects.get(key);
    if (body === undefined) {
      const error = new Error(`Object does not exist: ${key}`);
      error.name = "NoSuchKey";
      throw error;
    }

    return Buffer.from(body);
  }
}
