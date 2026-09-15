import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createServer as httpServer,
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { createServer as httpsServer, request as httpsRequest } from "node:https";
import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { gzipSync, deflateSync, brotliCompressSync } from "node:zlib";
import type { LookupAddress } from "node:dns";
import type { AddressInfo } from "node:net";
import { createWebPageFetcher, WebFetchError, type WebPageFetchDependencies } from "./fetch-page";

// Generate an ephemeral self-signed test identity entirely in memory: no checked-in
// private key, certificate files, trust-store modification, or external executable.
function testIdentity() {
  const der = (tag: number, ...parts: Buffer[]) => {
    const body = Buffer.concat(parts);
    const size = body.length;
    const length =
      size < 128
        ? Buffer.from([size])
        : size < 256
          ? Buffer.from([0x81, size])
          : Buffer.from([0x82, size >> 8, size & 255]);
    return Buffer.concat([Buffer.from([tag]), length, body]);
  };
  const sequence = (...parts: Buffer[]) => der(0x30, ...parts);
  const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const algorithm = sequence(Buffer.from("06092a864886f70d01010b0500", "hex"));
  const name = sequence(
    der(0x31, sequence(Buffer.from("0603550403", "hex"), der(0x0c, Buffer.from("site.example")))),
  );
  const altName = sequence(
    Buffer.from("0603551d11", "hex"),
    der(4, sequence(der(0x82, Buffer.from("site.example")))),
  );
  const tbs = sequence(
    der(0xa0, Buffer.from([2, 1, 2])),
    der(2, Buffer.concat([Buffer.from([1]), randomBytes(15)])),
    algorithm,
    name,
    sequence(der(0x18, Buffer.from("20200101000000Z")), der(0x18, Buffer.from("20500101000000Z"))),
    name,
    keys.publicKey.export({ type: "spki", format: "der" }),
    der(0xa3, sequence(altName)),
  );
  const cert = sequence(
    tbs,
    algorithm,
    der(3, Buffer.concat([Buffer.from([0]), sign("sha256", tbs, keys.privateKey)])),
  );
  return {
    key: keys.privateKey.export({ type: "pkcs8", format: "pem" }),
    cert: `-----BEGIN CERTIFICATE-----\n${cert
      .toString("base64")
      .match(/.{1,64}/g)!
      .join("\n")}\n-----END CERTIFICATE-----\n`,
  };
}

const identity = testIdentity();
let handler: (request: IncomingMessage, response: ServerResponse) => void;
const received: Array<{ url: string; headers: IncomingMessage["headers"] }> = [];
const serve = (request: IncomingMessage, response: ServerResponse) => {
  received.push({ url: request.url ?? "", headers: request.headers });
  handler(request, response);
};
const plain = httpServer(serve);
const secure = httpsServer(identity, serve);
secure.on("tlsClientError", () => undefined);
const timers: ReturnType<typeof setTimeout>[] = [];
const later = (callback: () => void, delay: number) => {
  timers.push(setTimeout(callback, delay));
};
let plainPort: number;
let securePort: number;
const publicV4: LookupAddress = { address: "93.184.216.34", family: 4 };
const publicV6: LookupAddress = { address: "2606:4700:4700::1111", family: 6 };
type Transport = NonNullable<WebPageFetchDependencies["request"]>;
type Options = Parameters<Transport>[0];
const optionsSeen: Options[] = [];
const lookup = vi.fn(async (): Promise<LookupAddress[]> => [publicV4]);
/** Real HTTP/TLS parser, sockets and streams against loopback fixtures. Only the
 * injected transport reroutes the validated public target to the ephemeral port. */
const transport: Transport = (options, response) => {
  optionsSeen.push(options);
  return httpRequest(
    {
      ...options,
      protocol: "http:",
      hostname: "127.0.0.1",
      port: plainPort,
      agent: false,
      family: 4,
      lookup: undefined,
    },
    response,
  );
};
const tlsTransport =
  (trustCertificate: boolean): Transport =>
  (options, response) => {
    optionsSeen.push(options);
    return httpsRequest(
      {
        ...options,
        hostname: "127.0.0.1",
        port: securePort,
        agent: false,
        family: 4,
        lookup: undefined,
        ...(trustCertificate ? { ca: identity.cert } : {}),
      },
      response,
    );
  };
