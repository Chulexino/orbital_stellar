import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { Sep31Client, MissingFieldsError, CustomerInfoNeededError } from "../src/sep31.js";
import { ZodError } from "zod";
import { Sep12Client } from "../src/sep12.js";
import { Sep31StatusMachine, InvalidStatusTransitionError } from "../src/statusMachine.js";

const mockAnchorUrl = "https://testanchor.stellar.org";

describe("Sep31StatusMachine", () => {
  it("allows valid transitions", () => {
    const machine = new Sep31StatusMachine("pending_sender");
    expect(() => machine.transitionTo("pending_stellar")).not.toThrow();
    expect(machine.current).toBe("pending_stellar");
    expect(() => machine.transitionTo("pending_receiver")).not.toThrow();
    expect(() => machine.transitionTo("completed")).not.toThrow();
  });

  it("throws on invalid transitions", () => {
    const machine = new Sep31StatusMachine("completed");
    expect(() => machine.transitionTo("pending_sender")).toThrow(InvalidStatusTransitionError);
  });
});

describe("Sep31Client Lifecycle (Fixture-backed)", () => {
  let client: Sep31Client;

  beforeEach(() => {
    client = new Sep31Client(mockAnchorUrl);
    vi.stubGlobal("fetch", vi.fn());
  });

  it("fetches /info", async () => {
    const mockInfo = {
      receive: {
        USD: {
          fee_fixed: 1,
          fee_percent: 1,
          min_amount: 5,
          max_amount: 1000,
          sender_sep12_type: "sender",
          receiver_sep12_type: "receiver",
          fields: {
            transaction: {
              routing_number: { description: "Routing number" },
              account_number: { description: "Account number" },
            },
          },
        },
      },
    };

    (global.fetch as any).mockResolvedValue({
      ok: true,
      json: async () => mockInfo,
    });

    const info = await client.info();
    expect(info.receive["USD"].fee_fixed).toBe(1);
    expect(info.receive["USD"].fields?.transaction?.["routing_number"].description).toBe(
      "Routing number",
    );
  });

  it("handles missing fields rejection path (negotiation loop)", async () => {
    (global.fetch as any).mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({
        error: "transaction_info_needed",
        fields: ["routing_number", "account_number"],
      }),
    });

    await expect(
      client.initiateTransaction(
        {
          asset_code: "USD",
          amount: "10",
          sender_id: "sender1",
          receiver_id: "receiver1",
        },
        "token",
      ),
    ).rejects.toThrow(MissingFieldsError);
  });

  it("handles customer info needed rejection path (SEP-12 dependency)", async () => {
    (global.fetch as any).mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({
        error: "customer_info_needed",
        type: "receiver",
        fields: ["first_name", "last_name"],
      }),
    });

    await expect(
      client.initiateTransaction(
        {
          asset_code: "USD",
          amount: "10",
          sender_id: "sender1",
          receiver_id: "receiver1",
        },
        "token",
      ),
    ).rejects.toThrow(CustomerInfoNeededError);
  });

  it("initiates transaction successfully", async () => {
    (global.fetch as any).mockResolvedValue({
      ok: true,
      json: async () => ({
        id: "tx123",
        stellar_account_id: "GABC...",
        stellar_memo: "memo123",
        stellar_memo_type: "text",
      }),
    });

    const res = await client.initiateTransaction(
      {
        asset_code: "USD",
        amount: "10",
        sender_id: "sender1",
        receiver_id: "receiver1",
        fields: {
          routing_number: "123",
          account_number: "456",
        },
      },
      "token",
    );

    expect(res.id).toBe("tx123");
    expect(res.stellar_account_id).toBe("GABC...");
  });

  it("polls status", async () => {
    (global.fetch as any).mockResolvedValue({
      ok: true,
      json: async () => ({
        transaction: {
          id: "tx123",
          status: "pending_stellar",
          amount_in: "100.00",
        },
      }),
    });

    const res = await client.pollStatus("tx123", "token");
    expect(res.status).toBe("pending_stellar");
    expect(res.amount_in).toBe("100.00");
  });

  it("throws on a non-2xx /info response", async () => {
    (global.fetch as any).mockResolvedValue({
      ok: false,
      status: 503,
      statusText: "Service Unavailable",
      json: async () => ({}),
    });

    await expect(client.info()).rejects.toThrow("SEP-31 GET /info failed: Service Unavailable");
  });

  it("rejects a schema-invalid /info body", async () => {
    (global.fetch as any).mockResolvedValue({
      ok: true,
      json: async () => ({ receive: { USD: { fee_fixed: "not-a-number" } } }),
    });

    await expect(client.info()).rejects.toThrow();
  });

  it("throws the anchor error message on a 400 that is neither negotiation code", async () => {
    (global.fetch as any).mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: "invalid_asset" }),
    });

    await expect(
      client.initiateTransaction({ asset_code: "USD", amount: "10" }, "token"),
    ).rejects.toThrow("SEP-31 POST /transactions failed: invalid_asset");
  });

  it("falls back to the HTTP status text when a transaction failure body has no error", async () => {
    (global.fetch as any).mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
      json: async () => ({}),
    });

    await expect(
      client.initiateTransaction({ asset_code: "USD", amount: "10" }, "token"),
    ).rejects.toThrow("SEP-31 POST /transactions failed: Internal Server Error");
  });

  it("throws on a non-2xx pollStatus response", async () => {
    (global.fetch as any).mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({ error: "not_found" }),
    });

    await expect(client.pollStatus("tx123", "token")).rejects.toThrow(
      "SEP-31 GET /transactions/:id failed: not_found",
    );
  });

  it("falls back to the HTTP status text when a pollStatus failure body has no error", async () => {
    (global.fetch as any).mockResolvedValue({
      ok: false,
      status: 502,
      statusText: "Bad Gateway",
      json: async () => ({}),
    });

    await expect(client.pollStatus("tx123", "token")).rejects.toThrow(
      "SEP-31 GET /transactions/:id failed: Bad Gateway",
    );
  });

  it("defaults the missing field list on a transaction_info_needed rejection", async () => {
    (global.fetch as any).mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: "transaction_info_needed" }),
    });

    const rejection = client.initiateTransaction({ asset_code: "USD", amount: "10" }, "token");
    await expect(rejection).rejects.toBeInstanceOf(MissingFieldsError);
    await rejection.catch((err: MissingFieldsError) => {
      expect(err.missingFields).toEqual([]);
    });
  });

  it("defaults the customer type on a customer_info_needed rejection", async () => {
    (global.fetch as any).mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: "customer_info_needed" }),
    });

    const rejection = client.initiateTransaction({ asset_code: "USD", amount: "10" }, "token");
    await expect(rejection).rejects.toBeInstanceOf(CustomerInfoNeededError);
    await rejection.catch((err: CustomerInfoNeededError) => {
      expect(err.customerType).toBe("sender");
      expect(err.neededFields).toEqual([]);
    });
  });
});

