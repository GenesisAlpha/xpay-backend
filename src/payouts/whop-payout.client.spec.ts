jest.mock("../lib/supabase.client", () => ({
  supabase: { from: jest.fn() },
}));

import { WHOP_ENV_ACCOUNT_ID } from "../orchestrator/whop/whop-accounts.service";
import { WhopPayoutApiError, WhopPayoutClient } from "./whop-payout.client";

describe("WhopPayoutClient", () => {
  const originalEnv = { ...process.env };
  let fetchMock: jest.Mock;
  let accounts: { getById: jest.Mock };
  let client: WhopPayoutClient;

  beforeEach(() => {
    process.env.WHOP_MASTER_ACCOUNT_ID = WHOP_ENV_ACCOUNT_ID;
    process.env.WHOP_PAYOUT_TIMEOUT_MS = "250";
    fetchMock = jest.fn();
    (global as any).fetch = fetchMock;
    accounts = {
      getById: jest.fn().mockResolvedValue({
        id: WHOP_ENV_ACCOUNT_ID,
        provider: "whop",
        status: "active",
        weight: 1,
        supported_methods: ["all"],
        api_url: "https://api.whop.com",
        apiKey: "master_secret_key",
        config: { company_id: "biz_master" },
      }),
    };
    client = new WhopPayoutClient(accounts as any);
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.restoreAllMocks();
  });

  function jsonResponse(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }

  it("pins the API version and idempotency key without leaking secrets", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        {
          id: "wdrl_1",
          object: "payout",
          status: "processing",
          amount: "114.50",
          currency: "usd",
          fee_amount: "4.20",
          markup_fee: "0.00",
          net_amount: "110.30",
          estimated_arrival: "2026-09-22T12:00:00.000Z",
          created_at: "2026-09-21T12:00:00.000Z",
        },
        201,
      ),
    );

    await client.createPayout(
      {
        accountId: "biz_seller",
        amount: 114.5,
        currency: "usd",
        payoutMethodId: "potk_1",
        quoteToken: "quote_secret",
        speed: "standard",
        platformCoversFees: false,
        metadata: { koopfy_payout_id: "payout-1" },
      },
      "koopfy_payout_abc",
    );

    expect(accounts.getById).toHaveBeenCalledWith(WHOP_ENV_ACCOUNT_ID);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.whop.com/api/v1/payouts",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer master_secret_key",
          "Api-Version-Date": "2026-09-15",
          "Idempotency-Key": "koopfy_payout_abc",
        }),
      }),
    );
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body)).toEqual(
      expect.objectContaining({
        account_id: "biz_seller",
        payout_method_id: "potk_1",
        quote_token: "quote_secret",
      }),
    );
  });

  it("uses the Current API contract for a provider-backed quote", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        {
          object: "payout_quote",
          id: "pout_1",
          amount: {
            amount: "114.50",
            currency: "usd",
            decimals: 2,
            display_decimals: 2,
          },
          fee: {
            amount: "4.20",
            currency: "usd",
            decimals: 2,
            display_decimals: 2,
          },
          net_amount: {
            amount: "110.30",
            currency: "usd",
            decimals: 2,
            display_decimals: 2,
          },
          destination_amount: {
            amount: "621.15",
            currency: "brl",
            decimals: 2,
            display_decimals: 2,
          },
          exchange_rate: 5.63146,
          expires_at: "2026-09-21T12:05:00.000Z",
          quote_token: "signed-provider-token",
        },
        201,
      ),
    );

    const quote = await client.createQuote(
      {
        accountId: "biz_seller",
        amount: 114.5,
        currency: "usd",
        payoutMethodId: "potk_1",
        speed: "standard",
        platformCoversFees: false,
      },
      "quote-idempotency-key",
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.whop.com/api/v1/payouts/quotes",
      expect.objectContaining({ method: "POST" }),
    );
    expect(quote).toEqual(
      expect.objectContaining({
        id: "pout_1",
        quoteToken: "signed-provider-token",
        exchangeRate: "5.63146",
      }),
    );
  });

  it.each([
    [401, "authentication_failed", false],
    [403, "permission_denied", false],
    [422, "provider_validation_failed", false],
    [500, "provider_unavailable", true],
  ])(
    "maps HTTP %s to a sanitized typed error",
    async (status, code, retryable) => {
      fetchMock.mockResolvedValue(
        jsonResponse(
          {
            error: {
              type: "bad_request",
              code: "raw_provider_code",
              message: "quote_secret master_secret_key 123456789",
            },
          },
          status,
        ),
      );

      const promise = client.retrievePayout("wdrl_1", "biz_seller");

      await expect(promise).rejects.toMatchObject({
        name: "WhopPayoutApiError",
        status,
        code,
        retryable,
        idempotencyReplay: false,
      });
      await promise.catch((error: WhopPayoutApiError) => {
        expect(JSON.stringify(error)).not.toContain("quote_secret");
        expect(JSON.stringify(error)).not.toContain("master_secret_key");
        expect(JSON.stringify(error)).not.toContain("123456789");
      });
    },
  );

  it("marks HTTP 409 as an idempotency replay signal", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ error: { type: "conflict", message: "duplicate" } }, 409),
    );

    await expect(
      client.retrievePayout("wdrl_1", "biz_seller"),
    ).rejects.toMatchObject({
      code: "idempotency_conflict",
      status: 409,
      idempotencyReplay: true,
      retryable: false,
    });
  });

  it("maps transport failures to a retryable error without embedding the cause", async () => {
    fetchMock.mockRejectedValue(
      new Error("connect ECONNRESET master_secret_key"),
    );

    const promise = client.listSavedPayoutMethods("biz_seller");

    await expect(promise).rejects.toMatchObject({
      code: "provider_unavailable",
      status: 0,
      retryable: true,
    });
    await promise.catch((error: WhopPayoutApiError) => {
      expect(JSON.stringify(error)).not.toContain("master_secret_key");
      expect((error as any).cause).toBeUndefined();
    });
  });

  it("rejects malformed success payloads instead of passing provider JSON through", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ id: "wdrl_1", status: "mystery" }),
    );

    await expect(
      client.retrievePayout("wdrl_1", "biz_seller"),
    ).rejects.toMatchObject({
      code: "invalid_provider_response",
      status: 502,
      retryable: true,
    });
  });

  it("fails closed when the master payout credential is missing", async () => {
    accounts.getById.mockResolvedValue(null);

    await expect(client.listVerifications("biz_seller")).rejects.toMatchObject({
      code: "master_account_not_configured",
      status: 500,
      retryable: false,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