const fetcher = (patch: WebPageFetchDependencies = {}) =>
  createWebPageFetcher({ lookup, request: transport, ...patch });
async function rejected(action: Promise<unknown>, code: string) {
  await expect(action).rejects.toMatchObject({ name: "WebFetchError", code });
}
function publicLookup(options: Options, all = false, hostname = options.hostname as string) {
  return new Promise<{ address: string | LookupAddress[]; family?: number }>((resolve, reject) => {
    options.lookup!(hostname, { all }, (error, address, family) =>
      error ? reject(error) : resolve({ address, family }),
    );
  });
}

beforeAll(async () => {
  await Promise.all([
    new Promise<void>((done) => plain.listen(0, "127.0.0.1", done)),
    new Promise<void>((done) => secure.listen(0, "127.0.0.1", done)),
  ]);
  plainPort = (plain.address() as AddressInfo).port;
  securePort = (secure.address() as AddressInfo).port;
});
beforeEach(() => {
  lookup.mockReset().mockResolvedValue([publicV4]);
  optionsSeen.length = 0;
  received.length = 0;
  handler = (_request, response) => {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end("<!doctype html><p>公开网页内容</p>");
  };
});
afterEach(() => {
  timers.splice(0).forEach(clearTimeout);
  plain.closeAllConnections();
  secure.closeAllConnections();
  vi.unstubAllEnvs();
});
afterAll(async () => {
  await Promise.all([
    new Promise<void>((done) => plain.close(() => done())),
    new Promise<void>((done) => secure.close(() => done())),
  ]);
});

