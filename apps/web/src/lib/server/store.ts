// Queue storage for the relay and the exit relay. Upstash Redis (or Vercel KV, which speaks the
// same REST API) in production; an in-memory map in local development only.
import "server-only";
import { Redis } from "@upstash/redis";

export type QueueKind = "relay" | "exit";

export interface QueueItem {
  id: string;
  rollupId: string;
  status: string;
  createdAt: number;
  updatedAt: number;
  [k: string]: unknown;
}

interface Store {
  get(kind: QueueKind, id: string): Promise<QueueItem | null>;
  /** Saves the item and, while it is queued, lists it as pending for its rollup. */
  put(item: QueueItem, kind: QueueKind): Promise<void>;
  pending(kind: QueueKind, rollupId: string, limit: number): Promise<QueueItem[]>;
  /** Removes the item from its rollup's pending list. */
  unqueue(kind: QueueKind, item: QueueItem): Promise<void>;
  /** Returns how many hits `key` has had in the current window, counting this one. */
  hit(key: string, windowSecs: number): Promise<number>;
  /** Maps a dedupe key to an item id once; returns the id already stored, if any. */
  claim(key: string, id: string, ttlSecs: number): Promise<string | null>;
}

const itemKey = (kind: QueueKind, id: string) => `wg:${kind}:item:${id}`;
const pendingKey = (kind: QueueKind, rollupId: string) => `wg:${kind}:pending:${rollupId}`;

class RedisStore implements Store {
  constructor(private redis: Redis) {}
  async get(kind: QueueKind, id: string) {
    return (await this.redis.get<QueueItem>(itemKey(kind, id))) ?? null;
  }
  async put(item: QueueItem, kind: QueueKind) {
    const tx = this.redis.multi();
    tx.set(itemKey(kind, item.id), item, { ex: 60 * 60 * 24 * 30 });
    if (item.status === "queued") tx.zadd(pendingKey(kind, item.rollupId), { score: item.createdAt, member: item.id });
    await tx.exec();
  }
  async pending(kind: QueueKind, rollupId: string, limit: number) {
    const ids = await this.redis.zrange<string[]>(pendingKey(kind, rollupId), 0, limit - 1);
    if (!ids.length) return [];
    const items = await this.redis.mget<(QueueItem | null)[]>(...ids.map((id) => itemKey(kind, id)));
    return items.filter((i): i is QueueItem => !!i && i.status === "queued");
  }
  async unqueue(kind: QueueKind, item: QueueItem) {
    await this.redis.zrem(pendingKey(kind, item.rollupId), item.id);
  }
  async hit(key: string, windowSecs: number) {
    const k = `wg:rate:${key}`;
    const n = await this.redis.incr(k);
    if (n === 1) await this.redis.expire(k, windowSecs);
    return n;
  }
  async claim(key: string, id: string, ttlSecs: number) {
    const k = `wg:dedupe:${key}`;
    const ok = await this.redis.set(k, id, { nx: true, ex: ttlSecs });
    return ok ? null : ((await this.redis.get<string>(k)) ?? null);
  }
}

class MemoryStore implements Store {
  private items = new Map<string, QueueItem>();
  private queues = new Map<string, Set<string>>();
  private counters = new Map<string, { n: number; until: number }>();
  private dedupe = new Map<string, string>();
  async get(kind: QueueKind, id: string) {
    return this.items.get(itemKey(kind, id)) ?? null;
  }
  async put(item: QueueItem, kind: QueueKind) {
    this.items.set(itemKey(kind, item.id), structuredClone(item));
    if (item.status === "queued") {
      const q = this.queues.get(pendingKey(kind, item.rollupId)) ?? new Set();
      q.add(item.id);
      this.queues.set(pendingKey(kind, item.rollupId), q);
    }
  }
  async pending(kind: QueueKind, rollupId: string, limit: number) {
    const ids = [...(this.queues.get(pendingKey(kind, rollupId)) ?? [])];
    return ids
      .map((id) => this.items.get(itemKey(kind, id)))
      .filter((i): i is QueueItem => !!i && i.status === "queued")
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(0, limit);
  }
  async unqueue(kind: QueueKind, item: QueueItem) {
    this.queues.get(pendingKey(kind, item.rollupId))?.delete(item.id);
  }
  async hit(key: string, windowSecs: number) {
    const now = Date.now();
    const c = this.counters.get(key);
    if (!c || c.until < now) {
      this.counters.set(key, { n: 1, until: now + windowSecs * 1000 });
      return 1;
    }
    c.n++;
    return c.n;
  }
  async claim(key: string, id: string) {
    const existing = this.dedupe.get(key);
    if (existing) return existing;
    this.dedupe.set(key, id);
    return null;
  }
}

export class StoreUnavailable extends Error {}

declare global {
  // eslint-disable-next-line no-var
  var __wgMemoryStore: MemoryStore | undefined;
}

export function getStore(): Store {
  const url = process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN;
  if (url && token) return new RedisStore(new Redis({ url, token }));
  if (process.env.NODE_ENV === "production") {
    throw new StoreUnavailable("Queue storage is not configured (set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN).");
  }
  // Development only: survives hot reloads, not restarts.
  globalThis.__wgMemoryStore ??= new MemoryStore();
  return globalThis.__wgMemoryStore;
}
