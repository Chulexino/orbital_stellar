import { z } from "zod";
import type { Sep31Status } from "@orbital-stellar/pulse-core";
import { Sep12Client } from "./sep12.js";

/**
 * Zod schema for the SEP-31 `/info` response: the assets the anchor can
 * receive, their fee/limit metadata and the SEP-12 customer types and
 * transaction fields each asset requires.
 */
export const Sep31InfoSchema = z.object({
  receive: z.record(
    z.string(),
    z.object({
      quotes_supported: z.boolean().optional(),
      quotes_required: z.boolean().optional(),
      fee_fixed: z.number().optional(),
      fee_percent: z.number().optional(),
      min_amount: z.number().optional(),
      max_amount: z.number().optional(),
      sender_sep12_type: z.string().optional(),
      receiver_sep12_type: z.string().optional(),
      fields: z
        .object({
          transaction: z
            .record(
              z.string(),
              z.object({
                description: z.string(),
                choices: z.array(z.string()).optional(),
              }),
            )
            .optional(),
        })
        .optional(),
    }),
  ),
});

/** Parsed Sep31InfoSchema response - the anchor's receivable assets and their requirements. */
export type Sep31Info = z.infer<typeof Sep31InfoSchema>;

/** Thrown when a SEP-31 transaction is missing fields the anchor requires. */
export class MissingFieldsError extends Error {
  constructor(public missingFields: string[]) {
    super(`Missing required fields: ${missingFields.join(", ")}`);
    this.name = "MissingFieldsError";
  }
}

/** Thrown when the anchor needs SEP-12 customer information for the sender or receiver. */
export class CustomerInfoNeededError extends Error {
  constructor(
    public customerType: "sender" | "receiver",
    public neededFields: string[],
  ) {
    super(`Customer info needed for ${customerType}: ${neededFields.join(", ")}`);
    this.name = "CustomerInfoNeededError";
  }
}

/**
 * Client for the SEP-31 cross-border payments protocol.
 *
 * Exposes the anchor's `/info`, `/transactions` and `/transactions/:id`
 * endpoints and owns a {@link Sep12Client} for the SEP-12 customer handoff.
 * Methods that talk to the anchor throw {@link MissingFieldsError} or {@link CustomerInfoNeededError}
 * when the anchor reports that more information is required, and a generic `Error`
 * for any other failure.
 */
export class Sep31Client {
  /** SEP-12 client sharing this anchor's base URL, for customer registration. */
  public sep12: Sep12Client;

  /**
   * Create a SEP-31 client against an anchor's direct payment server.
   *
   * @param anchorUrl - Base URL of the anchor's SEP-31 direct payment server.
   */
  constructor(private anchorUrl: string) {
    this.sep12 = new Sep12Client(anchorUrl);
  }

  /**
   * GET /info - the assets the anchor can receive and their requirements.
   *
   * @throws {Error} When the response is not ok or does not match
   * {@link Sep31InfoSchema}.
   */
  async info(): Promise<Sep31Info> {
    const url = new URL(`${this.anchorUrl}/info`);
    const response = await fetch(url.toString());
    if (!response.ok) {
      throw new Error(`SEP-31 GET /info failed: ${response.statusText}`);
    }
    const data = await response.json();
    return Sep31InfoSchema.parse(data);
  }

  /**
   * POST /transactions - start a SEP-31 payment and return the stellar
   * account/memo the sender must pay.
   *
   * @param params - Asset, amount and optional SEP-12 customer ids and extra fields.
   * @param token - SEP-10 session JWT.
   * @returns The transaction id and the Stellar account and memo to pay.
   * @throws {Link MissingFieldsError} When the anchor reports transaction fields are missing.
   * @throws {Link CustomerInfoNeededError} When the anchor needs SEP-12 customer info.
   * @throws {Error} For any other non-ok response.
   */
  async initiateTransaction(
    params: {
      asset_code: string;
      /** Amount to send, in the asset's units. Required by SEP-31 - omitting it is rejected by every conforming anchor. */
      amount: string;
      sender_id?: string;
      receiver_id?: string;
      fields?: Record<string, string>;
    },
    token: string,
  ): Promise<{
    id: string;
    stellar_account_id: string;
    stellar_memo: string;
    stellar_memo_type: string;
  }> {
    const response = await fetch(`${this.anchorUrl}/transactions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(params),
    });

    const data = await response.json();

    if (!response.ok) {
      if (response.status === 400 && data.error === "transaction_info_needed") {
        throw new MissingFieldsError(data.fields || []);
      }
      if (response.status === 400 && data.error === "customer_info_needed") {
        // Technically customer_info_needed returns type of customer
        throw new CustomerInfoNeededError(data.type || "sender", data.fields || []);
      }
      throw new Error(`SEP-31 POST /transactions failed: ${data.error || response.statusText}`);
    }

    return data;
  }

  /**
   * GET /transactions/:id - the current status of a SEP-31 transaction.
   *
   * @param transactionId - The id returned by {@link initiateTransaction}.
   * @param token - SEP-10 session JWT.
   * @returns The transaction's status and amounts.
   * @throws {Error} When the response is not ok.
   */
  async pollStatus(
    transactionId: string,
    token: string,
  ): Promise<{
    id: string;
    status: Sep31Status;
    status_eta?: number;
    amount_in?: string;
    amount_out?: string;
    message?: string;
  }> {
    const response = await fetch(`${this.anchorUrl}/transactions/${transactionId}`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(`SEP-31 GET /transactions/:id failed: ${data.error || response.statusText}`);
    }

    return data.transaction;
  }
}