describe("public webpage transport and DNS pinning", () => {
  it("uses a validated fixed IP while retaining URL Host/TLS identity and never forwarding credentials", async () => {
    vi.stubEnv("HTTP_PROXY", "http://127.0.0.1:1");
    vi.stubEnv("HTTPS_PROXY", "http://127.0.0.1:1");
    const page = await fetcher()("https://site.example:443/read?q=hello#section");
    expect(page).toMatchObject({
      originalUrl: "https://site.example/read?q=hello",
      finalUrl: "https://site.example/read?q=hello",
      html: "<!doctype html><p>公开网页内容</p>",
      contentType: "text/html; charset=utf-8",
    });
    expect(Number.isNaN(Date.parse(page.fetchedAt))).toBe(false);
    expect(lookup).toHaveBeenCalledExactlyOnceWith("site.example");
    const options = optionsSeen[0];
    expect(options).toMatchObject({
      method: "GET",
      port: 443,
      servername: "site.example",
      rejectUnauthorized: true,
      family: 4,
      autoSelectFamily: false,
      maxHeaderSize: 16384,
      insecureHTTPParser: false,
    });
    expect(options.agent).toMatchObject({ keepAlive: false, maxSockets: 1 });
    expect(
      (options.agent as unknown as { options: { proxyEnv: Record<string, string> } }).options
        .proxyEnv.HTTP_PROXY,
    ).toBeUndefined();
    expect(received[0]).toMatchObject({
      url: "/read?q=hello",
      headers: { host: "site.example", connection: "close" },
    });
    expect(received[0].headers.cookie).toBeUndefined();
    expect(received[0].headers.authorization).toBeUndefined();
    expect(received[0].headers.referer).toBeUndefined();
    // Repeated transport lookup calls always return the original pin, not DNS.
    lookup.mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
    expect(await publicLookup(options)).toEqual({ address: publicV4.address, family: 4 });
    expect(await publicLookup(options, true)).toEqual({ address: [publicV4], family: undefined });
    expect(lookup).toHaveBeenCalledOnce();
    await expect(publicLookup(options, false, "different.example")).rejects.toMatchObject({
      code: "WEB_DNS_PIN_FAILED",
    });
  });
  it("accepts IPv6 global unicast and validated public IP literals without a second DNS step", async () => {
    lookup.mockResolvedValue([publicV6]);
    await fetcher()("https://site.example");
    expect(await publicLookup(optionsSeen[0])).toEqual({ address: publicV6.address, family: 6 });
    lookup.mockClear();
    await fetcher()("http://8.8.8.8/");
    expect(lookup).not.toHaveBeenCalled();
    expect(optionsSeen[1].headers).toMatchObject({ Host: "8.8.8.8" });
  });
  it("preserves real TLS hostname verification and certificate trust", async () => {
    expect(
      (await fetcher({ request: tlsTransport(true) })("https://site.example/")).html,
    ).toContain("公开网页");
    await rejected(
      fetcher({ request: tlsTransport(true) })("https://wrong.example/"),
      "WEB_NETWORK_FAILED",
    );
    await rejected(
      fetcher({ request: tlsTransport(false) })("https://site.example/"),
      "WEB_NETWORK_FAILED",
    );
    expect(received).toHaveLength(1);
  });
  it.each([
    "http://127.0.0.1",
    "http://2130706433",
    "http://0x7f000001",
    "http://0177.0.0.1",
    "http://127.1",
    "http://0.0.0.0",
    "http://10.1.2.3",
    "http://172.16.2.3",
    "http://192.168.0.1",
    "http://169.254.169.254",
    "http://100.100.100.200",
    "http://168.63.129.16",
    "http://192.0.0.9",
    "http://192.0.2.1",
    "http://198.18.0.1",
    "http://198.51.100.1",
    "http://203.0.113.5",
    "http://224.0.0.1",
    "http://255.255.255.255",
    "http://localhost",
    "http://x.localhost.",
    "http://[::1]",
    "http://[::]",
    "http://[::ffff:127.0.0.1]",
    "http://[::ffff:8.8.8.8]",
    "http://[64:ff9b::808:808]",
    "http://[2002:0808:0808::]",
    "http://[2001::1]",
    "http://[2001:db8::1]",
    "http://[fc00::1]",
    "http://[fe80::1]",
    "http://[ff02::1]",
  ])("rejects nonpublic, reserved and translated target %s before transport", async (url) => {
    await rejected(fetcher()(url), "WEB_ADDRESS_BLOCKED");
    expect(optionsSeen).toHaveLength(0);
  });
  it.each([
    "https://user:password@site.example",
    "https://@site.example",
    "file:///etc/passwd",
    "ftp://site.example",
    "//site.example",
    "https:\\site.example",
    "https://site.example/\nsecret",
    "https://site.example/%0d%0aHost:x",
    " https://site.example",
    "https://[fe80::1%25eth0]",
    "https://site.example/" + "x".repeat(8200),
  ])("rejects invalid URL shape %#", async (url) => {
    await rejected(fetcher()(url), "WEB_URL_INVALID");
    expect(lookup).not.toHaveBeenCalled();
    expect(optionsSeen).toHaveLength(0);
  });
  it.each(["http://site.example:443", "https://site.example:80", "https://site.example:8080"])(
    "rejects non-default port %s",
    async (url) => {
      await rejected(fetcher()(url), "WEB_PORT_BLOCKED");
      expect(optionsSeen).toHaveLength(0);
    },
  );
  it.each(
    [
      [],
      [publicV4, { address: "10.0.0.1", family: 4 }],
      [publicV4, { address: "::1", family: 6 }],
      [{ address: "93.184.216.34", family: 6 }],
      [{ address: "garbage", family: 4 }],
    ].map((addresses) => ({ addresses })),
  )("fails closed unless every DNS answer is valid public unicast %#", async ({ addresses }) => {
    lookup.mockResolvedValue(addresses);
    await rejected(fetcher()("https://site.example"), "WEB_ADDRESS_BLOCKED");
    expect(optionsSeen).toHaveLength(0);
  });
  it("does not disclose resolver errors or sensitive URL query strings", async () => {
    lookup.mockRejectedValue(
      new Error("lookup https://site.example/?token=PRIVATE_SECRET 127.0.0.1 failed"),
    );
    try {
      await fetcher()("https://site.example/?token=PRIVATE_SECRET");
      throw new Error("Expected failure");
    } catch (error) {
      expect(error).toBeInstanceOf(WebFetchError);
      expect(error).toMatchObject({ code: "WEB_DNS_FAILED" });
      expect(String(error)).not.toContain("PRIVATE_SECRET");
      expect(String(error)).not.toContain("127.0.0.1");
    }
  });
});

