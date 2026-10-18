// TtlLruCache.ts
// Shared TTL-on-top-of-LRU cache used by both AbiRegistryClient and
// LocalAbiRegistryClient - extracted so the two clients don't each carry a
// byte-identical copy of the same eviction/expiry logic.

import { LruCache } from "./LruCache.js";

export const DEFAULT_MAX_CACHE_SIZE = 512;
export const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000;

type CacheEntry<V> = {
  value: V;
  expiresAt: number;
};

/**
 * Time-to-live LRU cache that evicts entries after expiry or when capacity is exceeded.
 */
export class TtlLruCache<V> {
  private readonly cache: LruCache<string, CacheEntry<V>>;

  /**
   * @param ttlMs Time-to-live for cache entries in milliseconds
   * @param maxSize Maximum number of entries to retain
   */
  constructor(
    private readonly ttlMs: number,
    maxSize: number,
  ) {
    this.cache = new LruCache(maxSize);
  }

  get(key: string): V | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: V): void {
    this.cache.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }

  clear(): void {
    this.cache.clear();
  }
}
