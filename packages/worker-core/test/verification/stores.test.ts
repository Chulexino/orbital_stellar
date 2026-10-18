import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FileCheckpointStore,
  FileVerdictSink,
  InMemoryCheckpointStore,
  InMemoryVerdictSink,
  type BackfillCheckpoint,
  type VerdictSink,
} from "../../src/verification/stores.js";
import { computeVerdict } from "../../src/verification/verdict.js";

const checkpoint: BackfillCheckpoint = {
  lastProcessedLedger: 150,
  updatedAt: "2026-01-01T00:00:00.000Z",
};

function verdict(subject = "GAAA", startLedger = 100, endLedger = 150) {
  return computeVerdict(subject, { startLedger, endLedger }, [], {
    source: "backfill",
    computedAt: checkpoint.updatedAt,
  });
}

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "orbital-verification-stores-"));
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("Store tests must not access the network");
    }),
  );
  vi.useFakeTimers();
  vi.setSystemTime(new Date(checkpoint.updatedAt));
});

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  await rm(directory, { recursive: true, force: true });
});

for (const kind of ["memory", "file"] as const) {
  describe(`${kind} verdict sink`, () => {
    let sink: VerdictSink;

    beforeEach(() => {
      sink =
        kind === "memory"
          ? new InMemoryVerdictSink()
          : new FileVerdictSink(join(directory, "nested", "verdicts"));
    });

    it("returns null for missing keys and an empty list before the first write", async () => {
      expect(await sink.get("GAAA", 100, 150)).toBeNull();
      expect(await sink.all()).toEqual([]);
    });

    it("upserts the same subject and window without duplicating a verdict", async () => {
      const original = verdict();
      const replacement = { ...original, source: "live" as const };
      await sink.upsert(original);
      await sink.upsert(replacement);
      expect(await sink.get("GAAA", 100, 150)).toEqual(replacement);
      expect(await sink.all()).toEqual([replacement]);
    });

    it("keeps subjects and both window boundaries distinct", async () => {
      const records = [verdict(), verdict("GBBB"), verdict("GAAA", 101), verdict("GAAA", 100, 151)];
      for (const record of records) await sink.upsert(record);
      for (const record of records) {
        expect(
          await sink.get(record.subject, record.window.startLedger, record.window.endLedger),
        ).toEqual(record);
      }
      expect(await sink.get("GAAA", 99, 150)).toBeNull();
      expect(await sink.all()).toHaveLength(records.length);
      expect(await sink.all()).toEqual(expect.arrayContaining(records));
    });
  });
}

describe("FileVerdictSink", () => {
  it("persists encoded filenames and ignores unrelated files when listing", async () => {
    const sink = new FileVerdictSink(directory);
    const record = { ...verdict(), subject: "subject/with:reserved?characters" };
    await sink.upsert(record);
    await writeFile(join(directory, "README.txt"), "not JSON", "utf8");
    expect(await readdir(directory)).toContain(
      `${encodeURIComponent(`${record.subject}|100-150`)}.json`,
    );
    const reopened = new FileVerdictSink(directory);
    expect(await reopened.get(record.subject, 100, 150)).toEqual(record);
    expect(await reopened.all()).toEqual([record]);
  });
});

describe("InMemoryCheckpointStore", () => {
  it("starts empty, replaces saved state, and supports repeated clearing and reuse", async () => {
    const store = new InMemoryCheckpointStore();
    expect(await store.load()).toBeNull();
    await store.clear();
    await store.save(checkpoint);
    expect(await store.load()).toEqual(checkpoint);
    const next = { ...checkpoint, lastProcessedLedger: 200 };
    await store.save(next);
    expect(await store.load()).toEqual(next);
    await store.clear();
    await store.clear();
    expect(await store.load()).toBeNull();
    await store.save(checkpoint);
    expect(await store.load()).toEqual(checkpoint);
    expect(await new InMemoryCheckpointStore().load()).toBeNull();
  });
});

describe("FileCheckpointStore", () => {
  it("loads and clears a missing checkpoint without creating a directory", async () => {
    const dir = join(directory, "absent");
    const store = new FileCheckpointStore(dir);
    expect(await store.load()).toBeNull();
    await expect(store.clear()).resolves.toBeUndefined();
    await expect(readdir(dir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("creates parent directories and persists the latest checkpoint across instances", async () => {
    const dir = join(directory, "nested", "checkpoints");
    const store = new FileCheckpointStore(dir);
    await store.save(checkpoint);
    expect(await new FileCheckpointStore(dir).load()).toEqual(checkpoint);
    const next = { ...checkpoint, lastProcessedLedger: 200, updatedAt: "2026-01-02T00:00:00.000Z" };
    await store.save(next);
    expect(await new FileCheckpointStore(dir).load()).toEqual(next);
    expect(JSON.parse(await readFile(join(dir, "backfill-checkpoint.json"), "utf8"))).toEqual(next);
  });

  it("clears only the checkpoint, tolerates repeated clearing, and can save again", async () => {
    const store = new FileCheckpointStore(directory);
    await writeFile(join(directory, "keep.txt"), "keep", "utf8");
    await store.save(checkpoint);
    await store.clear();
    expect(await new FileCheckpointStore(directory).load()).toBeNull();
    expect(await readdir(directory)).toEqual(["keep.txt"]);
    await expect(store.clear()).resolves.toBeUndefined();
    await store.save(checkpoint);
    expect(await store.load()).toEqual(checkpoint);
  });

  it.each(["", "{broken JSON"])(
    "rejects a corrupt checkpoint (%j) without overwriting it",
    async (contents) => {
      const file = join(directory, "backfill-checkpoint.json");
      await writeFile(file, contents, "utf8");
      const store = new FileCheckpointStore(directory);
      await expect(store.load()).rejects.toBeInstanceOf(SyntaxError);
      expect(await readFile(file, "utf8")).toBe(contents);
      await store.clear();
      expect(await store.load()).toBeNull();
    },
  );
});
