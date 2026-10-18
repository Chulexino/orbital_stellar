import { describe, expect, it } from "vitest";

import {
  isExcludedFromScoring,
  isFailure,
  type WindowOutcome,
} from "../../src/backstop/windowVerdict.js";

const allOutcomes: readonly WindowOutcome[] = [
  "not-due",
  "fired",
  "late",
  "missed",
  "unverifiable",
  "pending",
];

describe("windowVerdict outcomes", () => {
  it("enumerates every WindowOutcome value exactly once", () => {
    expect(allOutcomes).toHaveLength(6);
    expect(new Set(allOutcomes).size).toBe(6);
  });
});

describe("isFailure", () => {
  it("reports a failure only for the missed outcome", () => {
    expect(allOutcomes.filter(isFailure)).toEqual(["missed"]);
  });

  it("returns the expected boolean for every WindowOutcome", () => {
    for (const outcome of allOutcomes) {
      expect(isFailure(outcome)).toBe(outcome === "missed");
    }
  });

  it("does not treat not-due, pending, late, fired or unverifiable as failures", () => {
    expect(isFailure("not-due")).toBe(false);
    expect(isFailure("fired")).toBe(false);
    expect(isFailure("late")).toBe(false);
    expect(isFailure("unverifiable")).toBe(false);
    expect(isFailure("pending")).toBe(false);
  });
});

describe("isExcludedFromScoring", () => {
  it("excludes exactly the unverifiable and pending outcomes", () => {
    expect(allOutcomes.filter(isExcludedFromScoring)).toEqual(["unverifiable", "pending"]);
  });

  it("returns the expected boolean for every WindowOutcome", () => {
    for (const outcome of allOutcomes) {
      expect(isExcludedFromScoring(outcome)).toBe(
        outcome === "unverifiable" || outcome === "pending",
      );
    }
  });

  it("does not exclude the scoreable outcomes", () => {
    expect(isExcludedFromScoring("not-due")).toBe(false);
    expect(isExcludedFromScoring("fired")).toBe(false);
    expect(isExcludedFromScoring("late")).toBe(false);
    expect(isExcludedFromScoring("missed")).toBe(false);
  });
});
