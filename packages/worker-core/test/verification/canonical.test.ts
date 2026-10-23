import { describe, expect, it } from "vitest";

import {
  canonicalAddress,
  canonicalAmount,
  canonicalAsset,
  fromExportLedger,
  fromLiveLedger,
  inferSubjectType,
  mapOperationToVerificationEvents,
} from "../../src/verification/canonical.js";
import type { ExportLedger, ExportOperation, LiveLedger } from "../../src/index.js";

const LEDGER = 42;
const CLOSE_TIME = "2024-01-15T00:00:00Z";
const TX_HASH = "tx-abc-123";

describe("canonicalAmount", () => {
  it("pads a whole number to 7 decimal places", () => {
    expect(canonicalAmount("10")).toBe("10.0000000");
  });

  it("pads a short fractional amount to exactly 7 decimals", () => {
    expect(canonicalAmount("10.5")).toBe("10.5000000");
  });

  it("truncates amounts with more than 7 decimal places (no rounding)", () => {
    expect(canonicalAmount("10.12345678")).toBe("10.1234567");
  });

  it("leaves an already-canonical amount unchanged", () => {
    expect(canonicalAmount("10.5000000")).toBe("10.5000000");
  });

  it("treats an empty integer part as 0", () => {
    expect(canonicalAmount(".5")).toBe("0.5000000");
  });

  it("substitutes an empty fraction part with 7 zeros", () => {
    expect(canonicalAmount("42.")).toBe("42.0000000");
  });

  it("preserves the negative sign", () => {
    expect(canonicalAmount("-10.5")).toBe("-10.5000000");
  });

  it("canonicalizes a negative whole number", () => {
    expect(canonicalAmount("-3")).toBe("-3.0000000");
  });

  it("trims surrounding whitespace before processing", () => {
    expect(canonicalAmount("  10.5  ")).toBe("10.5000000");
  });
});

describe("canonicalAsset", () => {
  it('maps "native" to "XLM"', () => {
    expect(canonicalAsset("native")).toBe("XLM");
  });

  it('maps "XLM" to "XLM" (idempotent)', () => {
    expect(canonicalAsset("XLM")).toBe("XLM");
  });

  it("passes through non-native assets unchanged", () => {
    expect(canonicalAsset("USDC:GISSUER")).toBe("USDC:GISSUER");
  });

  it("trims whitespace before checking", () => {
    expect(canonicalAsset("  native ")).toBe("XLM");
    expect(canonicalAsset("  XLM  ")).toBe("XLM");
  });

  it("preserves case for non-native assets (no normalization beyond trim)", () => {
    expect(canonicalAsset("  USDC:GISSUER  ")).toBe("USDC:GISSUER");
  });
});

describe("canonicalAddress", () => {
  it("uppercases an address", () => {
    expect(canonicalAddress("gabcdef1234")).toBe("GABCDEF1234");
  });

  it("is idempotent on already-uppercase input", () => {
    expect(canonicalAddress("GABCDEF1234")).toBe("GABCDEF1234");
  });

  it("trims surrounding whitespace", () => {
    expect(canonicalAddress("  GABCDEF1234  ")).toBe("GABCDEF1234");
  });

  it("handles a contract id (starts with C)", () => {
    expect(canonicalAddress("cabcDEF1234")).toBe("CABCDEF1234");
  });
});

describe("inferSubjectType", () => {
  it("returns 'contract' for a C-prefixed StrKey", () => {
    expect(inferSubjectType("CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC")).toBe(
      "contract",
    );
  });

  it("returns 'contract' for a lowercase c-prefixed StrKey", () => {
    expect(inferSubjectType("cdlzfc3syjydzt7k67vz75hpjvieuvnixf47zg2fb2rmqqvu2hhgcysc")).toBe(
      "contract",
    );
  });

  it("returns 'account' for a G-prefixed StrKey", () => {
    expect(inferSubjectType("GAAAACCCCOUNT12345")).toBe("account");
  });

  it("returns 'account' for a non-C, non-G StrKey", () => {
    expect(inferSubjectType("SAAASECRETKEY1234")).toBe("account");
  });

  it("trims whitespace before inferring", () => {
    expect(inferSubjectType("  CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC  ")).toBe(
      "contract",
    );
  });
});

