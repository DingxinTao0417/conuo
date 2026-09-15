import "server-only";
import { lookup as dnsLookup } from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import {
  Agent as HttpAgent,
  request as httpRequest,
  type ClientRequest,
  type IncomingMessage,
} from "node:http";
import { Agent as HttpsAgent, request as httpsRequest, type RequestOptions } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import ipaddr from "ipaddr.js";

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_HEADERS = 16 * 1024;
const DEADLINE_MS = 12_000;
const MAX_REDIRECTS = 3;
const MAX_URL = 8192;
const redirects = new Set([301, 302, 303, 307, 308]);

export class WebFetchError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "WebFetchError";
  }
}

export interface FetchedWebPage {
  originalUrl: string;
  finalUrl: string;
  html: string;
  contentType: string;
  fetchedAt: string;
}

type PinnedRequestOptions = RequestOptions & { autoSelectFamily: false };
type RequestTransport = (
  options: PinnedRequestOptions,
  response: (message: IncomingMessage) => void,
) => ClientRequest;
/** Trusted server/test seam only. Never populate dependencies from request data. */
export interface WebPageFetchDependencies {
  lookup?: (hostname: string) => Promise<LookupAddress[]>;
  request?: RequestTransport;
  /** Tests can shorten the deadline; production can never exceed twelve seconds. */
  timeoutMs?: number;
}

function fail(code: string, message: string): WebFetchError {
  return new WebFetchError(code, message);
}
function safeUrl(value: string, base?: URL): URL {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > MAX_URL ||
    /[\u0000-\u0020\u007f-\u009f\\]/.test(value) ||
    /%(?:0[0-9a-f]|1[0-9a-f]|7f)/i.test(value) ||
    /^(?:https?:)?\/\/[^/?#]*@/i.test(value) ||
    (!base && !/^https?:\/\//i.test(value))
  )
    throw fail("WEB_URL_INVALID", "网址格式无效，请使用完整的 HTTP 或 HTTPS 网页地址。");
  let url: URL;
  try {
    url = new URL(value, base);
  } catch {
    throw fail("WEB_URL_INVALID", "网址格式无效。");
  }
  if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password)
    throw fail("WEB_URL_INVALID", "仅支持不含账号凭据的 HTTP 或 HTTPS 网页地址。");
  // URL removes explicit default ports; every remaining explicit port is non-default.
  if (url.port) throw fail("WEB_PORT_BLOCKED", "网页抓取仅支持 HTTP 80 与 HTTPS 443 端口。");
  url.hash = "";
  if (url.href.length > MAX_URL) throw fail("WEB_URL_INVALID", "网址超过长度上限。");
  return url;
}

function publicAddress(address: string): boolean {
  try {
    if (!isIP(address) || address.includes("%")) return false;
    const parsed = ipaddr.parse(address);
    if (parsed.range() !== "unicast") return false;
    if (parsed.kind() === "ipv4") {
      // Azure's virtual platform endpoint uses a globally shaped special address.
      return address !== "168.63.129.16" && !parsed.match(ipaddr.parse("192.0.0.0"), 24);
    }
    // Only currently allocated global unicast; exclude protocol assignments and
    // every mapped/NAT64/6to4/Teredo/other translation range, even with public IPv4.
    return parsed.match(ipaddr.parse("2000::"), 3) && !parsed.match(ipaddr.parse("2001::"), 23);
  } catch {
    return false;
  }
}

function signalError(signal: AbortSignal): WebFetchError {
  return signal.reason instanceof WebFetchError
    ? signal.reason
    : fail("WEB_CANCELLED", "网页抓取已停止。");
}
function withSignal<T>(value: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signalError(signal));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    // Attach both handlers even if already aborted: a late DNS rejection must not
    // become unhandled, and its completion must never start a request.
    value.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

