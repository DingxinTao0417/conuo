import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { callVisionModel, readVisionModelConfig, type ModelConfig } from "./model";

const config: ModelConfig = {
  baseUrl: "https://model.example/v1",
  apiKey: "test-server-key",
  model: "vision-model",
  jsonMode: true,
  tokenLimitParameter: "max_tokens",
  timeoutMs: 45_000,
};

function completion(content = '{"task":"explain","content":"answer"}') {
  return new Response(
    JSON.stringify({
      object: "chat.completion",
      choices: [
        {
          index: 0,
          finish_reason: "stop",
          message: { role: "assistant", content },
        },
      ],
    }),
    { headers: { "Content-Type": "application/json" } },
  );
}

describe("vision model capability and transport", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(completion());
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => vi.unstubAllGlobals());

  it.each([undefined, "enabled", "disabled"] as const)(
    "preserves inline image transport with optional thinking mode %s",
    async (thinkingMode) => {
      const result = await callVisionModel(
        { ...config, ...(thinkingMode === undefined ? {} : { thinkingMode }) },
        [
          { role: "system", content: "Return JSON." },
          { role: "user", content: "Explain the region." },
        ],
        { mimeType: "image/png", base64: "aGVsbG8=" },
      );
      expect(result).toContain("answer");
      const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
      if (thinkingMode === undefined) expect(Object.hasOwn(body, "thinking")).toBe(false);
      else expect(body.thinking).toEqual({ type: thinkingMode });
      expect(body.max_tokens).toBe(4096);
      expect(body.stream).toBe(false);
      expect(body.messages[1].content[1].image_url.url).toBe("data:image/png;base64,aGVsbG8=");
      expect(fetchMock).toHaveBeenCalledOnce();
    },
  );

  it.each(["auto", "", null])(
    "rejects invalid runtime vision thinking mode %j before network",
    async (thinkingMode) => {
      await expect(
        callVisionModel(
          { ...config, thinkingMode } as unknown as ModelConfig,
          [
            { role: "system", content: "Return JSON." },
            { role: "user", content: "Explain." },
          ],
          { mimeType: "image/png", base64: "aGVsbG8=" },
        ),
      ).rejects.toMatchObject({ code: "MODEL_CONFIGURATION" });
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("requires an explicit server-side vision capability gate", () => {
    const env = {
      CONUO_MODEL_BASE_URL: config.baseUrl,
      CONUO_MODEL_API_KEY: config.apiKey,
      CONUO_MODEL_NAME: config.model,
      CONUO_MODEL_JSON_MODE: "true",
      CONUO_MODEL_TOKEN_LIMIT_PARAMETER: "max_tokens",
    };
    expect(readVisionModelConfig(env)).toBeNull();
    expect(readVisionModelConfig({ ...env, CONUO_MODEL_VISION_ENABLED: "true" })).toMatchObject(
      config,
    );
    expect(
      readVisionModelConfig({
        ...env,
        CONUO_MODEL_VISION_ENABLED: "true",
        CONUO_MODEL_THINKING_MODE: "disabled",
      })?.thinkingMode,
    ).toBe("disabled");
    expect(() => readVisionModelConfig({ ...env, CONUO_MODEL_VISION_ENABLED: "yes" })).toThrowError(
      expect.objectContaining({ code: "MODEL_CONFIGURATION" }),
    );
  });

  it("uses the OpenAI-compatible image content-part shape with an inline data URL only", async () => {
    const result = await callVisionModel(
      config,
      [
        { role: "system", content: "Return JSON." },
        { role: "user", content: '{"task":"explain"}' },
      ],
      { mimeType: "image/png", base64: "aGVsbG8=" },
    );
    expect(result).toContain("answer");
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://model.example/v1/chat/completions");
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({
      model: "vision-model",
      stream: false,
      store: false,
      n: 1,
      max_tokens: 4096,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: "Return JSON." },
        {
          role: "user",
          content: [
            { type: "text", text: '{"task":"explain"}' },
            {
              type: "image_url",
              image_url: { url: "data:image/png;base64,aGVsbG8=", detail: "original" },
            },
          ],
        },
      ],
    });
    expect(JSON.stringify(body)).not.toContain("http://attacker");
    expect(init.redirect).toBe("manual");
    expect(init.credentials).toBe("omit");
  });

  it.each([
    [{ mimeType: "image/gif", base64: "aGVsbG8=" }],
    [{ mimeType: "image/png", base64: "https://attacker.example/a.png" }],
    [{ mimeType: "image/png", base64: "%%%=" }],
  ])("rejects invalid image material before fetch %#", async (image) => {
    await expect(
      callVisionModel(
        config,
        [
          { role: "system", content: "Return JSON." },
          { role: "user", content: "Explain." },
        ],
        image as never,
      ),
    ).rejects.toMatchObject({ code: "MODEL_INPUT" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not disclose provider response bodies or credentials on errors", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(`private provider message ${config.apiKey}`, { status: 401 }),
    );
    const error = await callVisionModel(
      config,
      [
        { role: "system", content: "Return JSON." },
        { role: "user", content: "Explain." },
      ],
      { mimeType: "image/png", base64: "aGVsbG8=" },
    ).catch((value: unknown) => value);
    expect(error).toMatchObject({ code: "MODEL_AUTH" });
    expect(String(error)).not.toContain(config.apiKey);
    expect(String(error)).not.toContain("private provider message");
  });
});