describe("mapOperationToVerificationEvents", () => {
  // -- payment ---------------------------------------------------------------
  it("emits payment_sent + payment_received for a normal payment", () => {
    const op: ExportOperation = {
      kind: "payment",
      from: "GAAA",
      to: "GBBB",
      amount: "10.5",
      asset: "XLM",
    };
    const events = mapOperationToVerificationEvents(op, LEDGER, CLOSE_TIME, TX_HASH);

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      kind: "payment_sent",
      subject: "GAAA",
      counterparty: "GBBB",
      asset: "XLM",
      amount: "10.5000000",
      authorized: null,
      txHash: TX_HASH,
    });
    expect(events[1]).toMatchObject({
      kind: "payment_received",
      subject: "GBBB",
      counterparty: "GAAA",
    });
  });

  it("emits payment_self when from and to are the same address (case-insensitive)", () => {
    const op: ExportOperation = {
      kind: "payment",
      from: "GAAA",
      to: "gaaa", // same key, different case → must canonicalize equal
      amount: "5",
      asset: "native",
    };
    const events = mapOperationToVerificationEvents(op, LEDGER, CLOSE_TIME, TX_HASH);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "payment_self",
      subject: "GAAA",
      counterparty: null,
      amount: "5.0000000",
      asset: "XLM",
    });
  });

  // -- mint ------------------------------------------------------------------
  it("maps a mint to a mint event for the destination", () => {
    const op: ExportOperation = {
      kind: "mint",
      to: "GBBB",
      amount: "100",
      asset: "USDC:GISSUER",
    };
    const events = mapOperationToVerificationEvents(op, LEDGER, CLOSE_TIME, TX_HASH);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "mint",
      subject: "GBBB",
      counterparty: null,
      asset: "USDC:GISSUER",
      amount: "100.0000000",
      authorized: null,
    });
  });

  // -- burn ------------------------------------------------------------------
  it("maps a burn to a burn event for the source", () => {
    const op: ExportOperation = {
      kind: "burn",
      from: "GCCC",
      amount: "2",
      asset: "USDC:GISSUER",
    };
    const events = mapOperationToVerificationEvents(op, LEDGER, CLOSE_TIME, TX_HASH);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "burn",
      subject: "GCCC",
      counterparty: null,
      asset: "USDC:GISSUER",
      amount: "2.0000000",
    });
  });

  // -- clawback --------------------------------------------------------------
  it("maps a clawback to a clawback event for the source", () => {
    const op: ExportOperation = {
      kind: "clawback",
      from: "GDDD",
      amount: "50",
      asset: "USDC:GISSUER",
    };
    const events = mapOperationToVerificationEvents(op, LEDGER, CLOSE_TIME, TX_HASH);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "clawback",
      subject: "GDDD",
      counterparty: null,
      asset: "USDC:GISSUER",
      amount: "50.0000000",
    });
  });

  // -- fee -------------------------------------------------------------------
  it("maps a fee to a fee event for the source", () => {
    const op: ExportOperation = {
      kind: "fee",
      from: "GAAA",
      amount: "0.00001",
    };
    const events = mapOperationToVerificationEvents(op, LEDGER, CLOSE_TIME, TX_HASH);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "fee",
      subject: "GAAA",
      counterparty: null,
      amount: "0.0000100",
      asset: "XLM", // fee has no asset field → defaults to XLM
      authorized: null,
    });
  });

  // -- set_authorized --------------------------------------------------------
  it("maps a set_authorized event carrying the authorized flag", () => {
    const op: ExportOperation = {
      kind: "set_authorized",
      trustor: "GBBB",
      asset: "USDC:GISSUER",
      authorized: true,
    };
    const events = mapOperationToVerificationEvents(op, LEDGER, CLOSE_TIME, TX_HASH);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "set_authorized",
      subject: "GBBB",
      counterparty: null,
      asset: "USDC:GISSUER",
      authorized: true,
    });
  });

  it("passes authorized=false through for set_authorized", () => {
    const op: ExportOperation = {
      kind: "set_authorized",
      trustor: "GBBB",
      asset: "USDC:GISSUER",
      authorized: false,
    };
    const events = mapOperationToVerificationEvents(op, LEDGER, CLOSE_TIME, TX_HASH);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "set_authorized", authorized: false });
  });

  // -- default (unknown kind) ------------------------------------------------
  it("returns an empty array for an unknown operation kind", () => {
    // ExportOperation is a discriminated union; cast to bypass the type check
    // and exercise the default branch.
    const op = { kind: "unknown_op" } as unknown as ExportOperation;
    const events = mapOperationToVerificationEvents(op, LEDGER, CLOSE_TIME, TX_HASH);
    expect(events).toEqual([]);
  });

  // -- shared field defaults -------------------------------------------------
  it("defaults amount to '0' when the operation has no amount field", () => {
    // set_authorized has no amount field → exercises the "amount" not in op branch.
    const op: ExportOperation = {
      kind: "set_authorized",
      trustor: "GBBB",
      asset: "USDC:GISSUER",
      authorized: true,
    };
    const events = mapOperationToVerificationEvents(op, LEDGER, CLOSE_TIME, TX_HASH);
    expect(events[0].amount).toBe("0");
  });

  it("uppercases subject and counterparty in every emitted event", () => {
    const op: ExportOperation = {
      kind: "payment",
      from: "gaaa",
      to: "gbbb",
      amount: "1",
      asset: "native",
    };
    const events = mapOperationToVerificationEvents(op, LEDGER, CLOSE_TIME, TX_HASH);
    expect(events[0].subject).toBe("GAAA");
    expect(events[0].counterparty).toBe("GBBB");
    expect(events[1].subject).toBe("GBBB");
    expect(events[1].counterparty).toBe("GAAA");
  });

  it("propagates ledger, closeTime, and txHash into every event", () => {
    const op: ExportOperation = {
      kind: "mint",
      to: "GBBB",
      amount: "1",
      asset: "XLM",
    };
    const [event] = mapOperationToVerificationEvents(op, LEDGER, CLOSE_TIME, TX_HASH);
    expect(event.ledger).toBe(LEDGER);
    expect(event.closeTime).toBe(CLOSE_TIME);
    expect(event.txHash).toBe(TX_HASH);
  });

  it("passes a null txHash through unchanged", () => {
    const op: ExportOperation = {
      kind: "burn",
      from: "GCCC",
      amount: "1",
      asset: "XLM",
    };
    const [event] = mapOperationToVerificationEvents(op, LEDGER, CLOSE_TIME, null);
    expect(event.txHash).toBeNull();
  });
});

