import { z } from "zod";

/**
 * Shape of a SEP-12 `GET /customer` response: the customer's KYC status plus
 * the fields the anchor still expects (or has rejected).
 */
export const Sep12CustomerInfoSchema = z.object({
  id: z.string().optional(),
  status: z.enum(["ACCEPTED", "PROCESSING", "NEEDS_INFO", "REJECTED"]),
  provided_fields: z
    .record(
      z.string(),
      z.object({
        description: z.string().optional(),
        type: z.string().optional(),
        status: z.enum(["ACCEPTED", "PROCESSING", "NEEDS_INFO", "REJECTED"]).optional(),
        error: z.string().optional(),
      }),
    )
    .optional(),
  fields: z
    .record(
      z.string(),
      z.object({
        type: z.string(),
        description: z.string(),
      }),
    )
    .optional(),
  message: z.string().optional(),
});

/** Parsed SEP-12 customer record - the fields {@link Sep12CustomerInfoSchema} extracts. */
export type Sep12CustomerInfo = z.infer<typeof Sep12CustomerInfoSchema>;

/**
 * Minimal SEP-12 client for the anchor's `KYC_SERVER`.
 *
 * @remarks
 * `getCustomer` reads a customer's status; `putCustomer` uploads KYC fields.
 * Both throw an `Error` on a non-2xx response, and `getCustomer` additionally
 * throws if the response body does not match {@link Sep12CustomerInfoSchema}.
 */
export class Sep12Client {
  constructor(private anchorUrl: string) {}

  async getCustomer(params: Record<string, string>, token: string): Promise<Sep12CustomerInfo> {
    const url = new URL(`${this.anchorUrl}/customer`);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.append(key, value);
    }

    const response = await fetch(url.toString(), {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    if (!response.ok) {
      throw new Error(`SEP-12 GET /customer failed: ${response.statusText}`);
    }

    const data = await response.json();
    return Sep12CustomerInfoSchema.parse(data);
  }

  async putCustomer(data: FormData, token: string): Promise<{ id: string }> {
    const url = new URL(`${this.anchorUrl}/customer`);
    const response = await fetch(url.toString(), {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
      },
      body: data,
    });

    if (!response.ok) {
      throw new Error(`SEP-12 PUT /customer failed: ${response.statusText}`);
    }

    const result = await response.json();
    return z.object({ id: z.string() }).parse(result);
  }
}
