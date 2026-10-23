import { describe, it, expect, beforeEach, afterEach, vi} from "vitest";
import { InMemoryClaimStore, IdempotencyManager, fireKeyToString } from "../src/idempotency";

describe("fireKeyToString", () => {
  it("produces a stable string for the same key", () => {
    const key = { workerId: "w1", windowStartLedger: 123 };
    const a = fireKeyToString(key);
    const b = fireKeyToString({ workerId: "w1", windowStartLedger: 123 });
    expect(typeof a).toBe("string");
    expect(a.length).toBeGreaterThan(0);
    expect(a).toBe(b);
  });

  it("differentiates keys by workerId and ledger", () => {
    const base = fireKeyToString({ workerId: "w1", windowStartLedger: 100 });
    const otherWorker = fireKeyToString({ workerId: "w2", windowStartLedger: 100 });
    const otherLedger = fireKeyToString({ workerId: "w1", windowStartLedger: 101 });
    expect(base).not.toBe(otherWorker);
    expect(base).not.toBe(otherLedger);
    expect(otherWorker).not.toBe(otherLedger);
  });

  it("includes the workerId and ledger in the output", () => {
    const str = fireKeyToString({ workerId: "alpha", windowStartLedger: 42 });
    expect(str).contains("alpha");
    expect(str).contains("42");
  });
});

describe("InMemoryClaimStore", () => {
  it("returns undefined for an unknown key", async () => {
    const store = new InMemoryClaimStore();
    expect(await store.get("missing")).toBeUndefined();
  });

  it("allows the first owner to claim and rejects a second owner", async () => {
    const store = new InMemoryClaimStore();
    const key = fireKeyToString({ workerId: "w1", windowStartLedger: 10 });
    const first = await store.claim(key, "owner-a", 1000);
    expect(first).toBe(true);
    const second = await store.claim(key, "owner-b", 1000);
    expect(second).toBe(false);
    expect((await store.get(key))?.owner).toBe("owner-a");
  });

  it("allows the same owner to re-claim", async () => {
    const store = new InMemoryClaimStore();
    const key = fireKeyToString({ workerId: "w1", windowStartLedger: 11 });
    expect(await store.claim(key, "owner-a", 1000)).toBe(true);
    expect(await store.claim(key, "owner-a", 1000)).toBe(true);
  });

  it("releases a claim held by the owner", async () => {
    const store = new InMemoryClaimStore();
    const key = fireKeyToString({ workerId: "w1", windowStartLedger: 12 });
    await store.claim(key, "owner-a", 1000);
    await store.release(key, "owner-a");
    expect(await store.get(key)).toBeUndefined();
    expect(await store.claim(key, "owner-b", 1000)).toBe(true);
  });

  it("ignores release from a non-owner", async () => {
    const store = new InMemoryClaimStore();
    const key = fireKeyToString({ workerId: "w1", windowStartLedger: 13 });
    await store.claim(key, "owner-a", 1000);
    await store.release(key, "owner-b");
    expect((await store.get(key))?.owner).toBe("owner-a");
  });

  it("release of a missing key is a no-op", async () => {
    const store = new InMemoryClaimStore();
    await expect(store.release("missing", "owner-a")).resolves.toBeUndefined();
  });

  it("expires a claim after the TTL", async () => {
    vi.useFakeTimers();
    try {
      const store = new InMemoryClaimStore();
      const key = fireKeyToString({ workerId: "w1", windowStartLedger: 14 });
      expect(await store.claim(key, "owner-a", 1000)).toBe(true);
      vi.advanceTimersByTime(1001);
      expect(await store.get(key)).toBeUndefined();
      expect(await store.claim(key, "owner-b", 1000)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not expire a claim before the TTL", async () => {
    vi.useFakeTimers();
    try {
      const store = new InMemoryClaimStore();
      const key = fireKeyToString({ workerId: "w1", windowStartLedger: 15 });
      await store.claim(key, "owner-a", 1000);
      vi.advanceTimersByTime(999);
      expect((await store.get(key))?.owner).toBe("owner-a");
      expect(await store.claim(key, "owner-b", 1000)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
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
    const key = { workerId: "w7", windowStartLedger: 30 };

    await mgr.claimThenSubmit(key, "process-a", async () => undefined);
    const secondAttempt = await mgr.claimThenSubmit(key, "process-b", async () => undefined);

    expect(secondAttempt).toBe(false);
    expect((await store.get(fireKeyToString(key)))?.owner).toBe("process-a");
  });

  it("does not run the submit function when another owner holds the claim", async () => {
    const store = new InMemoryClaimStore();
    const mgr = new IdempotencyManager(store, async () => false, 1000);
    const key = { workerId: "w4", windowStartLedger: 40 };

    await mgr.claimThenSubmit(key, "owner-a", async () => undefined);
    let ran = false;
    const submitted = await mgr.claimThenSubmit(key, "owner-b", async () => {
      ran = true;
    });
    expect(submitted).toBe(false);
    expect(ran).toBe(false);
  });

  it("allows a new owner after the claim TTL expires", async () => {
    vi.useFakeTimers();
    try {
      const store = new InMemoryClaimStore();
      const mgr = new IdempotencyManager(store, async () => false, 1000);
      const key = { workerId: "w5", windowStartLedger: 50 };

      await mgr.claimThenSubmit(key, "owner-a", async () => undefined);
      vi.advanceTimersByTime(1001);

      let ran = false;
      const submitted = await mgr.claimThenSubmit(key, "owner-b", async () => {
        ran = true;
      });
      expect(submitted).toBe(true);
      expect(ran).toBe(true);
      expect((await store.get(fireKeyToString(key)))?.owner).toBe("owner-b");
    } finally {
      vi.useRealTimers();
    }
  });
});
