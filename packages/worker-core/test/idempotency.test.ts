import { describe, it, expect, afterEach, beforeEach, vi} from "vitest";
import { InMemoryClaimStore, IdempotencyManager, fireKeyToString } from "../src/idempotency";

describe("fireKeyToString", () => {
  it("produces a stable string for the same key", () => {
    const key = { workerId: "w1", windowStartLedger: 10 };
    const a = fireKeyToString(key);
    const b = fireKeyToString({ workerId: "w1", windowStartLedger: 10 });
    expect(a).toBe(b);
    expect(typeof a).toBe("string");
    expect(a.length).toBeGreaterThan(0);
  });

  it("produces distinct strings for different keys", () => {
    const a = fireKeyToString({ workerId: "w1", windowStartLedger: 10 });
    const b = fireKeyToString({ workerId: "w1", windowStartLedger: 11 });
    const c = fireKeyToString({ workerId: "w2", windowStartLedger: 10 });
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
    expect(b).not.toBe(c);
  });

  it("includes the worker id and ledger in the result", () => {
    const s = fireKeyToString({ workerId: "worker-xyz", windowStartLedger: 4242 });
    expect(s).toContain("worker-xyz");
    expect(s).toContain("4242");
  });
});

describe("InMemoryClaimStore", () => {
  it("returns undefined for a key that was never claimed", async () => {
    const store = new InMemoryClaimStore();
    expect(await store.get("missing")).toBeUndefined();
  });

  it("stores and retrieves a claim record", async () => {
    const store = new InMemoryClaimStore();
    const key = fireKeyToString({ workerId: "w1", windowStartLedger: 1 });
    const claimed = await store.claim(key, "owner-a", 1000);
    expect(claimed).toBe(true);
    const rec = await store.get(key);
    expect(rec).toBeTruthy();
    expect(rec?.owner).toBe("owner-a");
  });

  it("refuses a second claim while the first is live", async () => {
    const store = new InMemoryClaimStore();
    const key = fireKeyToString({ workerId: "w1", windowStartLedger: 2 });
    expect(await store.claim(key, "owner-a", 1000)).toBe(true);
    expect(await store.claim(key, "owner-b", 1000)).toBe(false);
    expect((await store.get(key))?.owner).toBe("owner-a");
  });

  it("releases a claim so it can be re-claimed", async () => {
    const store = new InMemoryClaimStore();
    const key = fireKeyToString({ workerId: "w1", windowStartLedger: 3 });
    expect(await store.claim(key, "owner-a", 1000)).toBe(true);
    await store.release(key);
    expect(await store.get(key)).toBeUndefined();
    expect(await store.claim(key, "owner-b", 1000)).toBe(true);
    expect((await store.get(key))?.owner).toBe("owner-b");
  });

  it("release of a missing key is a no-op", async () => {
    const store = new InMemoryClaimStore();
    await expect(store.release("never-claimed")).resolves.toUndefined();
    expect(await store.get("never-claimed")).toBeUndefined();
  });

  it("expires a claim after the TTL", async () => {
    vi.useFakeTimers();
    try {
      const store = new InMemoryClaimStore();
      const key = fireKeyToString({ workerId: "w1", windowStartLedger: 4 });
      expect(await store.claim(key, "owner-a", 1000)).toBe(true);
      vi.advanceTimes(999);
      expect(await store.claim(key, "owner-b", 1000)).toBe(false);
      vi.advanceTimes(2);
      expect(await store.claim(key, "owner-b", 1000)).toBe(true);
      expect((await store.get(key))?.owner).toBe("owner-b");
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
    const key = { workerId: "w3", windowStartLedger: 30 };

    await mgr.claimThenSubmit(key, "process-a", async () => undefined);
    const secondAttempt = await mgr.claimThenSubmit(key, "process-b", async () => undefined);

    expect(secondAttempt).toBe(false);
    expect((await store.get(fireKeyToString(key)))?.owner).toBe("process-a");
  });

  it("returns false without running the callback when another owner holds the claim", async () => {
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

  it("propagates a callback error and releases the claim for retry", async () => {
    const store = new InMemoryClaimStore();
    const mgr = new IdempotencyManager(store, async () => false, 1000);
    const key = { workerId: "w5", windowStartLedger: 50 };

    await expect(
      mgr.claimThenSubmit(key, "owner-a", async () => {
        throw new Error("submit failed");
      }),
    ).rejects.toThrow("submit failed");

    // After a failure the claim should be released so a retry can proceed.
    expect(await store.get(fireKeyToString(key))).toBeUndefined();
    const retried = await mgr.claimThenSubmit(key, "owner-b", async () => undefined);
    expect(retried).toBe(true);
  });
});
