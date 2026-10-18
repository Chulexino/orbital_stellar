import { describe, expect, it } from "vitest";

import { SorobanRpcError } from "@orbital-stellar/pulse-core";

import { classifySubmissionError, isRetryableSubmissionFailure } from "../src/index.js";

function errorWithCause(cause: unknown): Error {
  const error = new Error("opaque submission failure");
  (error as { cause?: unknown }).cause = cause;
  return error;
}

function namedError(name: string): Error {
  const error = new Error("inner");
  error.name = name;
  return error;
}

describe("classifySubmissionError: failure kinds", () => {
  it("classifies an insufficient-fee result code as retryable", () => {
    const failure = classifySubmissionError({
      message: "op failed",
      result_code: "tx_insufficient_fee",
    });
    expect(failure.kind).toBe("insufficient_fee");
    expect(failure.retryable).toBe(true);
  });

  it("classifies ledger contention as retryable", () => {
    expect(
      classifySubmissionError({ message: "op failed", result_code: "tx_duplication" }).kind,
    ).toBe("ledger_contention");
    expect(classifySubmissionError(new Error("tx_duplication")).kind).toBe("ledger_contention");
    expect(classifySubmissionError(new Error("tx_too_early")).retryable).toBe(true);
  });

  it("classifies rate limiting as retryable", () => {
    const failure = classifySubmissionError(new Error("429 too many requests"));
    expect(failure.kind).toBe("rate_limit");
    expect(failure.retryable).toBe(true);
  });

  it("classifies timeout and socket failures as rpc_timeout", () => {
    expect(classifySubmissionError(new Error("request timeout")).kind).toBe("rpc_timeout");
    expect(classifySubmissionError(new Error("ECONNRESET")).kind).toBe("rpc_timeout");
    expect(classifySubmissionError(new Error("socket hang up")).kind).toBe("rpc_timeout");
  });

  it("classifies contract rejections as terminal", () => {
    const failure = classifySubmissionError(new Error("tx_failed: wasm trap"));
    expect(failure.kind).toBe("contract_rejection");
    expect(failure.retryable).toBe(false);
  });

  it("classifies unauthorized failures as terminal", () => {
    expect(classifySubmissionError(new Error("HTTP 403")).kind).toBe("unauthorized");
    expect(classifySubmissionError(new Error("unauthorised")).retryable).toBe(false);
  });

  it("falls back to unknown for an unrecognised failure", () => {
    const failure = classifySubmissionError(new Error("some opaque failure"));
    expect(failure.kind).toBe("unknown");
    expect(failure.retryable).toBe(false);
    expect(failure.cause).toBeInstanceOf(Error);
  });
});

describe("classifySubmissionError: Soroban RPC code mapping", () => {
  it("maps every Soroban RPC code to a failure kind", () => {
    expect(
      classifySubmissionError(new SorobanRpcError("x", { code: "network", retryable: true })).kind,
    ).toBe("rpc_network");
    expect(
      classifySubmissionError(new SorobanRpcError("x", { code: "rate_limit", retryable: true }))
        .kind,
    ).toBe("rate_limit");
    expect(
      classifySubmissionError(new SorobanRpcError("x", { code: "server", retryable: true })).kind,
    ).toBe("rpc_timeout");
    expect(
      classifySubmissionError(new SorobanRpcError("x", { code: "auth", retryable: false })).kind,
    ).toBe("unauthorized");
    expect(
      classifySubmissionError(
        new SorobanRpcError("x", { code: "invalid_request", retryable: false }),
      ).kind,
    ).toBe("contract_invalid");
    expect(
      classifySubmissionError(new SorobanRpcError("x", { code: "unknown", retryable: false })).kind,
    ).toBe("contract_invalid");
  });

  it("preserves the message, retryable flag and cause from the RPC error", () => {
    const rpcError = new SorobanRpcError("server exploded", { code: "server", retryable: true });
    const failure = classifySubmissionError(rpcError);
    expect(failure.message).toBe("server exploded");
    expect(failure.retryable).toBe(true);
    expect(failure.cause).toBe(rpcError);
  });
});

describe("classifySubmissionError: message and cause extraction", () => {
  it("extracts the message from a thrown string", () => {
    const failure = classifySubmissionError("rate limit");
    expect(failure.message).toBe("rate limit");
    expect(failure.kind).toBe("rate_limit");
  });

  it("extracts the message from a plain object", () => {
    expect(classifySubmissionError({ message: "insufficient fee" }).message).toBe(
      "insufficient fee",
    );
  });

  it("stringifies a non-string message field", () => {
    expect(classifySubmissionError({ message: 42 }).message).toBe("[object Object]");
  });

  it("stringifies a primitive error", () => {
    expect(classifySubmissionError(404).message).toBe("404");
  });

  it("stringifies an object without a message field", () => {
    expect(classifySubmissionError({ foo: "bar" }).message).toBe("[object Object]");
  });

  it("ignores a non-string result_code", () => {
    expect(classifySubmissionError({ message: "op failed", result_code: 42 }).kind).toBe("unknown");
  });

  it("reads a string result_code", () => {
    expect(classifySubmissionError({ message: "op failed", result_code: "op_invalid" }).kind).toBe(
      "contract_rejection",
    );
  });

  it("classifies a network-named cause as rpc_network", () => {
    const failure = classifySubmissionError(errorWithCause(namedError("TimeoutError")));
    expect(failure.kind).toBe("rpc_network");
    expect(failure.retryable).toBe(true);
  });

  it("recognises a network-named cause", () => {
    expect(classifySubmissionError(errorWithCause(namedError("NetworkError"))).kind).toBe(
      "rpc_network",
    );
  });

  it("recognises an ECONN-prefixed cause name", () => {
    expect(classifySubmissionError(errorWithCause(namedError("ECONNREFUSED"))).kind).toBe(
      "rpc_network",
    );
    expect(classifySubmissionError(errorWithCause(namedError("ECONNRESET"))).kind).toBe(
      "rpc_network",
    );
  });

  it("ignores a cause that is not an Error", () => {
    expect(classifySubmissionError(errorWithCause("connection reset")).kind).toBe("unknown");
  });

  it("ignores an Error cause with an unrelated name", () => {
    expect(classifySubmissionError(errorWithCause(namedError("TypeError"))).kind).toBe("unknown");
  });
});

describe("isRetryableSubmissionFailure", () => {
  it("reflects the classification of the underlying error", () => {
    expect(isRetryableSubmissionFailure(new Error("rpc timeout"))).toBe(true);
    expect(isRetryableSubmissionFailure(new Error("contract rejected"))).toBe(false);
  });
});