async function resolvePublic(
  url: URL,
  lookup: NonNullable<WebPageFetchDependencies["lookup"]>,
  signal: AbortSignal,
): Promise<LookupAddress> {
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const family = isIP(hostname);
  const normalizedName = hostname.replace(/\.$/, "").toLowerCase();
  if (normalizedName === "localhost" || normalizedName.endsWith(".localhost"))
    throw fail("WEB_ADDRESS_BLOCKED", "此地址不属于可抓取的公开网页。");
  let addresses: LookupAddress[];
  try {
    addresses = family
      ? [{ address: hostname, family }]
      : await withSignal(lookup(hostname), signal);
  } catch {
    if (signal.aborted) throw signalError(signal);
    throw fail("WEB_DNS_FAILED", "无法安全解析网页地址，请稍后重试。");
  }
  if (signal.aborted) throw signalError(signal);
  if (
    !addresses.length ||
    addresses.length > 64 ||
    addresses.some(
      (item) =>
        ![4, 6].includes(item.family) ||
        isIP(item.address) !== item.family ||
        !publicAddress(item.address),
    )
  )
    throw fail("WEB_ADDRESS_BLOCKED", "此地址包含非公开、保留或无法验证的网络地址，已停止抓取。");
  // Lock one validated address. No automatic family fallback or DNS re-resolution.
  return addresses.find((item) => item.family === 4) ?? addresses[0];
}

function boundedStream(code: string, message: string): Transform {
  let size = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, done) {
      size += chunk.byteLength;
      done(size > MAX_BYTES ? fail(code, message) : null, size > MAX_BYTES ? undefined : chunk);
    },
  });
}

function transportError(error: unknown, signal: AbortSignal): WebFetchError {
  if (signal.aborted) return signalError(signal);
  if (error instanceof WebFetchError) return error;
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
  if (code === "HPE_HEADER_OVERFLOW")
    return fail("WEB_HEADERS_TOO_LARGE", "网页响应头超过 16 KiB 上限。");
  if (code.startsWith("HPE_"))
    return fail("WEB_RESPONSE_INVALID", "网页返回了无法安全读取的响应。");
  if (code.startsWith("Z_") || code.startsWith("ERR_ZLIB") || code.startsWith("ERR_PADDING"))
    return fail("WEB_DECOMPRESSION_FAILED", "网页压缩内容无法完整解码。");
  return fail("WEB_NETWORK_FAILED", "网页连接失败或传输未完成，请稍后重试。");
}

function headersSize(raw: string[]): number {
  return raw.reduce((sum, value) => sum + Buffer.byteLength(value) + 2, 2);
}
function checkHeaders(message: IncomingMessage): void {
  if (headersSize(message.rawHeaders) > MAX_HEADERS)
    throw fail("WEB_HEADERS_TOO_LARGE", "网页响应头超过 16 KiB 上限。");
  const critical = new Set([
    "content-type",
    "content-encoding",
    "content-length",
    "content-disposition",
    "location",
  ]);
  const seen = new Set<string>();
  for (let index = 0; index < message.rawHeaders.length; index += 2) {
    const name = message.rawHeaders[index].toLowerCase();
    if (critical.has(name) && seen.has(name))
      throw fail("WEB_RESPONSE_INVALID", "网页响应包含含义不明确的重复响应头。");
    seen.add(name);
  }
}

