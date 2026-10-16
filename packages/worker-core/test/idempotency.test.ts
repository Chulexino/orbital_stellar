import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  InMemoryClaimStore,
  IdempotencyManager,
  fireKeyToString,
} from "../src/idempotency";

describe("fireKeyToString", () => {
  it("formats a key as workerId:windowStartLedger", () => {
    expect(fireKeyToString({ workerId: "w1", windowStartLedger: 10 })).toBe("w1:10");
  });

  it("is stable for the same key values", () => {
    const key = { workerId: "worker-a", windowStartLedger: 42 };
    expect(fireKeyToString(key)).toBe(fireKeyToString({ ...key }));
  });

  it("produces different strings for different workers or ledgers", () => {
    const a = fireKeyToString({ workerId: "w1", windowStartLedger: 1 });
    const b = fireKeyToString({ workerId: "w2", windowStartLedger: 1 });
    const c = fireKeyToString({ workerId: "w1", windowStartLedger: 2 });
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
  });
});

describe("InMemoryClaimStore", () => {
  it("returns undefined for an unknown key", async () => {
    const store = new InMemoryClaimStore();
    await expect(store.get("missing")).resolves.toBeUndefined();
  });

  it("claims a free key and records the owner", async () => {
    const store = new InMemoryClaimStore();
    const claimed = await store.claim("key-1", "owner-a", 1000);
    expect(claimed).toBe(true);
    const rec = await store.get("key-1");
    expect(rec).toMatchObject({ owner: "owner-a" });
  });

  it("rejects a claim from a different owner while the lease is live", async () => {
    const store = new InMemoryClaimStore();
    await store.claim("key-2", "owner-a", 1000);
    const second = await store.claim("key-2", "owner-b", 1000);
    expect(second).toBe(false);
    expect((await store.get("key-2"))?.owner).toBe("owner-a");
  });

  it("allows the same owner to re-claim and refreshes the lease", async () => {
    const store = new InMemoryClaimStore();
    await store.claim("key-3", "owner-a", 1000);
    const reclaimed = await store.claim("key-3", "owner-a", 2000);
    expect(reclaimed).toBe(true);
    expect((await store.get("key-3"))?.owner).toBe("owner-a");
  });

  it("allows a new owner to claim after the lease expires", async () => {
    vi.useFakeTimers();
    try {
      const store = new InMemoryClaimStore();
      await store.claim("key-4", "owner-a", 1000);
      vi.advanceTimesBy(1001);
      const claimed = await store.claim("key-4", "owner-b", 1000);
      expect(claimed).toBe(true);
      expect((await store.get("key-4"))?.owner).toBe("owner-b");
    } finally {
      vi.useRealTimers();
    }
  });

  it("treats a lease as expired at the exact expiry boundary", async () => {
    vi.useFakeTimers();
    try {
      const store = new InMemoryClaimStore();
      await store.claim("key-5", "owner-a", 1000);
      vi.advanceTimesBy(1000);
      const claimed = await store.claim("key-5", "owner-b", 1000);
      expect(claimed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("releases a claim owned by the caller", async () => {
    const store = new InMemoryClaimStore();
    await store.claim("key-6", "owner-a", 1000);
    await store.release("key-6", "owner-a");
    await expect(store.get("key-6")).resolves.toBeUndefined();
  });

  it("does not release a claim owned by someone else", async () => {
    const store = new InMemoryClaimStore();
    await store.claim("key-7", "owner-a", 1000);
    await store.release("key-7", "owner-b");
    expect((await store.get("key-7"))?.owner).toBe("owner-a");
  });

  it("is a no-op when releasing an unknown key", async () => {
    const store = new InMemoryClaimStore();
    await expect(store.release("missing", "owner-a")).resolves.toBeUndefined();
  });
});

describe("IdempotencyManager basic behavior", () => {
  it("allows a single owner to claim, submit, and release", async () => {
    const store = new InMemoryClaimStore();
    const chainSeen = false;
    const mgr = new IdempotencyManager(store, async () => chainSeen, 1000);

    const key = { workerId: "w1", windowStartLedger: 10 };
    let ran = false;
    const submitted = await mgr.claimThenSubmit(key, "w1", async () => {
      ran = true;
    });
    expect(submitted).toBe(true);
    expect(ran).toBe(true);

    // Keep the claim until the confirmation-lag TTL expires.
    const rec = await store.get(fireKeyToString(key));
    expect(rec?.owner).toBe("w1");
  });

  it("skips submit if chain already shows execution", async () => {
    const store = new InMemoryClaimStore();
    const chainSeen = true;
    const mgr = new IdempotencyManager(store, async () => chainSeen, 1000);

    const key = { workerId: "w2", windowStartLedger: 20 };
    let ran = false;
    const submitted = await mgr.claimThenSubmit(key, "w2", async () => {
      ran = true;
    });
    expect(submitted).toBe(false);
    expect(ran).toBe(false);
  });

  it("keeps a successful submission claim until the TTL expires", async () => {
    const store = new InMemoryClaimStore();
    const mgr = new IdempotencyManager(store, async () => false, 1000);
    const key = { workerId: "w3", windowStartLedger: 30 };

    await mgr.claimThenSubmit(key, "process-a", async () => undefined);
    const secondAttempt = await mgr.claimThenSubmit(key, "process-b", async () => undefined);

    expect(secondAttempt).toBe(false);
    expect((await store.get(fireKeyToString(key)))?.owner).toBe("process-a");
  });
});

describe("IdempotencyManager claim contention", () => {
  it("returns false when another owner holds a live claim", async () => {
    const store = new InMemoryClaimStore();
    const mgr = new IdempotencyManager(store, async () => false, 1000);
    const key = { workerId: "w4", windowStartLedger: 40 };

    await store.claim(fireKeyToString(key), "other-owner", 1000);
    let ran = false;
    const submitted = await mgr.claimThenSubmit(key, "my-owner", async () => {
      ran = true;
    });

    expect(submitted).toBe(false);
    expect(ran).toBe(false);
  });

  it("allows a new owner to claim and submit after the claim expires", async () => {
    vi.useFakeTimers();
    try {
      const store = new InMemoryClaimStore();
      const mgr = new IdempotencyManager(store, async () => false, 1000);
      const key = { workerId: "w5", windowStartLedger: 50 };

      await store.claim(fireKeyToString(key), "other-owner", 1000);
      vi.advanceTimesBy(1001);

      let ran = false;
      const submitted = await mgr.claimThenSubmit(key, "my-owner", async () => {
        ran = true;
      });

      expect(submitted).toBe(true);
      expect(ran).toBe(true);
      expect((await store.get(fireKeyToString(key)))?.owner).toBe("my-owner");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("IdempotencyManager failure and release paths", () => {
  it("releases the claim when the submit callback throws", async () => {
    const store = new InMemoryClaimStore();
    const mgr = new IdempotencyManager(store, async () => false, 1000);
    const key = { workerId: "w6", windowStartLedger: 60 };
    const error = new Error("submit failed");

    await expect(
      mgr.claimThenSubmit(key, "w6", async () => {
        throw error;
      }),
    ).rejects.toThrow(error);

    await expect(store.get(fireKeyToString(key))).resolves.toBeUndefined();
  });

  it("allows a retry after a failed submit releases the claim", async () => {
    const store = new InMemoryClaimStore();
    const mgr = new IdempotencyManager(store, async () => false, 1000);
    const key = { workerId: "w7", windowStartLedger: 70 };

    await expect(
      mgr.claimThenSubmit(key, "w7", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow();

    let ran = false;
    const submitted = await mgr.claimThenSubmit(key, "w7", async () => {
      ran = true;
    });

    expect(submitted).toBe(true);
    expect(ran).toBe(true);
  });

  it("releases the claim when the chain check throws", async () => {
    const store = new InMemoryClaimStore();
    const mgr = new IdempotencyManager(store, async () => {
      throw new Error("chain unavailable");
    }, 1000);
    const key = { workerId: "w8", windowStartLedger: 80 };

    await expect(
      mgr.claimThenSubmit(key, "w8", async () => undefined),
    ).rejects.toThrow("chain unavailable");

    await expect(store.get(fireKeyToString(key))).resolves.toBeUndefined();
  });

  it("does not release a claim that was taken over by another owner before failure", async () => {
    const store = new InMemoryClaimStore();
    const mgr = new IdempotencyManager(store, async () => false, 1000);
    const key = { workerId: "w9", windowStartLedger: 90 };

    await expect(
      mgr.claimThenSubmit(key, "w9", async () => {
        // Simulate another owner taking over the claim before this submit fails.
        await store.release(fireKeyToString(key), "w9");
        await store.claim(fireKeyToString(key), "other-owner", 1000);
        throw new Error("late failure");
      }),
    ).rejects.toThrow("late failure");

    expect((await store.get(fireKeyToString(key)))?.owner).toBe("other-owner");
  });
});

describe("IdempotencyManager timer and expiry behavior", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("allows a new owner to claim and submit after the confirmation-lag TTL expires", async () => {
    const store = new InMemoryClaimStore();
    const ttlMs = 1000;
    const mgr = new IdempotencyManager(store, async () => false, ttlMs);
    const key = { workerId: "w10", windowStartLedger: 100 };

    await mgr.claimThenSubmit(key, "owner-a", async () => undefined);
    via.advanceTimesBy(ttlMs + 1);

    let ran = false;
    const submitted = await mgr.claimThenSubmit(key, "owner-b", async () => {
      ran = true;
    });

    expect(submitted).toBe(true);
    expect(ran).toBe(true);
    expect((await store.get(fireKeyToString(key)))?.owner).toBe("owner-b");
  });

  it("still blocks a new owner before the TTL expires", async () => {
    const store = new InMemoryClaimStore();
    const ttlMs = 1000;
    const mgr = new IdempotencyManager(store, async () => false, ttlMs);
    const key = { workerId: "w11", windowStartLedger: 110 };

    await mgr.claimThenSubmit(key, "owner-a", async () => undefined);
    vi.advanceTimesBy(ttlMs - 1);

    const submitted = await mgr.claimThenSubmit(key, "owner-b", async () => undefined);
    expect(submitted).toBe(false);
  });

  it("expires the claim at the exact TTL boundary", async () => {
    const store = new InMemoryClaimStore();
    const ttlMs = 1000;
    const mgr = new IdempotencyManager(store, async () => false, ttlMs);
    const key = { workerId: "w12", windowStartLedger: 120 };

    await mgr.claimThenSubmit(key, "owner-a", async () => undefined);
    vi.advanceTimesBy(ttlMs);

    const submitted = await mgr.claimThenSubmit(key, "owner-b", async () => undefined);
    expect(submitted).toBe(true);
  });

  it("does not call the chain check when the claim is contended", async () => {
    const store = new InMemoryClaimStore();
    const check = vi.fn(async () => false);
    const mgr = new IdempotencyManager(store, check, 1000);
    const key = { workerId: "w13", windowStartLedger: 130 };

    await store.claim(fireKeyToString(key), "other-owner", 1000);
    const submitted = await mgr.claimThenSubmit(key, "my-owner", async () => undefined);

    expect(submitted).toBe(false);
    expect(check).not.toHaveBeenCalled();
  });

  it("checks the chain before claiming and skips the claim when already executed", async () => {
    const store = new InMemoryClaimStore();
    const check = vi.fn(async () => true);
    const mgr = new IdempotencyManager(store, check, 1000);
    const key = { workerId: "w14", windowStartLedger: 140 };

    const submitted = await mgr.claimThenSubmit(key, "w14", async () => undefined);

    expect(submitted).toBe(false);
    expect(check).toHaveBeenCalledOnce();
    await expect(store.get(fireKeyToString(key))).resolves.toBeUndefined();
  });
});
