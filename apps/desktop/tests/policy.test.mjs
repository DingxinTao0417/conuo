import assert from "node:assert/strict";
import { test } from "node:test";
import {
  resolveConfig,
  isInternalUrl,
  isSafeExternalUrl,
  isAllowedDownload,
  sanitizeFilename,
  validShellAction,
  STAGING_ORIGIN,
} from "../dist/policy.js";

test("packaged app defaults only to staging with a separate persistent session", () => {
  const config = resolveConfig({}, true);
  assert.equal(config.origin, STAGING_ORIGIN);
  assert.equal(config.startUrl, `${STAGING_ORIGIN}/#home`);
  assert.match(config.partition, /^persist:conuo-staging-/u);
});
test("production requires explicit HTTPS origin and isolates cookies", () => {
  assert.throws(() => resolveConfig({ CONUO_DESKTOP_ENV: "production" }, true));
  const production = resolveConfig(
    {
      CONUO_DESKTOP_ENV: "production",
      CONUO_DESKTOP_URL: "https://conuo.example.com",
    },
    true,
  );
  assert.notEqual(production.partition, resolveConfig({}, true).partition);
  for (const url of [
    "http://conuo.example.com",
    STAGING_ORIGIN,
    "https://127.0.0.1",
    "https://localhost",
    "https://192.168.1.2",
  ]) {
    assert.throws(() =>
      resolveConfig(
        { CONUO_DESKTOP_ENV: "production", CONUO_DESKTOP_URL: url },
        true,
      ),
    );
  }
});
test("only unpackaged loopback development URLs are accepted", () => {
  const env = {
    CONUO_DESKTOP_ENV: "development",
    CONUO_DESKTOP_URL: "http://127.0.0.1:39123",
  };
  assert.equal(resolveConfig(env, false).environment, "development");
  assert.throws(() => resolveConfig(env, true));
  assert.throws(() =>
    resolveConfig({ ...env, CONUO_DESKTOP_URL: "http://example.com" }, false),
  );
  assert.throws(() =>
    resolveConfig({ CONUO_DESKTOP_URL: "https://example.com" }, false),
  );
});
test("environment rejects credentials, routes, query strings and fragment tokens", () => {
  for (const value of [
    "https://user:pass@conuo.example.com",
    "https://conuo.example.com/path",
    "https://conuo.example.com?token=x",
    "https://conuo.example.com#token=x",
    " https://conuo.example.com",
    "https://conuo.example.com\n",
  ]) {
    assert.throws(() =>
      resolveConfig(
        { CONUO_DESKTOP_ENV: "production", CONUO_DESKTOP_URL: value },
        false,
      ),
    );
  }
});
test("navigation matches parsed exact origin, never prefixes or credentials", () => {
  assert.equal(
    isInternalUrl(`${STAGING_ORIGIN}/#source/test`, STAGING_ORIGIN),
    true,
  );
  for (const value of [
    `${STAGING_ORIGIN}.evil.test/`,
    "https://user@conuo-staging.vercel.app",
    "javascript:alert(1)",
    "file:///etc/passwd",
    "data:text/html,hello",
    "blob:https://conuo-staging.vercel.app/test",
    "https://conuo-staging.vercel.app:8443/",
    "https://conuo-staging.vercel.app\n.evil.test",
  ]) {
    assert.equal(isInternalUrl(value, STAGING_ORIGIN), false, value);
  }
});
test("external links allow only public web schemes and reject local/executable URLs", () => {
  assert.equal(isSafeExternalUrl("https://example.com/article"), true);
  for (const value of [
    "file:///C:/Windows/System32/cmd.exe",
    "ms-settings:privacy",
    "javascript:alert(1)",
    "mailto:test@example.com",
    "http://localhost:3000/",
    "http://127.0.0.1/",
    "http://2130706433/",
    "http://[::1]/",
    "https://user:password@example.com",
    "http://service.local",
    "http://192.168.0.5",
    "http://172.20.0.1",
    "http://169.254.169.254/",
  ]) {
    assert.equal(isSafeExternalUrl(value), false, value);
  }
});
test("download ownership is verified against initiator, not just the containing tab", () => {
  assert.equal(
    isAllowedDownload(
      `blob:${STAGING_ORIGIN}/abc`,
      STAGING_ORIGIN,
      STAGING_ORIGIN,
    ),
    true,
  );
  assert.equal(
    isAllowedDownload(
      `${STAGING_ORIGIN}/export`,
      STAGING_ORIGIN,
      STAGING_ORIGIN,
    ),
    true,
  );
  for (const [url, initiator] of [
    [`${STAGING_ORIGIN}/export`, "null"],
    [`${STAGING_ORIGIN}/export`, "https://evil.test"],
    ["blob:https://evil.test/abc", STAGING_ORIGIN],
    ["file:///C:/secret", STAGING_ORIGIN],
    ["https://supabase.example.test/file", STAGING_ORIGIN],
  ]) {
    assert.equal(isAllowedDownload(url, initiator, STAGING_ORIGIN), false);
  }
});
test("download filenames cannot set directories or Windows reserved names", () => {
  assert.equal(sanitizeFilename("../../report.pdf"), "report.pdf");
  assert.equal(sanitizeFilename("C:\\Users\\report.pdf"), "report.pdf");
  assert.equal(sanitizeFilename("con.txt"), "conuo-con.txt");
  assert.equal(sanitizeFilename("..."), "conuo-download");
  assert.equal(sanitizeFilename("report?.pdf"), "report_.pdf");
});
test("trusted shell actions expose IDs, not paths or arbitrary IPC channels", () => {
  assert.equal(validShellAction({ action: "reload" }), true);
  assert.equal(
    validShellAction({
      action: "reveal-download",
      id: "00000000-0000-0000-0000-000000000000",
    }),
    true,
  );
  for (const action of [
    null,
    "reload",
    { action: "execute" },
    { action: "read-file" },
    { action: "cancel-download", id: "../secret" },
    { action: "reveal-download" },
  ])
    assert.equal(validShellAction(action), false);
});

test("titlebar menus accept only fixed menus and bounded local anchor coordinates", () => {
  assert.equal(validShellAction({ action: "toggle-sidebar" }), true);
  for (const id of ["file", "edit", "view", "help"]) {
    assert.equal(
      validShellAction({ action: "menu", id, anchor: { x: 112, y: 36 } }),
      true,
    );
  }
  for (const payload of [
    { action: "menu", id: "execute", anchor: { x: 1, y: 1 } },
    { action: "menu", id: "edit" },
    { action: "menu", id: "edit", anchor: { x: -1, y: 36 } },
    { action: "menu", id: "edit", anchor: { x: 16001, y: 36 } },
    { action: "menu", id: "edit", anchor: { x: 112, y: 41 } },
    { action: "menu", id: "edit", anchor: { x: "112", y: 36 } },
    { action: "menu", id: "edit", anchor: { x: 12.5, y: 36 } },
  ])
    assert.equal(validShellAction(payload), false);
});
