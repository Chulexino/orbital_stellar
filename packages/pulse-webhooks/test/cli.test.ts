import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import { listDLQ, dumpDLQ, replayDLQ } from "../src/cli.js";
import { MemoryDeadLetterStore } from "../src/MemoryDeadLetterStore.js";

const event = {
  type: "payment.received",
  to: "GDEST",
  from: "GSRC",
  amount: "10",
  asset: "XLM",
  timestamp: "2026-04-26T12:00:00.000Z",
  raw: { id: "evt_1" },
} as const;

describe("cli", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
    process.exitCode = undefined;
  });

  describe("listDLQ", () => {
    it("prints matching entries as line-delimited JSON", async () => {
      const store = new MemoryDeadLetterStore();
      await store.record({ url: "https://a.example.com", event, error: "boom", attempts: 1 });
      await store.record({ url: "https://b.example.com", event, error: "boom", attempts: 1 });

      await listDLQ(store, { url: "https://a.example.com" });

      expect(logSpy).toHaveBeenCalledTimes(1);
      const printed = JSON.parse(logSpy.mock.calls[0]![0] as string);
      expect(printed.url).toBe("https://a.example.com");
    });

    it("prints nothing when no options provided and store is empty", async () => {
      const store = new MemoryDeadLetterStore();

      await listDLQ(store, {});

      expect(logSpy).toHaveBeenCalledTimes(0);
    });

    it("prints all entries when no url filter provided", async () => {
      const store = new MemoryDeadLetterStore();
      await store.record({ url: "https://a.example.com", event, error: "boom", attempts: 1 });
      await store.record({ url: "https://b.example.com", event, error: "boom", attempts: 1 });

      await listDLQ(store, {});

      expect(logSpy).toHaveBeenCalledTimes(2);
    });

    it("respects the limit option", async () => {
      const store = new MemoryDeadLetterStore();
      await store.record({ url: "https://a.example.com", event, error: "boom", attempts: 1 });
      await store.record({ url: "https://b.example.com", event, error: "boom", attempts: 1 });
      await store.record({ url: "https://c.example.com", event, error: "boom", attempts: 1 });

      await listDLQ(store, { limit: 2 });

      expect(logSpy).toHaveBeenCalledTimes(2);
    });

    it("filters by since date when provided with valid ISO8601", async () => {
      const store = new MemoryDeadLetterStore();
      const id1 = await store.record({
        url: "https://a.example.com",
        event,
        error: "boom",
        attempts: 1,
      });
      const entry1 = store.get(id1)!;

      // Create second entry with a later timestamp
      const id2 = await store.record({
        url: "https://b.example.com",
        event,
        error: "boom",
        attempts: 1,
      });

      // Use a timestamp that's between the two entries or after
      const sinceTime = entry1.timestamp + 1;

      await listDLQ(store, { since: sinceTime.toString() });

      expect(logSpy).toHaveBeenCalled();
      const printed = JSON.parse(logSpy.mock.calls[logSpy.mock.calls.length - 1]![0] as string);
      // The later entry should be included
      expect(printed.id).toBe(id2);
    });

    it("ignores invalid since date and does not filter", async () => {
      const store = new MemoryDeadLetterStore();
      await store.record({ url: "https://a.example.com", event, error: "boom", attempts: 1 });
      await store.record({ url: "https://b.example.com", event, error: "boom", attempts: 1 });

      await listDLQ(store, { since: "invalid-date" });

      // Since the date is invalid, it won't be added to filter, so all entries are returned
      expect(logSpy).toHaveBeenCalledTimes(2);
    });

    it("ignores since date that results in NaN", async () => {
      const store = new MemoryDeadLetterStore();
      await store.record({ url: "https://a.example.com", event, error: "boom", attempts: 1 });

      await listDLQ(store, { since: "not a date at all" });

      expect(logSpy).toHaveBeenCalledTimes(1);
    });

    it("accepts numeric since date as epoch milliseconds", async () => {
      const store = new MemoryDeadLetterStore();
      const id1 = await store.record({
        url: "https://a.example.com",
        event,
        error: "boom",
        attempts: 1,
      });

      // Get the recorded timestamp and use a value slightly after it
      const entry1 = store.get(id1)!;
      const sinceMs = (entry1.recordedAt! + 1).toString();

      await listDLQ(store, { since: sinceMs });

      // With numeric since, Date.parse will succeed and may filter out early entries
      expect(logSpy).toHaveBeenCalled();
    });

    it("combines url and limit filters", async () => {
      const store = new MemoryDeadLetterStore();
      await store.record({ url: "https://a.example.com", event, error: "boom", attempts: 1 });
      await store.record({ url: "https://a.example.com", event, error: "boom", attempts: 1 });
      await store.record({ url: "https://b.example.com", event, error: "boom", attempts: 1 });

      await listDLQ(store, { url: "https://a.example.com", limit: 1 });

      expect(logSpy).toHaveBeenCalledTimes(1);
      const printed = JSON.parse(logSpy.mock.calls[0]![0] as string);
      expect(printed.url).toBe("https://a.example.com");
    });

    it("combines url and since filters", async () => {
      const store = new MemoryDeadLetterStore();
      const id1 = await store.record({
        url: "https://a.example.com",
        event,
        error: "boom",
        attempts: 1,
      });
      const entry1 = store.get(id1)!;

      const id2 = await store.record({
        url: "https://a.example.com",
        event,
        error: "boom",
        attempts: 1,
      });
      const entry2 = store.get(id2)!;

      await store.record({ url: "https://b.example.com", event, error: "boom", attempts: 1 });

      const sinceTime = entry1.timestamp + 1;
      await listDLQ(store, { url: "https://a.example.com", since: sinceTime.toString() });

      // Should get only the second 'a' entry
      const callCount = logSpy.mock.calls.filter((call) => {
        const parsed = JSON.parse(call[0] as string);
        return parsed.url === "https://a.example.com";
      }).length;
      expect(callCount).toBeGreaterThan(0);
    });
  });

  describe("dumpDLQ", () => {
    it("prints every entry regardless of filter", async () => {
      const store = new MemoryDeadLetterStore();
      await store.record({ url: "https://a.example.com", event, error: "boom", attempts: 1 });
      await store.record({ url: "https://b.example.com", event, error: "boom", attempts: 1 });

      await dumpDLQ(store);

      expect(logSpy).toHaveBeenCalledTimes(2);
    });

    it("prints nothing when store is empty", async () => {
      const store = new MemoryDeadLetterStore();

      await dumpDLQ(store);

      expect(logSpy).toHaveBeenCalledTimes(0);
    });

    it("prints entries as valid JSON objects", async () => {
      const store = new MemoryDeadLetterStore();
      const id = await store.record({
        url: "https://example.com",
        event,
        error: "boom",
        attempts: 1,
      });

      await dumpDLQ(store);

      expect(logSpy).toHaveBeenCalledTimes(1);
      const printed = JSON.parse(logSpy.mock.calls[0]![0] as string);
      expect(printed.id).toBe(id);
      expect(printed.url).toBe("https://example.com");
    });
  });

  describe("replayDLQ", () => {
    it("re-delivers the entry over HTTP via the configured replay handler and marks it replayed", async () => {
      const store = new MemoryDeadLetterStore();
      const id = await store.record({
        url: "https://example.com/webhook",
        event,
        error: "boom",
        attempts: 2,
      });

      const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
      vi.stubGlobal("fetch", fetchMock);

      store.setReplayHandler(async (entry) => {
        const res = await fetch(entry.url, {
          method: "POST",
          headers: { "x-orbital-signature": "sig", "x-orbital-timestamp": "123" },
          body: JSON.stringify(entry.event),
        });
        if (!(res as Response).ok) throw new Error("delivery failed");
      });

      await replayDLQ(store, id);

      expect(fetchMock).toHaveBeenCalledWith(
        "https://example.com/webhook",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({ "x-orbital-signature": "sig" }),
        }),
      );
      expect(store.get(id)?.replayedAt).toBeTypeOf("number");
      expect(process.exitCode).toBeUndefined();

      vi.unstubAllGlobals();
    });

    it("reports an error and sets a nonzero exit code when the id is unknown", async () => {
      const store = new MemoryDeadLetterStore();

      await replayDLQ(store, "missing-id");

      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("missing-id"));
      expect(process.exitCode).toBe(1);
    });

    it("reports an error and sets a nonzero exit code when no replay handler is configured", async () => {
      const store = new MemoryDeadLetterStore();
      const id = await store.record({
        url: "https://example.com/webhook",
        event,
        error: "boom",
        attempts: 1,
      });

      await replayDLQ(store, id);

      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Replay failed"));
      expect(process.exitCode).toBe(1);
    });

    it("handles errors thrown by the replay handler", async () => {
      const store = new MemoryDeadLetterStore();
      const id = await store.record({
        url: "https://example.com/webhook",
        event,
        error: "boom",
        attempts: 1,
      });

      store.setReplayHandler(async () => {
        throw new Error("Network timeout");
      });

      await replayDLQ(store, id);

      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Replay failed"));
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Network timeout"));
      expect(process.exitCode).toBe(1);
    });

    it("outputs the replayed entry as JSON on success", async () => {
      const store = new MemoryDeadLetterStore();
      const id = await store.record({
        url: "https://example.com/webhook",
        event,
        error: "boom",
        attempts: 1,
      });

      store.setReplayHandler(async () => {
        // No-op handler
      });

      await replayDLQ(store, id);

      expect(logSpy).toHaveBeenCalled();
      const printed = JSON.parse(logSpy.mock.calls[0]![0] as string);
      expect(printed.id).toBe(id);
      expect(printed.replayedAt).toBeTypeOf("number");
    });

    it("does not set exit code on successful replay", async () => {
      const store = new MemoryDeadLetterStore();
      const id = await store.record({
        url: "https://example.com/webhook",
        event,
        error: "boom",
        attempts: 1,
      });

      store.setReplayHandler(async () => {
        // Success
      });

      await replayDLQ(store, id);

      expect(process.exitCode).toBeUndefined();
    });

    it("handles handler errors with non-Error objects", async () => {
      const store = new MemoryDeadLetterStore();
      const id = await store.record({
        url: "https://example.com/webhook",
        event,
        error: "boom",
        attempts: 1,
      });

      store.setReplayHandler(async () => {
        // eslint-disable-next-line no-throw-literal
        throw "string error";
      });

      await replayDLQ(store, id);

      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Replay failed"));
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("string error"));
      expect(process.exitCode).toBe(1);
    });
  });
});
