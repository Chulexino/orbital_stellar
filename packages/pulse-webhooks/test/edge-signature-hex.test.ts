import { createHmac } from "crypto";
import { describe, expect, it } from "vitest";

import { verifyWebhookEdgeRaw, verifyWebhookEdgeStream } from "../src/edge.js";

const SECRET = "top-secret";
const TIMESTAMP = "1714176000000";
const PAYLOAD = JSON.stringify({ id: "evt_1", type: "payment" });
const OPTIONS = { nowMs: Number(TIMESTAMP) };

function sign(payload: string): string {
  return createHmac("sha256", SECRET).update(`${TIMESTAMP}.${payload}`).digest("hex");
}

function streamFromString(body: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(body);
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

const valid = sign(PAYLOAD);

const malformedSignatures: Array<[string, string]> = [
  ["non-hex characters", `${valid.slice(0, -2)}zz`],
  ["a single non-hex character", `${valid.slice(0, -1)}g`],
  ["odd length", valid.slice(0, -1)],
  ["empty string", ""],
  ["a 0x prefix", `0x${valid.slice(2)}`],
  ["embedded whitespace", `${valid.slice(0, 10)} ${valid.slice(11)}`],
];

describe("verifyWebhookEdgeRaw signature hex validation", () => {
  it("accepts a valid lowercase hex signature", async () => {
    expect(await verifyWebhookEdgeRaw(PAYLOAD, valid, SECRET, TIMESTAMP, OPTIONS)).toBe(true);
  });

  it("accepts a valid uppercase hex signature", async () => {
    expect(
      await verifyWebhookEdgeRaw(PAYLOAD, valid.toUpperCase(), SECRET, TIMESTAMP, OPTIONS),
    ).toBe(true);
  });

  it.each(malformedSignatures)("rejects a signature with %s", async (_label, signature) => {
    expect(await verifyWebhookEdgeRaw(PAYLOAD, signature, SECRET, TIMESTAMP, OPTIONS)).toBe(false);
  });
});

describe("verifyWebhookEdgeStream signature hex validation", () => {
  it("accepts a valid hex signature", async () => {
    const result = await verifyWebhookEdgeStream(
      streamFromString(PAYLOAD),
      valid,
      SECRET,
      TIMESTAMP,
      OPTIONS,
    );
    expect(result).toEqual({ event: JSON.parse(PAYLOAD), body: PAYLOAD });
  });

  it.each(malformedSignatures)(
    "returns null for a signature with %s",
    async (_label, signature) => {
      const result = await verifyWebhookEdgeStream(
        streamFromString(PAYLOAD),
        signature,
        SECRET,
        TIMESTAMP,
        OPTIONS,
      );
      expect(result).toBeNull();
    },
  );
});
