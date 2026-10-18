import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { join, resolve } from "node:path";
import type { OperatorRecord, WorkerOfferingRecord } from "@orbital-stellar/abi-registry";

// The registry reads records with `readFileSync`; mock it so the tests are
// deterministic, offline, and exercise every branch without touching disk.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, readFileSync: vi.fn() };
});

import { readFileSync } from "node:fs";
import { LocalWorkerRegistry } from "../../src/registry/LocalWorkerRegistry.js";

const readFileSyncMock = vi.mocked(readFileSync);

const STELLAR_ADDR = "GASDKEGVDZFF423H4MX27UHZUX35PBQBJBZTGCS7IVNVKG2LQTVVO7R7";
const CONTRACT_ID = "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75";
const BASE_PATH = resolve("/registry");

function makeOperator(overrides: Partial<OperatorRecord> = {}): OperatorRecord {
  return {
    id: "test-operator",
    name: "Test Operator",
    stellarAddress: STELLAR_ADDR,
    contact: "operator@example.com",
    maintainer: "@test-operator",
    supportedTriggers: ["event", "schedule"],
    networks: ["testnet"],
    terms: {
      pricePerInvocation: 0.01,
      denomination: "USDC",
      dailyCap: 1000,
      slaMs: 5000,
    },
    latencyTier: "standard",
    version: "1.0.0",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function makeOffering(overrides: Partial<WorkerOfferingRecord> = {}): WorkerOfferingRecord {
  return {
    id: "test-offering",
    contractId: CONTRACT_ID,
    functionName: "swap",
    triggerClass: "event",
    terms: {
      pricePerInvocation: 0.01,
      denomination: "USDC",
      dailyCap: 1000,
      slaMs: 5000,
    },
    operatorId: "test-operator",
    version: "1.0.0",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

/** Make `readFileSync` serve `contents` for the given id's record file. */
function serving(contents: unknown): void {
  readFileSyncMock.mockImplementation(() => JSON.stringify(contents));
}

describe("LocalWorkerRegistry", () => {
  beforeEach(() => {
    readFileSyncMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("constructor", () => {
    it("uses the supplied basePath for record lookups", () => {
      serving(makeOperator());
      const registry = new LocalWorkerRegistry({ basePath: BASE_PATH });

      registry.resolveOperator("acme");

      expect(readFileSyncMock).toHaveBeenCalledWith(
        join(BASE_PATH, "operators", "acme.json"),
        "utf-8",
      );
    });

    it("defaults the basePath to the package data directory", () => {
      serving(makeOperator());
      const registry = new LocalWorkerRegistry();

      registry.resolveOperator("acme");

      const [calledPath] = readFileSyncMock.mock.calls[0]!;
      expect(String(calledPath).endsWith(join("data", "operators", "acme.json"))).toBe(true);
    });
  });

  describe("resolveOperator", () => {
    it("returns the parsed operator when the file exists and validates", () => {
      const operator = makeOperator();
      serving(operator);
      const registry = new LocalWorkerRegistry({ basePath: BASE_PATH });

      expect(registry.resolveOperator(operator.id)).toEqual(operator);
    });

    it("returns null when the record file does not exist", () => {
      readFileSyncMock.mockImplementation(() => {
        throw Object.assign(new Error("no such file"), { code: "ENOENT" });
      });
      const registry = new LocalWorkerRegistry({ basePath: BASE_PATH });

      expect(registry.resolveOperator("missing")).toBeNull();
    });

    it("returns null when the file cannot be read for any other reason", () => {
      readFileSyncMock.mockImplementation(() => {
        throw Object.assign(new Error("permission denied"), { code: "EACCES" });
      });
      const registry = new LocalWorkerRegistry({ basePath: BASE_PATH });

      expect(registry.resolveOperator("unreadable")).toBeNull();
    });

    it("returns null when the file contents are not valid JSON", () => {
      readFileSyncMock.mockReturnValue("{not json" as never);
      const registry = new LocalWorkerRegistry({ basePath: BASE_PATH });

      expect(registry.resolveOperator("broken")).toBeNull();
    });

    it("returns null when the record fails validation", () => {
      // Empty name violates the OperatorRecord invariants.
      serving(makeOperator({ name: "" }));
      const registry = new LocalWorkerRegistry({ basePath: BASE_PATH });

      expect(registry.resolveOperator("invalid")).toBeNull();
    });
  });

  describe("resolveOffering", () => {
    it("returns the parsed offering when the file exists and validates", () => {
      const offering = makeOffering();
      serving(offering);
      const registry = new LocalWorkerRegistry({ basePath: BASE_PATH });

      expect(registry.resolveOffering(offering.id)).toEqual(offering);
      expect(readFileSyncMock).toHaveBeenCalledWith(
        join(BASE_PATH, "offerings", "test-offering.json"),
        "utf-8",
      );
    });

    it("returns null when the offering file does not exist", () => {
      readFileSyncMock.mockImplementation(() => {
        throw Object.assign(new Error("no such file"), { code: "ENOENT" });
      });
      const registry = new LocalWorkerRegistry({ basePath: BASE_PATH });

      expect(registry.resolveOffering("missing")).toBeNull();
    });

    it("returns null when the offering file contents are not valid JSON", () => {
      readFileSyncMock.mockReturnValue("}{" as never);
      const registry = new LocalWorkerRegistry({ basePath: BASE_PATH });

      expect(registry.resolveOffering("broken")).toBeNull();
    });

    it("returns null when the offering fails validation", () => {
      // A contract address where an account address is required.
      serving(makeOffering({ contractId: STELLAR_ADDR }));
      const registry = new LocalWorkerRegistry({ basePath: BASE_PATH });

      expect(registry.resolveOffering("invalid")).toBeNull();
    });
  });
});
