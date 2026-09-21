import { createServer } from "node:http";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const desktopRoot = fileURLToPath(new URL("../", import.meta.url));
const output = path.join(desktopRoot, ".smoke", String(Date.now()));
await mkdir(path.join(output, "profile"), { recursive: true });
const workspaceCSS = (
  await Promise.all(
    [
      "app/styles/tokens.css",
      "app/styles/app-shell.css",
      "app/styles/responsive-800.css",
      "app/styles/responsive-phone.css",
      "components/library-workspace.css",
    ].map((file) =>
      readFile(path.join(desktopRoot, "../web/src", file), "utf8"),
    ),
  )
).join("\n");
const server = createServer((request, response) => {
  if (request.url === "/server-error") {
    response.writeHead(503, { "Content-Type": "text/html" });
    response.end("<title>Unavailable</title><p>Test service unavailable</p>");
    return;
  }
  if (request.url === "/unavailable") {
    request.socket.destroy();
    return;
  }
  if (request.url === "/slow-download") {
    response.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": "attachment; filename=conuo-cancel-test.bin",
      "Content-Length": "10485760",
    });
    response.write(Buffer.alloc(1024));
    const timer = setInterval(() => response.write(Buffer.alloc(1024)), 100);
    response.on("close", () => clearInterval(timer));
    return;
  }
  response.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy":
      "default-src 'self'; style-src 'unsafe-inline'; script-src 'none'",
  });
  response.end(
    `<!doctype html><html lang="zh-CN"><title>Conuo desktop test</title>
    <style>${workspaceCSS}
      body { margin: 0; font-family: "Segoe UI", "Microsoft YaHei", sans-serif; }
      .fixture-content { padding: 32px; } .sidebar-scrim { display: none; }
    </style><body><div class="app-shell library-workspace">
      <button class="sidebar-scrim" aria-label="关闭导航"></button>
      <aside class="sidebar"><div class="brand"><span>Conuo</span></div><nav>学习概览<br>资料库<br>我的笔记</nav></aside>
      <main class="app-main"><header class="topbar"><button class="mobile-menu" aria-label="打开导航">导航</button>学习概览</header><section class="fixture-content">
        <h1>Conuo 桌面隔离测试</h1><p>使用实际工作区布局样式，不连接云端。</p>
        <textarea id="draft">尚未保存的测试草稿</textarea><aside id="reader-tools">阅读工具和 AI 面板保持可见</aside>
      </section></main>
    </div></body></html>`,
  );
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const env = {
  ...process.env,
  CONUO_DESKTOP_ENV: "development",
  CONUO_DESKTOP_URL: `http://127.0.0.1:${server.address().port}`,
  CONUO_DESKTOP_SMOKE_USER_DATA: path.join(output, "profile"),
  CONUO_DESKTOP_SMOKE_RESULT: path.join(output, "results.json"),
  CONUO_DESKTOP_SMOKE_SCREENSHOT: path.join(output, "connection-error.png"),
};
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(require("electron"), [desktopRoot, "--conuo-smoke"], {
  env,
  windowsHide: true,
  stdio: ["ignore", "pipe", "pipe"],
});
const timeout = setTimeout(() => child.kill(), 45000);
let diagnostic = "";
child.stdout.on("data", (chunk) => {
  for (const line of String(chunk).split("\n"))
    if (line.startsWith("desktop-smoke:")) console.log(line.trim());
});
child.stderr.on("data", (chunk) => {
  diagnostic += String(chunk);
});
const exitCode = await new Promise((resolve, reject) => {
  child.once("exit", resolve);
  child.once("error", reject);
});
clearTimeout(timeout);
server.close();
try {
  const results = JSON.parse(
    await readFile(path.join(output, "results.json"), "utf8"),
  );
  console.log(
    JSON.stringify(
      {
        exitCode,
        passed: exitCode === 0 && Object.values(results).every(Boolean),
        assertions: results,
        artifacts: path.relative(desktopRoot, output),
      },
      null,
      2,
    ),
  );
} catch {
  console.error("Desktop smoke produced no completed result.");
  if (diagnostic.includes("Conuo desktop could not start"))
    console.error("Desktop startup or smoke assertion execution failed.");
  const failure = diagnostic
    .split("\n")
    .find((line) => line.includes("Desktop smoke error:"));
  if (failure) console.error(failure);
}
process.exitCode = exitCode === 0 ? 0 : 1;
