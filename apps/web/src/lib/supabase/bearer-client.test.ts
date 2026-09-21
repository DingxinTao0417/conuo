import { afterEach, describe, expect, it, vi } from "vitest";
import { createBearerClient } from "./bearer-client";

describe("isolated native bearer transport", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sends each caller token to both Auth verification and its RLS RPC without cookie persistence", async () => {
    const calls: { pathname: string; authorization: string | null; cookie: string | null }[] = [];
    const transport = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const pathname = new URL(request.url).pathname;
      calls.push({
        pathname,
        authorization: request.headers.get("authorization"),
        cookie: request.headers.get("cookie"),
      });
      if (pathname === "/auth/v1/user")
        return Response.json({ id: "verified-native-owner", aud: "authenticated" });
      if (pathname === "/rest/v1/rpc/account_deletion_access_status")
        return Response.json({ allowed: true });
      throw new Error("Unexpected test transport path");
    });
    vi.stubGlobal("fetch", transport);
    const config = { url: "https://example.supabase.co", key: "public-test-key" };
    const first = createBearerClient("native-access-token-a", config);
    const second = createBearerClient("native-access-token-b", config);

    expect((await first.auth.getUser("native-access-token-a")).data.user?.id).toBe(
      "verified-native-owner",
    );
    expect((await second.auth.getUser("native-access-token-b")).data.user?.id).toBe(
      "verified-native-owner",
    );
    expect((await first.rpc("account_deletion_access_status", {})).error).toBeNull();
    expect((await second.rpc("account_deletion_access_status", {})).error).toBeNull();
    expect(calls).toEqual([
      { pathname: "/auth/v1/user", authorization: "Bearer native-access-token-a", cookie: null },
      { pathname: "/auth/v1/user", authorization: "Bearer native-access-token-b", cookie: null },
      {
        pathname: "/rest/v1/rpc/account_deletion_access_status",
        authorization: "Bearer native-access-token-a",
        cookie: null,
      },
      {
        pathname: "/rest/v1/rpc/account_deletion_access_status",
        authorization: "Bearer native-access-token-b",
        cookie: null,
      },
    ]);
    expect((await first.auth.getSession()).data.session).toBeNull();
    expect((await second.auth.getSession()).data.session).toBeNull();
    expect(transport).toHaveBeenCalledTimes(4);
  });
});