type Hop = { redirect: string } | { body: Buffer; contentType: string };
async function requestPage(
  url: URL,
  address: LookupAddress,
  signal: AbortSignal,
  transport: RequestTransport,
): Promise<Hop> {
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const agent =
    url.protocol === "https:"
      ? new HttpsAgent({
          keepAlive: false,
          maxSockets: 1,
          maxFreeSockets: 0,
          proxyEnv: { NODE_ENV: "production" },
        })
      : new HttpAgent({
          keepAlive: false,
          maxSockets: 1,
          maxFreeSockets: 0,
          proxyEnv: { NODE_ENV: "production" },
        });
  const lookup: LookupFunction = (name, options, callback) => {
    if (signal.aborted) return callback(signalError(signal), "", address.family);
    if (name !== hostname)
      return callback(fail("WEB_DNS_PIN_FAILED", "网页连接地址校验失败。"), "", address.family);
    if (options.all) callback(null, [{ address: address.address, family: address.family }]);
    else callback(null, address.address, address.family);
  };
  try {
    return await new Promise<Hop>((resolve, reject) => {
      let request: ClientRequest | undefined;
      let response: IncomingMessage | undefined;
      let settled = false;
      let informationalSize = 0;
      const finish = (error?: unknown, result?: Hop) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", abort);
        response?.destroy();
        request?.destroy();
        if (error) reject(transportError(error, signal));
        else resolve(result!);
      };
      const abort = () => finish(signalError(signal));
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) {
        abort();
        return;
      }
      try {
        request = transport(
          {
            protocol: url.protocol,
            hostname,
            port: url.protocol === "https:" ? 443 : 80,
            method: "GET",
            path: url.pathname + url.search,
            agent,
            lookup,
            family: address.family,
            autoSelectFamily: false,
            servername: isIP(hostname) ? undefined : hostname,
            rejectUnauthorized: true,
            maxHeaderSize: MAX_HEADERS,
            insecureHTTPParser: false,
            signal,
            headers: {
              Host: url.host,
              Accept: "text/html, application/xhtml+xml",
              "Accept-Encoding": "gzip, deflate, br",
              "User-Agent": "Conuo-Web-Importer/1.0",
              Connection: "close",
            },
          },
          (message) => {
            response = message;
            if (settled) {
              message.destroy();
              return;
            }
            void (async () => {
              checkHeaders(message);
              if (headersSize(message.rawHeaders) + informationalSize > MAX_HEADERS)
                throw fail("WEB_HEADERS_TOO_LARGE", "网页响应头超过 16 KiB 上限。");
              const status = message.statusCode ?? 0;
              if (redirects.has(status)) {
                const location = message.headers.location;
                if (!location) throw fail("WEB_REDIRECT_INVALID", "网页重定向缺少有效目标地址。");
                return { redirect: location };
              }
              if (status === 401 || status === 403)
                throw fail("WEB_LOGIN_REQUIRED", "网页要求登录或不允许公开访问，请提供可读正文。");
              if (status === 429) throw fail("WEB_RATE_LIMITED", "网站暂时限制访问，请稍后重试。");
              if (status < 200 || status >= 300)
                throw fail("WEB_HTTP_STATUS", "网页没有返回可用的成功响应。");
              if (status === 206 || message.headers["content-range"])
                throw fail("WEB_PARTIAL_RESPONSE", "网站只返回了部分内容，本次未保存不完整网页。");
              const contentType = message.headers["content-type"] ?? "";
              const mime = contentType.split(";", 1)[0].trim().toLowerCase();
              if (
                !["text/html", "application/xhtml+xml"].includes(mime) ||
                /^\s*attachment\b/i.test(message.headers["content-disposition"] ?? "")
              )
                throw fail(
                  "WEB_CONTENT_TYPE",
                  "此地址没有返回 HTML 网页，请改用文件上传或提供网页正文。",
                );
              const length = message.headers["content-length"];
              if (length && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length))))
                throw fail("WEB_RESPONSE_INVALID", "网页响应长度无效。");
              if (length && Number(length) > MAX_BYTES)
                throw fail("WEB_BODY_TOO_LARGE", "网页传输内容超过 2 MiB 上限。");
              const encoding = (message.headers["content-encoding"] ?? "identity")
                .trim()
                .toLowerCase();
              const decoder =
                encoding === "gzip"
                  ? createGunzip()
                  : encoding === "deflate"
                    ? createInflate()
                    : encoding === "br"
                      ? createBrotliDecompress()
                      : encoding === "identity"
                        ? null
                        : undefined;
              if (decoder === undefined)
                throw fail("WEB_ENCODING_UNSUPPORTED", "网页使用了暂不支持的压缩编码。");
              const chunks: Buffer[] = [];
              const rawLimit = boundedStream("WEB_BODY_TOO_LARGE", "网页传输内容超过 2 MiB 上限。");
              const decodedLimit = boundedStream(
                "WEB_BODY_TOO_LARGE",
                "网页解压后超过 2 MiB 上限。",
              );
              const sink = new Writable({
                write(chunk: Buffer, _encoding, done) {
                  chunks.push(Buffer.from(chunk));
                  done();
                },
              });
              if (decoder)
                await pipeline(message, rawLimit, decoder, decodedLimit, sink, { signal });
              else await pipeline(message, rawLimit, decodedLimit, sink, { signal });
              if (!message.complete)
                throw fail("WEB_RESPONSE_INCOMPLETE", "网页传输尚未完成，本次未保存不完整正文。");
              return { body: Buffer.concat(chunks), contentType };
            })().then(
              (result) => finish(undefined, result),
              (error) => finish(error),
            );
          },
        );
        request.on("error", (error) => finish(error));
        request.on("information", (information) => {
          informationalSize += headersSize(information.rawHeaders);
          if (informationalSize > MAX_HEADERS)
            finish(fail("WEB_HEADERS_TOO_LARGE", "网页响应头超过 16 KiB 上限。"));
        });
        request.on("upgrade", (_message, socket) => {
          socket.destroy();
          finish(fail("WEB_RESPONSE_INVALID", "不支持升级为其他网络协议。"));
        });
        request.end();
      } catch (error) {
        finish(error);
      }
    });
  } finally {
    agent.destroy();
  }
}