describe("redirect validation on each hop", () => {
  it("follows at most three redirects using fresh DNS and agents without forwarding response cookies", async () => {
    handler = (request, response) => {
      const hop = Number(request.url!.slice(1)) || 0;
      if (hop < 3) {
        response.writeHead(302, { Location: `/${hop + 1}`, "Set-Cookie": "secret=value" });
        response.end();
      } else {
        response.writeHead(200, { "Content-Type": "application/xhtml+xml" });
        response.end("<html><p>最终页面</p></html>");
      }
    };
    const page = await fetcher()("https://site.example/0");
    expect(page.finalUrl).toBe("https://site.example/3");
    expect(lookup).toHaveBeenCalledTimes(4);
    expect(new Set(optionsSeen.map((options) => options.agent)).size).toBe(4);
    expect(received.every((request) => !request.headers.cookie)).toBe(true);
  });
  it.each([
    ["http://169.254.169.254/latest/meta-data", "WEB_HTTPS_DOWNGRADE"],
    ["https://169.254.169.254/latest/meta-data", "WEB_ADDRESS_BLOCKED"],
    ["http://public.example", "WEB_HTTPS_DOWNGRADE"],
    ["https://site.example:8080", "WEB_PORT_BLOCKED"],
    ["https://user:pass@site.example", "WEB_URL_INVALID"],
    ["file:///etc/passwd", "WEB_URL_INVALID"],
    ["/next%0aheader", "WEB_URL_INVALID"],
  ])("revalidates unsafe redirect %s", async (location, code) => {
    handler = (_request, response) => {
      response.writeHead(302, { Location: location });
      response.end();
    };
    await rejected(fetcher()("https://site.example/start"), code);
    expect(received).toHaveLength(1);
  });
  it("rechecks DNS on same-host redirects and stops a rebinding answer", async () => {
    lookup
      .mockResolvedValueOnce([publicV4])
      .mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
    handler = (_request, response) => {
      response.writeHead(302, { Location: "/next" });
      response.end();
    };
    await rejected(fetcher()("https://site.example/start"), "WEB_ADDRESS_BLOCKED");
    expect(received).toHaveLength(1);
    expect(lookup).toHaveBeenCalledTimes(2);
  });
  it("rejects redirect loops and excessive hops", async () => {
    handler = (_request, response) => {
      response.writeHead(302, { Location: "/start#fragment" });
      response.end();
    };
    await rejected(fetcher()("https://site.example/start"), "WEB_REDIRECT_LOOP");
    received.length = 0;
    handler = (request, response) => {
      response.writeHead(302, { Location: `/${Number(request.url!.slice(1)) + 1}` });
      response.end();
    };
    await rejected(fetcher()("https://site.example/0"), "WEB_REDIRECT_LIMIT");
    expect(received).toHaveLength(4);
  });
});

