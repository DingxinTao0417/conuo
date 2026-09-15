import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

type CookieUpdate = {
  name: string;
  value: string;
  options?: { httpOnly?: boolean; path?: string; sameSite?: "lax" | "strict" | "none" };
};

const mock = vi.hoisted(() => ({
  config: vi.fn(),
  createServerClient: vi.fn(),
  getClaims: vi.fn(),
}));

vi.mock("@supabase/ssr", () => ({ createServerClient: mock.createServerClient }));
vi.mock("@/lib/supabase/config", () => ({ getSupabaseConfig: mock.config }));

import { config, proxy } from "./proxy";

describe("Supabase session-refresh proxy", () => {
  let getAll: (() => unknown[]) | undefined;
  let setAll: ((values: CookieUpdate[]) => void) | undefined;

  beforeEach(() => {
    Object.values(mock).forEach((value) => value.mockReset());
    getAll = undefined;
    setAll = undefined;
    mock.createServerClient.mockImplementation(
      (
        _url: string,
        _key: string,
        options: {
          cookies: {
            getAll: () => unknown[];
            setAll: (values: CookieUpdate[]) => void;
          };
        },
      ) => {
        getAll = options.cookies.getAll;
        setAll = options.cookies.setAll;
        return { auth: { getClaims: mock.getClaims } };
      },
    );
  });

  it("passes through unchanged when Supabase has not been configured", async () => {
    mock.config.mockReturnValue(null);

    const response = await proxy(new NextRequest("https://app.example.test/library"));

    expect(response.headers.get("location")).toBeNull();
    expect(mock.createServerClient).not.toHaveBeenCalled();
    expect(mock.getClaims).not.toHaveBeenCalled();
  });

  it("refreshes claims and mirrors refreshed cookies to the request and response without authorizing", async () => {
    mock.config.mockReturnValue({
      url: "https://project.example.test",
      key: "publishable-test-key",
    });
    mock.getClaims.mockImplementation(async () => {
      setAll?.([
        {
          name: "sb-access-token",
          value: "refreshed-token",
          options: { httpOnly: true, path: "/", sameSite: "lax" },
        },
      ]);
      return { data: { claims: null }, error: null };
    });
    const request = new NextRequest("https://app.example.test/library", {
      headers: { cookie: "existing-cookie=before-refresh" },
    });

    const response = await proxy(request);

    expect(mock.createServerClient).toHaveBeenCalledWith(
      "https://project.example.test",
      "publishable-test-key",
      expect.objectContaining({ cookies: expect.any(Object) }),
    );
    expect(mock.getClaims).toHaveBeenCalledOnce();
    expect(getAll?.()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "existing-cookie", value: "before-refresh" }),
      ]),
    );
    expect(request.cookies.get("sb-access-token")?.value).toBe("refreshed-token");
    expect(response.cookies.get("sb-access-token")).toMatchObject({
      value: "refreshed-token",
      httpOnly: true,
      path: "/",
      sameSite: "lax",
    });
    expect(response.headers.get("location")).toBeNull();
  });

  it("keeps API routes in session-refresh coverage while excluding framework and common static assets", () => {
    expect(config.matcher).toEqual([
      "/((?!_next/static|_next/image|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|css|js|map|woff|woff2|ttf|otf)$).*)",
    ]);
  });
});