function decodeHtml(body: Buffer, contentType: string): string {
  if (
    (body[0] === 0xff && body[1] === 0xfe && body[2] === 0 && body[3] === 0) ||
    (body[0] === 0 && body[1] === 0 && body[2] === 0xfe && body[3] === 0xff)
  )
    throw fail("WEB_CHARSET_UNSUPPORTED", "网页字符编码无法完整读取，请提供可读正文。");
  const sniff = body.subarray(0, 1024).toString("latin1");
  const charset =
    body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf
      ? "utf-8"
      : body[0] === 0xff && body[1] === 0xfe
        ? "utf-16le"
        : body[0] === 0xfe && body[1] === 0xff
          ? "utf-16be"
          : (/(?:^|;)\s*charset\s*=\s*["']?([^"'\s;]+)/i.exec(contentType)?.[1] ??
            /<meta\b[^>]*?\bcharset\s*=\s*["']?([^"'\s/>;]+)/i.exec(sniff)?.[1] ??
            /<\?xml\b[^>]*?\bencoding\s*=\s*["']([^"']+)/i.exec(sniff)?.[1] ??
            "utf-8");
  try {
    return new TextDecoder(charset, { fatal: true }).decode(body);
  } catch {
    throw fail("WEB_CHARSET_UNSUPPORTED", "网页字符编码无法完整读取，请提供可读正文。");
  }
}

export function createWebPageFetcher(dependencies: WebPageFetchDependencies = {}) {
  const lookup =
    dependencies.lookup ??
    ((hostname: string) => dnsLookup(hostname, { all: true, verbatim: true }));
  const transport =
    dependencies.request ??
    ((options, response) =>
      options.protocol === "https:"
        ? httpsRequest(options, response)
        : httpRequest(options, response));
  const timeout = Math.min(DEADLINE_MS, Math.max(1, dependencies.timeoutMs ?? DEADLINE_MS));
  return async function fetchPage(
    value: string,
    externalSignal?: AbortSignal,
  ): Promise<FetchedWebPage> {
    const controller = new AbortController();
    const deadline = performance.now() + timeout;
    const cancel = () => controller.abort(fail("WEB_CANCELLED", "网页抓取已停止。"));
    externalSignal?.addEventListener("abort", cancel, { once: true });
    if (externalSignal?.aborted) cancel();
    const timer = setTimeout(
      () => controller.abort(fail("WEB_TIMEOUT", "网页抓取超过 12 秒总时限，请稍后重试。")),
      timeout,
    );
    const check = () => {
      if (!controller.signal.aborted && performance.now() >= deadline)
        controller.abort(fail("WEB_TIMEOUT", "网页抓取超过 12 秒总时限，请稍后重试。"));
      if (controller.signal.aborted) throw signalError(controller.signal);
    };
    try {
      check();
      let url = safeUrl(value);
      const originalUrl = url.href;
      const seen = new Set<string>();
      for (let hop = 0; ; hop++) {
        check();
        if (seen.has(url.href)) throw fail("WEB_REDIRECT_LOOP", "网页发生循环重定向，已停止抓取。");
        seen.add(url.href);
        const address = await resolvePublic(url, lookup, controller.signal);
        check();
        const response = await requestPage(url, address, controller.signal, transport);
        check();
        if ("redirect" in response) {
          if (hop >= MAX_REDIRECTS) throw fail("WEB_REDIRECT_LIMIT", "网页超过 3 次重定向上限。");
          const next = safeUrl(response.redirect, url);
          if (url.protocol === "https:" && next.protocol === "http:")
            throw fail("WEB_HTTPS_DOWNGRADE", "网页尝试从 HTTPS 跳转到 HTTP，已停止抓取。");
          url = next;
          continue;
        }
        const html = decodeHtml(response.body, response.contentType);
        check();
        if (!html.trim()) throw fail("WEB_EMPTY_PAGE", "网页没有返回可读正文。");
        return {
          originalUrl,
          finalUrl: url.href,
          html,
          contentType: response.contentType,
          fetchedAt: new Date().toISOString(),
        };
      }
    } catch (error) {
      throw transportError(error, controller.signal);
    } finally {
      clearTimeout(timer);
      externalSignal?.removeEventListener("abort", cancel);
    }
  };
}

/** Real Node transport; never uses fetch, ambient proxy settings or browser credentials. */
export const fetchWebPage = createWebPageFetcher();