describe("bounded HTTP parsing, streamed compression and text decoding", () => {
  it.each(["gzip", "deflate", "br"])(
    "streams %s and decodes a complete Chinese UTF-8 page",
    async (encoding) => {
      const bytes = Buffer.from("<html><p>压缩网页的中文内容</p></html>");
      const compressed =
        encoding === "gzip"
          ? gzipSync(bytes)
          : encoding === "deflate"
            ? deflateSync(bytes)
            : brotliCompressSync(bytes);
      handler = (_request, response) => {
        response.writeHead(200, { "Content-Type": "text/html", "Content-Encoding": encoding });
        response.write(compressed.subarray(0, 8));
        response.end(compressed.subarray(8));
      };
      expect((await fetcher()("https://site.example")).html).toBe(bytes.toString());
    },
  );
  it.each(["advertised", "chunked", "gzip-bomb", "deflate-bomb", "br-bomb"])(
    "rejects oversized %s without returning truncated HTML",
    async (kind) => {
      const large = Buffer.alloc(2 * 1024 * 1024 + 1, 65);
      handler = (_request, response) => {
        response.setHeader("Content-Type", "text/html");
        if (kind === "advertised") {
          response.setHeader("Content-Length", large.length);
          response.end(large);
        } else if (kind === "chunked") {
          response.write(large.subarray(0, 1024));
          response.end(large.subarray(1024));
        } else {
          const encoding = kind.split("-")[0];
          response.setHeader("Content-Encoding", encoding);
          response.end(
            encoding === "gzip"
              ? gzipSync(large)
              : encoding === "deflate"
                ? deflateSync(large)
                : brotliCompressSync(large),
          );
        }
      };
      await rejected(fetcher()("https://site.example"), "WEB_BODY_TOO_LARGE");
    },
  );
  it("accepts exactly 2 MiB and rejects oversized headers in the actual Node parser", async () => {
    handler = (_request, response) => {
      response.writeHead(200, { "Content-Type": "text/html" });
      response.end("a".repeat(2 * 1024 * 1024));
    };
    expect((await fetcher()("https://site.example")).html).toHaveLength(2 * 1024 * 1024);
    handler = (_request, response) => {
      response.writeHead(200, { "Content-Type": "text/html", "X-Pad": "x".repeat(16384) });
      response.end("short");
    };
    await rejected(fetcher()("https://site.example"), "WEB_HEADERS_TOO_LARGE");
  });
  it("rejects ambiguous duplicate response metadata and incomplete bodies", async () => {
    handler = (_request, response) => {
      response.writeHead(200, [
        "Content-Type",
        "text/html",
        "Content-Type",
        "application/xhtml+xml",
      ]);
      response.end("<p>text</p>");
    };
    await rejected(fetcher()("https://site.example"), "WEB_RESPONSE_INVALID");
    handler = (_request, response) => {
      response.writeHead(200, { "Content-Type": "text/html", "Content-Length": "10000" });
      response.end("short");
    };
    await rejected(fetcher()("https://site.example"), "WEB_NETWORK_FAILED");
  });
  it.each([
    [401, "WEB_LOGIN_REQUIRED"],
    [403, "WEB_LOGIN_REQUIRED"],
    [429, "WEB_RATE_LIMITED"],
    [404, "WEB_HTTP_STATUS"],
    [500, "WEB_HTTP_STATUS"],
    [206, "WEB_PARTIAL_RESPONSE"],
  ] as const)("rejects HTTP %s", async (status, code) => {
    handler = (_request, response) => {
      response.writeHead(status, { "Content-Type": "text/html" });
      response.end("<p>error</p>");
    };
    await rejected(fetcher()("https://site.example"), code);
  });
  it.each(["application/pdf", "application/octet-stream", "text/plain", "image/png", ""])(
    "rejects non-HTML MIME %s",
    async (type) => {
      handler = (_request, response) => {
        if (type) response.setHeader("Content-Type", type);
        response.end("not a webpage");
      };
      await rejected(fetcher()("https://site.example"), "WEB_CONTENT_TYPE");
    },
  );
  it("rejects downloads, unsupported stacked encodings and corrupt compressed data", async () => {
    handler = (_request, response) => {
      response.writeHead(200, {
        "Content-Type": "text/html",
        "Content-Disposition": 'attachment; filename="page.html"',
      });
      response.end("<p>file</p>");
    };
    await rejected(fetcher()("https://site.example"), "WEB_CONTENT_TYPE");
    handler = (_request, response) => {
      response.writeHead(200, { "Content-Type": "text/html", "Content-Encoding": "gzip, br" });
      response.end("bad");
    };
    await rejected(fetcher()("https://site.example"), "WEB_ENCODING_UNSUPPORTED");
    handler = (_request, response) => {
      response.writeHead(200, { "Content-Type": "text/html", "Content-Encoding": "gzip" });
      response.end("not gzip");
    };
    await rejected(fetcher()("https://site.example"), "WEB_DECOMPRESSION_FAILED");
  });
  it("honors header/meta GBK and UTF-16 BOM without executing or requesting page resources", async () => {
    const chineseGbk = Buffer.from([0xd6, 0xd0, 0xce, 0xc4]);
    handler = (_request, response) => {
      response.writeHead(200, { "Content-Type": 'text/html; charset="gbk"' });
      response.end(Buffer.concat([Buffer.from("<p>"), chineseGbk, Buffer.from("</p>")]));
    };
    expect((await fetcher()("https://site.example")).html).toBe("<p>中文</p>");
    handler = (_request, response) => {
      response.writeHead(200, { "Content-Type": "text/html" });
      response.end(
        Buffer.concat([Buffer.from('<meta charset="gbk"><p>'), chineseGbk, Buffer.from("</p>")]),
      );
    };
    expect((await fetcher()("https://site.example")).html).toContain("中文");
    handler = (_request, response) => {
      response.writeHead(200, { "Content-Type": "text/html" });
      response.end(
        Buffer.concat([
          Buffer.from([0xff, 0xfe]),
          Buffer.from(
            '<p>中文</p><img src="http://127.0.0.1/private"><script>fetch("secret")</script>',
            "utf16le",
          ),
        ]),
      );
    };
    const page = await fetcher()("https://site.example");
    expect(page.html).toContain("中文");
    expect(page.html).toContain("<script>");
    expect(received).toHaveLength(3);
  });
  it("fails clearly on unsupported character sets and incomplete UTF-8", async () => {
    handler = (_request, response) => {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-7" });
      response.end("<p>text</p>");
    };
    await rejected(fetcher()("https://site.example"), "WEB_CHARSET_UNSUPPORTED");
    handler = (_request, response) => {
      response.writeHead(200, { "Content-Type": "text/html" });
      response.end(Buffer.from([0xff, 0xfe, 0, 0, 0x3c, 0, 0, 0]));
    };
    await rejected(fetcher()("https://site.example"), "WEB_CHARSET_UNSUPPORTED");
    handler = (_request, response) => {
      response.writeHead(200, { "Content-Type": "text/html" });
      response.end(Buffer.from([0xe4, 0xb8]));
    };
    await rejected(fetcher()("https://site.example"), "WEB_CHARSET_UNSUPPORTED");
  });
});