describe("fromExportLedger", () => {
  it("turns a parsed export ledger into verification events via its transactions", () => {
    const ledger: ExportLedger = {
      ledgerSequence: LEDGER,
      closeTime: CLOSE_TIME,
      network: "testnet",
      transactions: [
        {
          transactionId: TX_HASH,
          operations: [
            { kind: "payment", from: "GAAA", to: "GBBB", amount: "10", asset: "XLM" },
            { kind: "mint", to: "GBBB", amount: "5", asset: "USDC:GISSUER" },
          ],
        },
      ],
    };

    const events = fromExportLedger(ledger);
    // payment → 2 events, mint → 1 event
    expect(events).toHaveLength(3);
    expect(events[0]).toMatchObject({ kind: "payment_sent", subject: "GAAA", ledger: LEDGER });
    expect(events[1]).toMatchObject({ kind: "payment_received", subject: "GBBB" });
    expect(events[2]).toMatchObject({ kind: "mint", subject: "GBBB" });
    // Every event carries the transaction's id.
    for (const e of events) expect(e.txHash).toBe(TX_HASH);
  });

  it("returns an empty array for a ledger with no transactions", () => {
    const ledger: ExportLedger = {
      ledgerSequence: LEDGER,
      closeTime: CLOSE_TIME,
      network: "testnet",
      transactions: [],
    };
    expect(fromExportLedger(ledger)).toEqual([]);
  });

  it("handles multiple transactions with multiple operations each", () => {
    const ledger: ExportLedger = {
      ledgerSequence: LEDGER,
      closeTime: CLOSE_TIME,
      network: "mainnet",
      transactions: [
        {
          transactionId: "tx-1",
          operations: [{ kind: "burn", from: "GCCC", amount: "2", asset: "XLM" }],
        },
        {
          transactionId: "tx-2",
          operations: [
            { kind: "fee", from: "GAAA", amount: "0.001" },
            { kind: "clawback", from: "GDDD", amount: "3", asset: "USDC:GISSUER" },
          ],
        },
      ],
    };
    const events = fromExportLedger(ledger);
    expect(events).toHaveLength(3);
    expect(events.map((e) => e.kind)).toEqual(["burn", "fee", "clawback"]);
    expect(events.map((e) => e.txHash)).toEqual(["tx-1", "tx-2", "tx-2"]);
  });
});

describe("fromLiveLedger", () => {
  it("turns a live ledger into verification events using the same mapping as the export path", () => {
    const live: LiveLedger = {
      ledger: LEDGER,
      closeTime: CLOSE_TIME,
      transactions: [
        {
          transactionId: TX_HASH,
          operations: [
            { kind: "payment", from: "GAAA", to: "GBBB", amount: "10.0", asset: "native" },
            { kind: "set_authorized", trustor: "GBBB", asset: "USDC:GISSUER", authorized: true },
          ],
        },
      ],
    };

    const events = fromLiveLedger(live);
    expect(events).toHaveLength(3);
    expect(events[0]).toMatchObject({ kind: "payment_sent", asset: "XLM", amount: "10.0000000" });
    expect(events[1]).toMatchObject({ kind: "payment_received" });
    expect(events[2]).toMatchObject({ kind: "set_authorized", authorized: true });
  });

  it("returns an empty array for a live ledger with no transactions", () => {
    const live: LiveLedger = { ledger: LEDGER, closeTime: CLOSE_TIME, transactions: [] };
    expect(fromLiveLedger(live)).toEqual([]);
  });

  it("produces the same events as fromExportLedger for logically identical ledgers", () => {
    // This is the byte-identical guarantee: the export shape and the live shape
    // differ in field names and raw formatting, but both go through the same
    // mapOperationToVerificationEvents, so the canonical events match.
    const exportLedger: ExportLedger = {
      ledgerSequence: LEDGER,
      closeTime: CLOSE_TIME,
      network: "testnet",
      transactions: [
        {
          transactionId: TX_HASH,
          operations: [
            { kind: "payment", from: "GAAA", to: "GBBB", amount: "10.0000000", asset: "XLM" },
          ],
        },
      ],
    };
    const liveLedger: LiveLedger = {
      ledger: LEDGER,
      closeTime: CLOSE_TIME,
      transactions: [
        {
          transactionId: TX_HASH,
          operations: [
            { kind: "payment", from: "GAAA", to: "GBBB", amount: "10.0", asset: "native" },
          ],
        },
      ],
    };

    expect(fromExportLedger(exportLedger)).toEqual(fromLiveLedger(liveLedger));
  });
});
