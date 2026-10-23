import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { TtlLruCache, DEFAULT_MAX_CACHE_SIZE, DEFAULT_CACHE_TTL_MS } from "../src/TtlLruCache.js";

describe("TtlLruCache", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("exports", () => {
    it("should export DEFAULT_MAX_CACHE_SIZE as 512", () => {
      expect(DEFAULT_MAX_CACHE_SIZE).toBe(512);
    });

    it("should export DEFAULT_CACHE_TTL_MS as 5 minutes in milliseconds", () => {
      expect(DEFAULT_CACHE_TTL_MS).toBe(5 * 60 * 1000);
    });
  });

  describe("instantiation", () => {
    it("should instantiate with custom ttl and maxSize", () => {
      const cache = new TtlLruCache<string>(1000, 10);
      expect(cache).toBeInstanceOf(TtlLruCache);
    });

    it("should instantiate with default constants", () => {
      const cache = new TtlLruCache<string>(DEFAULT_CACHE_TTL_MS, DEFAULT_MAX_CACHE_SIZE);
      expect(cache).toBeInstanceOf(TtlLruCache);
    });
  });

  describe("basic get and set operations", () => {
    it("should return undefined for non-existent key", () => {
      const cache = new TtlLruCache<string>(1000, 10);
      expect(cache.get("missing")).toBeUndefined();
    });

    it("should store and retrieve values", () => {
      const cache = new TtlLruCache<string>(1000, 10);
      cache.set("key1", "value1");
      expect(cache.get("key1")).toBe("value1");
    });

    it("should handle various value types", () => {
      const cache = new TtlLruCache<{ count: number } | number[] | null>(1000, 10);
      const obj = { count: 42 };
      const arr = [1, 2, 3];

      cache.set("obj", obj);
      cache.set("arr", arr);
      cache.set("nullVal", null);

      expect(cache.get("obj")).toBe(obj);
      expect(cache.get("arr")).toBe(arr);
      expect(cache.get("nullVal")).toBeNull();
    });

    it("should overwrite existing key with updated value", () => {
      const cache = new TtlLruCache<string>(1000, 10);
      cache.set("key1", "initial");
      expect(cache.get("key1")).toBe("initial");

      cache.set("key1", "updated");
      expect(cache.get("key1")).toBe("updated");
    });
  });

  describe("TTL expiry with fake timers", () => {
    it("should return entry before TTL expires", () => {
      const ttlMs = 1000;
      const cache = new TtlLruCache<string>(ttlMs, 10);

      cache.set("key1", "val1");
      vi.advanceTimersByTime(500);

      expect(cache.get("key1")).toBe("val1");
    });

    it("should still return entry at exact expiry boundary (Date.now() == expiresAt)", () => {
      const ttlMs = 1000;
      const cache = new TtlLruCache<string>(ttlMs, 10);

      cache.set("key1", "val1");
      vi.advanceTimersByTime(1000);

      // Date.now() > entry.expiresAt is false when Date.now() == expiresAt
      expect(cache.get("key1")).toBe("val1");
    });

    it("should return undefined and evict entry when TTL has expired", () => {
      const ttlMs = 1000;
      const cache = new TtlLruCache<string>(ttlMs, 10);

      cache.set("key1", "val1");
      vi.advanceTimersByTime(1001);

      // Should return undefined when expired
      expect(cache.get("key1")).toBeUndefined();

      // Subsequent get should hit the !entry branch since it was deleted
      expect(cache.get("key1")).toBeUndefined();
    });

    it("should reset TTL when overwriting a key", () => {
      const ttlMs = 1000;
      const cache = new TtlLruCache<string>(ttlMs, 10);

      cache.set("key1", "val1");
      vi.advanceTimersByTime(800);

      // Overwrite resets expiresAt to Date.now() + ttlMs
      cache.set("key1", "val2");

      // Advance past original expiration (800 + 400 = 1200ms from start, but 400ms from new set)
      vi.advanceTimersByTime(400);
      expect(cache.get("key1")).toBe("val2");

      // Advance past new expiration (another 601ms -> 1001ms from new set)
      vi.advanceTimersByTime(601);
      expect(cache.get("key1")).toBeUndefined();
    });

    it("should handle independent TTL expirations for multiple keys", () => {
      const ttlMs = 1000;
      const cache = new TtlLruCache<string>(ttlMs, 10);

      cache.set("key1", "val1");
      vi.advanceTimersByTime(600);
      cache.set("key2", "val2");

      vi.advanceTimersByTime(401);
      // key1 is now at 1001ms -> expired
      // key2 is at 401ms -> valid
      expect(cache.get("key1")).toBeUndefined();
      expect(cache.get("key2")).toBe("val2");

      vi.advanceTimersByTime(600);
      // key2 is now at 1001ms -> expired
      expect(cache.get("key2")).toBeUndefined();
    });

    it("should expire immediately if TTL is zero", () => {
      const cache = new TtlLruCache<string>(0, 10);
      cache.set("key1", "val1");

      // At insertion time, expiresAt == Date.now()
      expect(cache.get("key1")).toBe("val1");

      // Once time advances even 1ms, Date.now() > expiresAt
      vi.advanceTimersByTime(1);
      expect(cache.get("key1")).toBeUndefined();
    });

    it("should expire immediately if TTL is negative", () => {
      const cache = new TtlLruCache<string>(-100, 10);
      cache.set("key1", "val1");

      // expiresAt is in the past compared to Date.now()
      expect(cache.get("key1")).toBeUndefined();
    });
  });

  describe("LRU eviction at small limits", () => {
    it("should evict the oldest entry when capacity is exceeded", () => {
      const cache = new TtlLruCache<string>(60_000, 2);

      cache.set("a", "1");
      cache.set("b", "2");
      cache.set("c", "3");

      // "a" should be evicted
      expect(cache.get("a")).toBeUndefined();
      expect(cache.get("b")).toBe("2");
      expect(cache.get("c")).toBe("3");
    });

    it("should refresh recency on get so accessed entry is not evicted", () => {
      const cache = new TtlLruCache<string>(60_000, 2);

      cache.set("a", "1");
      cache.set("b", "2");

      // Access "a" to make it more recent than "b"
      expect(cache.get("a")).toBe("1");

      // Insert "c" -> capacity exceeded, oldest is now "b"
      cache.set("c", "3");

      expect(cache.get("a")).toBe("1");
      expect(cache.get("b")).toBeUndefined();
      expect(cache.get("c")).toBe("3");
    });

    it("should refresh recency on set update so overwritten entry is not evicted", () => {
      const cache = new TtlLruCache<string>(60_000, 2);

      cache.set("a", "1");
      cache.set("b", "2");

      // Update "a" to make it more recent than "b"
      cache.set("a", "1-updated");

      // Insert "c" -> oldest is "b"
      cache.set("c", "3");

      expect(cache.get("a")).toBe("1-updated");
      expect(cache.get("b")).toBeUndefined();
      expect(cache.get("c")).toBe("3");
    });

    it("should work with a maxSize of 1", () => {
      const cache = new TtlLruCache<string>(60_000, 1);

      cache.set("a", "1");
      expect(cache.get("a")).toBe("1");

      cache.set("b", "2");
      expect(cache.get("a")).toBeUndefined();
      expect(cache.get("b")).toBe("2");
    });

    it("should correctly handle capacity with 3 items", () => {
      const cache = new TtlLruCache<string>(60_000, 3);

      cache.set("k1", "v1");
      cache.set("k2", "v2");
      cache.set("k3", "v3");

      // Access k1, then k2
      cache.get("k1");
      cache.get("k2");

      // Insert k4 -> oldest is k3
      cache.set("k4", "v4");

      expect(cache.get("k3")).toBeUndefined();
      expect(cache.get("k1")).toBe("v1");
      expect(cache.get("k2")).toBe("v2");
      expect(cache.get("k4")).toBe("v4");
    });
  });

  describe("clear", () => {
    it("should clear all cached entries", () => {
      const cache = new TtlLruCache<string>(60_000, 10);

      cache.set("key1", "val1");
      cache.set("key2", "val2");

      cache.clear();

      expect(cache.get("key1")).toBeUndefined();
      expect(cache.get("key2")).toBeUndefined();
    });

    it("should allow adding new entries after being cleared", () => {
      const cache = new TtlLruCache<string>(60_000, 10);

      cache.set("key1", "val1");
      cache.clear();

      cache.set("key2", "val2");
      expect(cache.get("key1")).toBeUndefined();
      expect(cache.get("key2")).toBe("val2");
    });
  });
});