describe("one total deadline and cancellation", () => {
  it("cancels during pending DNS and never starts a request after the lookup eventually resolves", async () => {
    let resolve!: (value: LookupAddress[]) => void;
    lookup.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const controller = new AbortController();
    const result = fetcher()("https://site.example", controller.signal);
    controller.abort(new Error("sensitive cancellation reason"));
    await rejected(result, "WEB_CANCELLED");
    resolve([publicV4]);
    await new Promise((done) => setImmediate(done));
    expect(optionsSeen).toHaveLength(0);
  });
  it("enforces the deadline during DNS and sanitizes a late DNS rejection", async () => {
    let reject!: (value: unknown) => void;
    lookup.mockReturnValue(
      new Promise((_done, failure) => {
        reject = failure;
      }),
    );
    await rejected(fetcher({ timeoutMs: 25 })("https://site.example"), "WEB_TIMEOUT");
    reject(new Error("sensitive late failure"));
    await new Promise((done) => setImmediate(done));
    expect(optionsSeen).toHaveLength(0);
  });
  it("cancels a real streaming response immediately", async () => {
    const controller = new AbortController();
    handler = (_request, response) => {
      response.writeHead(200, { "Content-Type": "text/html" });
      response.write("<p>start");
      later(() => controller.abort(), 10);
    };
    await rejected(fetcher()("https://site.example", controller.signal), "WEB_CANCELLED");
  });
  it("counts redirect waits and slow bodies against one total deadline, not a fresh timer per hop", async () => {
    handler = (request, response) => {
      if (request.url === "/start")
        later(() => {
          response.writeHead(302, { Location: "/slow" });
          response.end();
        }, 150);
      else {
        response.writeHead(200, { "Content-Type": "text/html" });
        response.write("<p>");
        later(() => response.end("late</p>"), 400);
      }
    };
    await rejected(fetcher({ timeoutMs: 500 })("https://site.example/start"), "WEB_TIMEOUT");
    expect(received.map((request) => request.url)).toEqual(["/start", "/slow"]);
  });
  it("rejects an already aborted request before DNS or transport", async () => {
    const controller = new AbortController();
    controller.abort();
    await rejected(fetcher()("https://site.example", controller.signal), "WEB_CANCELLED");
    expect(lookup).not.toHaveBeenCalled();
    expect(optionsSeen).toHaveLength(0);
  });
});
