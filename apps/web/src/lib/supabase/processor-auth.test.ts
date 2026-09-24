import { describe, expect, it, vi } from "vitest";
import { requireProcessorIdentity } from "./processor-auth";

const secret = "processor-secret-for-tests-12345678901234567890";
const request = (authorization?: string) =>
  new Request("http://localhost/internal", {
    headers: authorization === undefined ? undefined : { authorization },
  });

describe("shared processor identity", () => {
  it("accepts the configured bearer secret", () => {
    vi.stubEnv("CONUO_PROCESSOR_SECRET", secret);
    expect(() => requireProcessorIdentity(request(`Bearer ${secret}`))).not.toThrow();
    vi.unstubAllEnvs();
  });

  it("accepts CRON_SECRET as an alternate configured secret", () => {
    vi.stubEnv("CONUO_PROCESSOR_SECRET", "");
    vi.stubEnv("CRON_SECRET", secret);
    expect(() => requireProcessorIdentity(request(`Bearer ${secret}`))).not.toThrow();
    vi.unstubAllEnvs();
  });

  it.each([
    ["", 503, "PROCESSOR_NOT_CONFIGURED"],
    ["short", 503, "PROCESSOR_NOT_CONFIGURED"],
  ])("rejects unsafe configuration", (value, status, code) => {
    vi.stubEnv("CONUO_PROCESSOR_SECRET", value);
    expect(() => requireProcessorIdentity(request(`Bearer ${value}`))).toThrow(
      expect.objectContaining({ status, code }),
    );
    vi.unstubAllEnvs();
  });

  it.each(["", "Bearer wrong", `bearer ${secret}`, `Bearer ${secret}x`])(
    "rejects an invalid authorization header",
    (authorization) => {
      vi.stubEnv("CONUO_PROCESSOR_SECRET", secret);
      expect(() => requireProcessorIdentity(request(authorization))).toThrow(
        expect.objectContaining({ status: 401, code: "PROCESSOR_UNAUTHORIZED" }),
      );
      vi.unstubAllEnvs();
    },
  );
});
