// What the server cannot give back after a refresh: which tests and requests this browser knows about
// (docs/API.md). Stored per user; a blocked localStorage only loses the convenience.
import type {ID} from '@/api/types';

type Memory = {tests: Record<string, ID>; requests: Record<ID, ID>};

function storageKey(userId: ID): string {
  return `openinfer.v1.${userId}`;
}

function read(userId: ID): Memory {
  try {
    const raw = window.localStorage.getItem(storageKey(userId));
    return raw ? (JSON.parse(raw) as Memory) : {tests: {}, requests: {}};
  } catch {
    return {tests: {}, requests: {}};
  }
}

function write(userId: ID, memory: Memory): void {
  try {
    window.localStorage.setItem(storageKey(userId), JSON.stringify(memory));
  } catch {
    // Storage is unavailable; the page still works for this visit.
  }
}

export class BrowserMemory {
  private readonly userId: ID;

  constructor(userId: ID) {
    this.userId = userId;
  }

  rememberTest(sourceId: ID, targetId: ID, testId: ID): void {
    const memory = read(this.userId);
    memory.tests[`${sourceId}:${targetId}`] = testId;
    write(this.userId, memory);
  }

  testIds(): ID[] {
    return Object.values(read(this.userId).tests);
  }

  requestFor(sessionId: ID): ID | null {
    return read(this.userId).requests[sessionId] ?? null;
  }

  rememberRequest(sessionId: ID, requestId: ID): void {
    const memory = read(this.userId);
    memory.requests[sessionId] = requestId;
    write(this.userId, memory);
  }

  forgetRequest(sessionId: ID): void {
    const memory = read(this.userId);
    delete memory.requests[sessionId];
    write(this.userId, memory);
  }
}
