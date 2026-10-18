import { describe, expect, it } from "vitest";
import { CountingWebhookMetrics, NOOP_WEBHOOK_METRICS } from "../src/metrics.js";

describe("NOOP_WEBHOOK_METRICS", () => {
  it("accepts attempt and terminal records without doing work", () => {
    expect(() => {
      NOOP_WEBHOOK_METRICS.recordAttempt("https://hooks.example.com", 1, 25, "success");
      NOOP_WEBHOOK_METRICS.recordTerminal("https://hooks.example.com", "success");
    }).not.toThrow();
  });
});

describe("CountingWebhookMetrics", () => {
  it("records attempts by URL in order and returns an independent array", () => {
    const metrics = new CountingWebhookMetrics();

    expect(metrics.getAttempts("https://hooks.example.com")).toEqual([]);

    metrics.recordAttempt("https://hooks.example.com", 1, 25, "failure");
    metrics.recordAttempt("https://hooks.example.com", 2, 40, "success");
    metrics.recordAttempt("https://other.example.com", 1, 10, "success");

    const attempts = metrics.getAttempts("https://hooks.example.com");
    expect(attempts).toEqual([
      { attempt: 1, durationMs: 25, status: "failure" },
      { attempt: 2, durationMs: 40, status: "success" },
    ]);

    attempts.pop();
    expect(metrics.getAttempts("https://hooks.example.com")).toHaveLength(2);
    expect(metrics.getAttempts("https://other.example.com")).toEqual([
      { attempt: 1, durationMs: 10, status: "success" },
    ]);
  });

  it("records and retrieves terminal outcomes per URL", () => {
    const metrics = new CountingWebhookMetrics();

    expect(metrics.getTerminalOutcome("https://hooks.example.com")).toBeUndefined();

    metrics.recordTerminal("https://hooks.example.com", "dropped");

    expect(metrics.getTerminalOutcome("https://hooks.example.com")).toBe("dropped");
    expect(metrics.getTerminalOutcome("https://other.example.com")).toBeUndefined();
  });
});
