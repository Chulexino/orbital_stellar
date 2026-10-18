import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { xdr } from "@stellar/stellar-sdk";
import type { SorobanRpcClient, SorobanRpcEvent } from "@orbital-stellar/pulse-core";
import type { ContractSpec } from "@orbital-stellar/abi-registry";

const { getLatestLedger, getEvents } = vi.hoisted(() => ({
  getLatestLedger: vi.fn<SorobanRpcClient["getLatestLedger"]>(),
  getEvents: vi.fn<SorobanRpcClient["getEvents"]>(),
}));

vi.mock("@orbital-stellar/pulse-core", () => ({
  SorobanRpcClient: vi.fn().mockImplementation(function () {
    return { getLatestLedger, getEvents };
  }),
}));

import { getRecentContractEvents } from "@/lib/registryEvents";

const CONTRACT_ID = "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75";
const NOW = 1_800_000_000_000;
const SPEC: ContractSpec = {
  name: "Example",
  version: "1.0.0",
  contractId: CONTRACT_ID,
  functions: [],
  events: [],
  types: {},
};
const TOPICS = [xdr.ScVal.scvSymbol("ping").toXDR("base64")];

function event(ledger: number): SorobanRpcEvent {
  return {
    id: `event-${ledger}`,
    type: "contract",
    contractId: CONTRACT_ID,
    ledger,
    ledgerClosedAt: "2026-10-16T12:00:00Z",
    txHash: `tx-${ledger}`,
    topic: TOPICS,
    value: xdr.ScVal.scvU32(42).toXDR("base64"),
  };
}

function rawEvent(ledger: number) {
  return {
    id: `event-${ledger}`,
    ledger,
    ledgerClosedAt: "2026-10-16T12:00:00Z",
    txHash: `tx-${ledger}`,
    topics: TOPICS,
  };
}

beforeEach(() => {
  getLatestLedger.mockReset();
  getEvents.mockReset();
  // The helper caches these on globalThis, independently of the module cache.
  vi.stubGlobal("__orbitalExplorerRpc", undefined);
  vi.stubGlobal("__orbitalExplorerTaxonomy", undefined);
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("Unexpected network request");
    }),
  );
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  getLatestLedger.mockResolvedValue(20_000);
  getEvents.mockResolvedValue({ events: [] });
});

afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("getRecentContractEvents", () => {
  it("queries the bounded window and returns decoded events newest first", async () => {
    getEvents.mockResolvedValue({ events: [event(19_998), event(19_999)] });

    expect(await getRecentContractEvents(CONTRACT_ID, SPEC)).toStrictEqual({
      available: true,
      events: [19_999, 19_998].map((ledger) => ({
        ...rawEvent(ledger),
        decoded: { functionName: "ping", topics: ["ping"], data: 42 },
      })),
      truncated: false,
      windowStartLedger: 2_720,
      latestLedger: 20_000,
      fetchedAt: NOW,
    });
    expect(getLatestLedger).toHaveBeenCalledTimes(1);
    expect(getEvents).toHaveBeenCalledExactlyOnceWith({
      startLedger: 2_720,
      filters: [{ type: "contract", contractIds: [CONTRACT_ID] }],
      limit: 200,
      xdrFormat: "base64",
    });
  });

  it("returns an available empty result when no events are found", async () => {
    expect(await getRecentContractEvents(CONTRACT_ID, SPEC)).toStrictEqual({
      available: true,
      events: [],
      truncated: false,
      windowStartLedger: 2_720,
      latestLedger: 20_000,
      fetchedAt: NOW,
    });
  });

  it("keeps raw events when the spec could not be resolved", async () => {
    getEvents.mockResolvedValue({ events: [event(19_999)] });

    expect(await getRecentContractEvents(CONTRACT_ID, null)).toStrictEqual({
      available: true,
      events: [rawEvent(19_999)],
      truncated: false,
      windowStartLedger: 2_720,
      latestLedger: 20_000,
      fetchedAt: NOW,
    });
  });

  it("keeps a decoding failure on the event without losing the result", async () => {
    getEvents.mockResolvedValue({ events: [{ ...event(19_999), value: { vec: "invalid" } }] });

    expect(await getRecentContractEvents(CONTRACT_ID, SPEC)).toStrictEqual({
      available: true,
      events: [{ ...rawEvent(19_999), decodeError: "data: vec value must be an array" }],
      truncated: false,
      windowStartLedger: 2_720,
      latestLedger: 20_000,
      fetchedAt: NOW,
    });
  });

  it.each([
    { count: 2, truncated: false },
    { count: 3, truncated: true },
  ])(
    "caps $count events to the newest two (truncated=$truncated)",
    async ({ count, truncated }) => {
      getEvents.mockResolvedValue({
        events: Array.from({ length: count }, (_, i) => event(19_997 + i)),
      });

      expect(await getRecentContractEvents(CONTRACT_ID, null, 2)).toStrictEqual({
        available: true,
        events: [rawEvent(19_996 + count), rawEvent(19_995 + count)],
        truncated,
        windowStartLedger: 2_720,
        latestLedger: 20_000,
        fetchedAt: NOW,
      });
    },
  );

  it("never starts before ledger one on a young network", async () => {
    getLatestLedger.mockResolvedValue(100);

    expect(await getRecentContractEvents(CONTRACT_ID, null)).toStrictEqual({
      available: true,
      events: [],
      truncated: false,
      windowStartLedger: 1,
      latestLedger: 100,
      fetchedAt: NOW,
    });
    expect(getEvents).toHaveBeenCalledWith(expect.objectContaining({ startLedger: 1 }));
  });

  it("returns unavailable when the latest-ledger RPC fails", async () => {
    getLatestLedger.mockRejectedValue(new Error("RPC unavailable"));

    expect(await getRecentContractEvents(CONTRACT_ID, SPEC)).toStrictEqual({
      available: false,
      error: "RPC unavailable",
    });
    expect(getEvents).not.toHaveBeenCalled();
  });

  it.each([new Error("RPC timeout"), "RPC timeout"])(
    "returns unavailable when getEvents rejects with %s",
    async (error) => {
      getEvents.mockRejectedValue(error);

      expect(await getRecentContractEvents(CONTRACT_ID, SPEC)).toStrictEqual({
        available: false,
        error: "RPC timeout",
      });
    },
  );
});