describe("SEP-31 error classes", () => {
  it("MissingFieldsError carries the missing field list", () => {
    const err = new MissingFieldsError(["routing_number", "account_number"]);
    expect(err.name).toBe("MissingFieldsError");
    expect(err.missingFields).toEqual(["routing_number", "account_number"]);
    expect(err.message).toBe("Missing required fields: routing_number, account_number");
  });

  it("CustomerInfoNeededError carries the customer type and needed fields", () => {
    const err = new CustomerInfoNeededError("receiver", ["first_name"]);
    expect(err.name).toBe("CustomerInfoNeededError");
    expect(err.customerType).toBe("receiver");
    expect(err.neededFields).toEqual(["first_name"]);
    expect(err.message).toBe("Customer info needed for receiver: first_name");
  });
});

describe("SEP-12 Customer Info", () => {
  let client: Sep12Client;
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

  beforeEach(() => {
    client = new Sep12Client(mockAnchorUrl);
    fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("gets customer info with encoded lookup parameters and bearer authorization", async () => {
    const customer = {
      id: "cust123",
      status: "NEEDS_INFO",
      provided_fields: {
        first_name: { description: "First Name", type: "string", status: "ACCEPTED" },
        email_address: { status: "REJECTED", error: "Invalid email" },
      },
      fields: { last_name: { type: "string", description: "Last Name" } },
      message: "Provide your last name",
    };
    fetchMock.mockResolvedValue(Response.json(customer));
    const params = { type: "sender", account: "GABC", memo: "customer +&/?", memo_type: "text" };

    await expect(client.getCustomer(params, "token")).resolves.toEqual(customer);
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
      `${mockAnchorUrl}/customer?type=sender&account=GABC&memo=customer+%2B%26%2F%3F&memo_type=text`,
      { method: "GET", headers: { Authorization: "Bearer token" } },
    );
  });

  it.each(["ACCEPTED", "PROCESSING", "NEEDS_INFO", "REJECTED"])(
    "accepts a minimal %s lookup response without optional fields or query parameters",
    async (status) => {
      fetchMock.mockResolvedValue(Response.json({ status }));

      await expect(client.getCustomer({}, "token")).resolves.toEqual({ status });
      expect(fetchMock).toHaveBeenCalledExactlyOnceWith(`${mockAnchorUrl}/customer`, {
        method: "GET",
        headers: { Authorization: "Bearer token" },
      });
    },
  );

  it.each([
    ["missing status", {}],
    ["unknown status", { status: "UNKNOWN" }],
    ["invalid id", { status: "ACCEPTED", id: 123 }],
    [
      "invalid provided field status",
      { status: "NEEDS_INFO", provided_fields: { name: { status: "UNKNOWN" } } },
    ],
    ["incomplete requested field", { status: "NEEDS_INFO", fields: { name: { type: "string" } } }],
  ])("rejects a schema-invalid lookup response: %s", async (_label, body) => {
    fetchMock.mockResolvedValue(Response.json(body));

    await expect(client.getCustomer({ id: "cust123" }, "token")).rejects.toBeInstanceOf(ZodError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("puts customer info as FormData and returns the assigned id", async () => {
    fetchMock.mockResolvedValue(Response.json({ id: "cust123" }, { status: 202 }));
    const formData = new FormData();
    formData.append("id", "cust123");
    formData.append("first_name", "Alice");

    await expect(client.putCustomer(formData, "token")).resolves.toEqual({ id: "cust123" });
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(`${mockAnchorUrl}/customer`, {
      method: "PUT",
      headers: { Authorization: "Bearer token" },
      body: formData,
    });
  });

  it.each([{}, { id: 123 }, null])("rejects a schema-invalid update response: %j", async (body) => {
    fetchMock.mockResolvedValue(Response.json(body));

    await expect(client.putCustomer(new FormData(), "token")).rejects.toBeInstanceOf(ZodError);
  });

  describe.each(["GET", "PUT"])("%s failures", (method) => {
    function request() {
      return method === "GET"
        ? client.getCustomer({}, "token")
        : client.putCustomer(new FormData(), "token");
    }

    it.each([
      [400, "Bad Request"],
      [401, "Unauthorized"],
      [404, "Not Found"],
      [500, "Internal Server Error"],
    ])("rejects HTTP %i before trying to parse the body", async (status, statusText) => {
      const response = new Response("not JSON", { status, statusText });
      const json = vi.spyOn(response, "json");
      fetchMock.mockResolvedValue(response);

      await expect(request()).rejects.toThrow(`SEP-12 ${method} /customer failed: ${statusText}`);
      expect(json).not.toHaveBeenCalled();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("propagates a transport rejection without retrying", async () => {
      const error = new TypeError("Connection reset");
      fetchMock.mockRejectedValue(error);

      await expect(request()).rejects.toBe(error);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("rejects malformed JSON in a successful response", async () => {
      fetchMock.mockResolvedValue(new Response("not JSON", { status: 200 }));

      await expect(request()).rejects.toBeInstanceOf(SyntaxError);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });
});
