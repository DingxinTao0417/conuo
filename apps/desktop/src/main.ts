import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  protocol,
  screen,
  session,
  shell,
  WebContentsView,
  type DownloadItem,
  type IpcMainInvokeEvent,
  type MenuItemConstructorOptions,
} from "electron";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  isAllowedDownload,
  isInternalUrl,
  isSafeExternalUrl,
  resolveConfig,
  sanitizeFilename,
  SHELL_URL,
  validShellAction,
  TITLE_BAR_HEIGHT,
  TITLE_BAR_COLOR,
  DESKTOP_MENU_IDS,
} from "./policy.js";
import {
  readWindowState,
  restoreWindowState,
  writeWindowState,
} from "./window-state.js";
import { workspaceSidebarCSS } from "./sidebar-style.js";

app.enableSandbox();
protocol.registerSchemesAsPrivileged([
  {
    scheme: "conuo-desktop",
    privileges: { standard: true, secure: true, supportFetchAPI: true },
  },
]);
app.setName("Conuo Preview");
const smokeMode = !app.isPackaged && process.argv.includes("--conuo-smoke");
if (smokeMode)
  process.on("uncaughtException", (error) => {
    console.error(
      "Desktop smoke error:",
      error.stack?.split("\n").slice(0, 3).join(" ") || error.message,
    );
    app.exit(1);
  });
const config = resolveConfig(process.env, app.isPackaged);
if (smokeMode && config.environment !== "development") {
  throw new Error("Desktop smoke is restricted to a local development origin");
}
const sessionDirectory = config.partition.replace(/^persist:/u, "");
app.setPath(
  "userData",
  smokeMode && process.env.CONUO_DESKTOP_SMOKE_USER_DATA
    ? process.env.CONUO_DESKTOP_SMOKE_USER_DATA
    : path.join(
        app.getPath("appData"),
        "Conuo Desktop Preview",
        sessionDirectory,
      ),
);

type DownloadRecord = {
  id: string;
  filename: string;
  status: string;
  received: number;
  total: number;
  savedPath?: string;
  item?: DownloadItem;
};
const downloads = new Map<string, DownloadRecord>();
let window: BrowserWindow | null = null;
let view: WebContentsView | null = null;
let page: "workspace" | "connection" | "downloads" = "workspace";
let connection: "loading" | "ready" | "error" = "loading";
let lastWorkspaceUrl = config.startUrl;
let mainResponseFailed = false;
let loadGeneration = 0;
let cancelPendingNavigation: (() => void) | null = null;
let externalPrompt = false;
let closingConfirmed = false;
let closingPrompt = false;
let remoteClosePending = false;
let sidebarHidden = false;
let sidebarStyleKey: string | null = null;
let sidebarDocument = 0;
let sidebarUpdate: Promise<void> = Promise.resolve();
let menuFocusRequest = 0;
let menuFocusId: string | null = null;

function applySidebarStyle(): Promise<void> {
  const contents = view?.webContents;
  const document = sidebarDocument;
  const hidden = sidebarHidden;
  sidebarUpdate = sidebarUpdate
    .catch(() => undefined)
    .then(async () => {
      if (!contents || contents.isDestroyed() || document !== sidebarDocument)
        return;
      if (!isInternalUrl(contents.getURL(), config.origin)) return;
      const key = await contents.insertCSS(workspaceSidebarCSS(hidden));
      if (contents.isDestroyed()) return;
      if (document !== sidebarDocument) {
        await contents.removeInsertedCSS(key).catch(() => undefined);
        return;
      }
      const oldKey = sidebarStyleKey;
      sidebarStyleKey = key;
      if (oldKey) await contents.removeInsertedCSS(oldKey);
    });
  return sidebarUpdate;
}

async function toggleSidebar() {
  if (page !== "workspace" || connection !== "ready") return;
  sidebarHidden = !sidebarHidden;
  await applySidebarStyle();
  sendState();
}

function showWorkspace() {
  page = "workspace";
  sendState();
  const contents = view?.webContents;
  if (connection === "ready" && contents && !contents.isDestroyed())
    contents.focus();
}

function navigateHistory(direction: "back" | "forward") {
  const contents = view?.webContents;
  if (!contents || contents.isDestroyed()) return;
  const history = contents.navigationHistory;
  if (direction === "back" ? !history.canGoBack() : !history.canGoForward())
    return;
  showWorkspace();
  if (direction === "back") history.goBack();
  else history.goForward();
}

function state() {
  const remoteContents = view?.webContents;
  const contents =
    remoteContents && !remoteContents.isDestroyed() ? remoteContents : null;
  return {
    platform: process.platform,
    titleBarHeight: TITLE_BAR_HEIGHT,
    titleBarColor: TITLE_BAR_COLOR,
    fullscreen: window?.isFullScreen() ?? false,
    sidebarHidden,
    menuFocusRequest,
    menuFocusId,
    canToggleSidebar: page === "workspace" && connection === "ready",
    page,
    connection,
    environment: config.environment,
    origin: config.origin,
    version: app.getVersion(),
    canBack: contents?.navigationHistory.canGoBack() ?? false,
    canForward: contents?.navigationHistory.canGoForward() ?? false,
    downloads: [...downloads.values()].map(
      ({ id, filename, status, received, total, item }) => ({
        id,
        filename,
        status,
        received,
        total,
        cancellable: !!item,
      }),
    ),
  };
}

function sendState() {
  if (!window || window.isDestroyed() || window.webContents.isDestroyed())
    return;
  window.webContents.send("desktop:state", state());
  if (view?.webContents && !view.webContents.isDestroyed()) {
    const visible = page === "workspace" && connection === "ready";
    const changed = view.getVisible() !== visible;
    view.setVisible(visible);
    if (changed && !visible) window.webContents.focus();
  }
}

function resizeView() {
  if (!window || !view) return;
  const [width = 1440, height = 960] = window.getContentSize();
  view.setBounds({
    x: 0,
    y: TITLE_BAR_HEIGHT,
    width,
    height: Math.max(0, height - TITLE_BAR_HEIGHT),
  });
}

function popupAppMenu(
  id: string,
  anchor: { x: number; y: number },
  smokePopup?: (menu: Menu, close: () => void) => void,
): Promise<void> {
  if (
    !window ||
    window.isDestroyed() ||
    !DESKTOP_MENU_IDS.some((menu) => menu === id)
  )
    return Promise.resolve();
  const submenu = Menu.getApplicationMenu()?.getMenuItemById(id)?.submenu;
  if (!submenu || (smokeMode && !smokePopup)) return Promise.resolve();
  const startPage = page;
  const contents =
    page === "workspace" && connection === "ready"
      ? view?.webContents
      : window.webContents;
  let commandChosen = false;
  // Keep native menus, but dispatch their roles to the intended view only when
  // selected. Focusing the remote view while opening a popup loses the keyboard
  // menu origin and makes cancellation jump away from the top-level menu.
  const popup = Menu.buildFromTemplate(
    submenu.items.map((item): MenuItemConstructorOptions => ({
      type: item.type,
      label: item.label,
      enabled: item.enabled,
      visible: item.visible,
      accelerator: item.accelerator ?? undefined,
      registerAccelerator: false,
      click: (_chosen, owner, event) => {
        commandChosen = true;
        const role = item.role?.toLowerCase();
        if (
          role &&
          ["undo", "redo", "cut", "copy", "paste", "selectall"].includes(role)
        ) {
          if (contents && !contents.isDestroyed()) {
            contents.focus();
            item.click(event, owner, contents);
          }
        } else item.click(event, owner, contents);
      },
    })),
  );
  const [width = 880] = window.getContentSize();
  return new Promise((resolve) => {
    const closed = () => {
      if (
        !commandChosen &&
        window &&
        !window.isDestroyed() &&
        page === startPage
      ) {
        window.webContents.focus();
        menuFocusId = id;
        menuFocusRequest += 1;
        sendState();
      }
      resolve();
    };
    if (smokeMode && smokePopup) smokePopup(popup, closed);
    else
      popup.popup({
        window: window!,
        x: Math.max(0, Math.min(anchor.x, width - 20)),
        y: Math.min(anchor.y, TITLE_BAR_HEIGHT),
        callback: closed,
      });
  });
}

function menuKeyboardEntry(
  event: { preventDefault(): void },
  input: Electron.Input,
) {
  if (process.platform === "darwin" || input.type !== "keyDown") return;
  const shortcuts: Record<string, string> = {
    f: "file",
    e: "edit",
    v: "view",
    h: "help",
  };
  const id =
    input.alt && !input.control && !input.meta
      ? shortcuts[input.key.toLowerCase()]
      : input.key === "F10" &&
          !input.shift &&
          !input.control &&
          !input.alt &&
          !input.meta
        ? "file"
        : undefined;
  if (!id) return;
  event.preventDefault();
  void popupAppMenu(id, {
    x:
      112 +
      DESKTOP_MENU_IDS.indexOf(id as (typeof DESKTOP_MENU_IDS)[number]) * 48,
    y: TITLE_BAR_HEIGHT,
  });
}

async function loadWorkspace(destination = config.startUrl) {
  const contents = view?.webContents;
  if (!contents || contents.isDestroyed()) return;
  const generation = ++loadGeneration;
  cancelPendingNavigation?.();
  const cancelledByUser = new Promise<void>((resolve) => {
    cancelPendingNavigation = resolve;
  });
  if (!isInternalUrl(destination, config.origin))
    destination = lastWorkspaceUrl;
  lastWorkspaceUrl = destination;
  mainResponseFailed = false;
  page = "workspace";
  connection = "loading";
  sendState();
  let timeout: ReturnType<typeof setTimeout>;
  const deadline = new Promise<void>((resolve) => {
    timeout = setTimeout(() => {
      resolve();
      if (generation !== loadGeneration || contents.isDestroyed()) return;
      contents.stop();
      connection = "error";
      sendState();
    }, 30000);
  });
  try {
    // Chromium may leave loadURL pending after beforeunload cancels navigation.
    // Resolve the desktop action explicitly while preserving the current document.
    await Promise.race([
      contents.loadURL(destination),
      cancelledByUser,
      deadline,
    ]);
  } catch (error: unknown) {
    if (generation !== loadGeneration || contents.isDestroyed()) return;
    const cancelled =
      error instanceof Error && "code" in error && error.code === "ERR_ABORTED";
    connection =
      cancelled && isInternalUrl(contents.getURL(), config.origin)
        ? "ready"
        : "error";
    sendState();
  } finally {
    clearTimeout(timeout!);
    if (generation === loadGeneration) cancelPendingNavigation = null;
  }
}

async function openExternal(value: string) {
  if (
    !window ||
    window.isDestroyed() ||
    !isSafeExternalUrl(value) ||
    externalPrompt ||
    smokeMode
  )
    return;
  externalPrompt = true;
  try {
    const result = await dialog.showMessageBox(window, {
      type: "question",
      title: "在默认浏览器中打开",
      message: `即将访问 ${new URL(value).hostname}`,
      detail: "该页面将在系统浏览器中打开。",
      buttons: ["取消", "打开浏览器"],
      defaultId: 0,
      cancelId: 0,
    });
    if (result.response === 1) await shell.openExternal(value);
  } catch {
    // Failure does not navigate the trusted shell or leak the requested URL into logs.
  } finally {
    externalPrompt = false;
  }
}

function isShellSender(event: IpcMainInvokeEvent): boolean {
  return (
    !!window &&
    event.sender === window.webContents &&
    event.senderFrame === window.webContents.mainFrame &&
    event.senderFrame?.url === SHELL_URL
  );
}

function buildMenu() {
  const isMac = process.platform === "darwin";
  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: "Conuo",
            submenu: [
              { role: "about" },
              { type: "separator" },
              { role: "hide" },
              { role: "hideOthers" },
              { role: "unhide" },
              { type: "separator" },
              { role: "quit" },
            ],
          } as MenuItemConstructorOptions,
        ]
      : []),
    {
      id: "file",
      label: "文件",
      submenu: [
        {
          label: "学习概览",
          accelerator: "CmdOrCtrl+Shift+H",
          click: () => {
            void loadWorkspace();
          },
        },
        {
          label: "下载",
          accelerator: "CmdOrCtrl+J",
          click: () => {
            page = "downloads";
            sendState();
          },
        },
        {
          label: "连接与版本",
          click: () => {
            page = "connection";
            sendState();
          },
        },
        { type: "separator" },
        isMac ? { role: "close" } : { role: "quit", label: "退出" },
      ],
    },
    {
      id: "edit",
      label: "编辑",
      submenu: [
        { role: "undo", label: "撤销" },
        { role: "redo", label: "重做" },
        { type: "separator" },
        { role: "cut", label: "剪切" },
        { role: "copy", label: "复制" },
        { role: "paste", label: "粘贴" },
        { role: "selectAll", label: "全选" },
      ],
    },
    {
      id: "view",
      label: "视图",
      submenu: [
        {
          id: "toggle-sidebar",
          label: "显示 / 隐藏侧边栏",
          accelerator: "CmdOrCtrl+\\",
          click: () => {
            void toggleSidebar().catch(() => undefined);
          },
        },
        { type: "separator" },
        {
          label: "重新加载",
          accelerator: "CmdOrCtrl+R",
          click: () => {
            void loadWorkspace(view?.webContents.getURL() || config.startUrl);
          },
        },
        {
          label: "返回工作区",
          accelerator: "CmdOrCtrl+Shift+1",
          click: () => {
            showWorkspace();
          },
        },
        {
          label: "后退",
          accelerator: isMac ? "Cmd+[" : "Alt+Left",
          click: () => navigateHistory("back"),
        },
        {
          label: "前进",
          accelerator: isMac ? "Cmd+]" : "Alt+Right",
          click: () => navigateHistory("forward"),
        },
        { type: "separator" },
        {
          label: "放大",
          accelerator: "CmdOrCtrl+Plus",
          click: () => {
            if (view)
              view.webContents.setZoomLevel(
                Math.min(3, view.webContents.getZoomLevel() + 0.5),
              );
          },
        },
        {
          label: "缩小",
          accelerator: "CmdOrCtrl+-",
          click: () => {
            if (view)
              view.webContents.setZoomLevel(
                Math.max(-2, view.webContents.getZoomLevel() - 0.5),
              );
          },
        },
        {
          label: "实际大小",
          accelerator: "CmdOrCtrl+0",
          click: () => {
            view?.webContents.setZoomLevel(0);
          },
        },
        { role: "togglefullscreen", label: "全屏" },
      ],
    },
    ...(isMac
      ? [{ role: "windowMenu", label: "窗口" } as MenuItemConstructorOptions]
      : []),
    {
      id: "help",
      label: "帮助",
      submenu: [
        {
          label: "关于 Conuo Preview",
          click: () => {
            page = "connection";
            sendState();
          },
        },
        {
          label: "在浏览器中打开 Conuo",
          click: () => {
            void openExternal(config.origin);
          },
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  if (!isMac && window) {
    window.setAutoHideMenuBar(false);
    window.setMenuBarVisibility(false);
  }
}

async function createWindow() {
  closingConfirmed = false;
  closingPrompt = false;
  remoteClosePending = false;
  page = "workspace";
  connection = "loading";
  const preferencePath = path.join(
    app.getPath("userData"),
    "window-state.json",
  );
  const primaryDisplay = screen.getPrimaryDisplay();
  const restored = restoreWindowState(readWindowState(preferencePath), [
    primaryDisplay.workArea,
    ...screen
      .getAllDisplays()
      .filter((display) => display.id !== primaryDisplay.id)
      .map((display) => display.workArea),
  ]);
  const remoteSession = session.fromPartition(config.partition);
  remoteSession.setPermissionRequestHandler(
    (contents, permission, callback, details) => {
      callback(
        contents === view?.webContents &&
          permission === "clipboard-sanitized-write" &&
          details.isMainFrame &&
          isInternalUrl(details.requestingUrl, config.origin) &&
          contents.isFocused(),
      );
    },
  );
  remoteSession.setPermissionCheckHandler(
    (contents, permission, requestingOrigin) =>
      contents === view?.webContents &&
      permission === "clipboard-sanitized-write" &&
      requestingOrigin === config.origin &&
      contents.isFocused(),
  );
  remoteSession.setDevicePermissionHandler(() => false);
  remoteSession.setDisplayMediaRequestHandler((_request, callback) =>
    callback({}),
  );

  const localSession = session.fromPartition("conuo-desktop-shell");
  localSession.setPermissionRequestHandler((_contents, _permission, callback) =>
    callback(false),
  );
  localSession.setPermissionCheckHandler(() => false);
  // Only packaged allowlisted assets are served; no arbitrary filesystem URL handling.
  if (await localSession.protocol.isProtocolHandled("conuo-desktop"))
    localSession.protocol.unhandle("conuo-desktop");
  localSession.protocol.handle("conuo-desktop", async (request) => {
    const url = new URL(request.url);
    const assets: Record<string, string> = {
      "/index.html": "text/html",
      "/shell.css": "text/css",
      "/shell.js": "text/javascript",
      "/icon.png": "image/png",
    };
    const mime = assets[url.pathname];
    if (
      url.hostname !== "app" ||
      !mime ||
      url.search ||
      request.method !== "GET"
    )
      return new Response("Not found", { status: 404 });
    const content = await readFile(
      path.join(__dirname, "ui", url.pathname.slice(1)),
    );
    return new Response(content, {
      headers: {
        "Content-Type": mime,
        "Content-Security-Policy":
          "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; frame-src 'none'; base-uri 'none'; form-action 'none'",
        "X-Content-Type-Options": "nosniff",
      },
    });
  });
  window = new BrowserWindow({
    title: "Conuo Preview",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "hidden",
    ...(process.platform === "darwin"
      ? {}
      : {
          titleBarOverlay: {
            color: TITLE_BAR_COLOR,
            symbolColor: "#63636c",
            height: TITLE_BAR_HEIGHT,
          },
        }),
    ...restored.bounds,
    minWidth: Math.min(880, restored.bounds.width),
    minHeight: Math.min(600, restored.bounds.height),
    show: false,
    backgroundColor: TITLE_BAR_COLOR,
    icon: path.join(__dirname, "ui", "icon.png"),
    webPreferences: {
      session: localSession,
      preload: path.join(__dirname, "preload.js"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false,
      webSecurity: true,
      devTools: !app.isPackaged,
      backgroundThrottling: !smokeMode,
      offscreen: smokeMode,
    },
  });
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.webContents.on("before-input-event", menuKeyboardEntry);
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-attach-webview", (event) =>
    event.preventDefault(),
  );
  view = new WebContentsView({
    webPreferences: {
      session: remoteSession,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      experimentalFeatures: false,
      devTools: !app.isPackaged,
      navigateOnDragDrop: false,
      backgroundThrottling: !smokeMode,
    },
  });
  window.contentView.addChildView(view);
  view.webContents.setZoomLevel(restored.zoom);
  view.setVisible(false);
  resizeView();
  window.on("resize", resizeView);
  window.on("enter-full-screen", () => {
    resizeView();
    sendState();
  });
  window.on("leave-full-screen", () => {
    resizeView();
    sendState();
  });
  window.on("close", (event) => {
    const closingContents = view?.webContents;
    if (
      !smokeMode &&
      window &&
      closingContents &&
      !closingContents.isDestroyed()
    ) {
      writeWindowState(preferencePath, {
        bounds: window.getNormalBounds(),
        maximized: window.isMaximized(),
        zoom: closingContents.getZoomLevel(),
      });
    }
    if (!closingContents || closingContents.isDestroyed()) return;
    event.preventDefault();
    if (closingPrompt || remoteClosePending) return;
    if (
      closingConfirmed ||
      ![...downloads.values()].some((item) => item.item)
    ) {
      remoteClosePending = true;
      closingContents.close({ waitForBeforeUnload: true });
      return;
    }
    closingPrompt = true;
    void dialog
      .showMessageBox(window!, {
        type: "question",
        message: "下载尚未完成",
        detail: "退出将取消当前下载。",
        buttons: ["继续下载", "取消下载并退出"],
        defaultId: 0,
        cancelId: 0,
      })
      .then((result) => {
        // The next close event is synchronous, so release this guard first.
        closingPrompt = false;
        if (result.response === 1) {
          closingConfirmed = true;
          for (const item of downloads.values()) item.item?.cancel();
          window?.close();
        }
      })
      .catch(() => undefined)
      .finally(() => {
        closingPrompt = false;
      });
  });
  window.on("closed", () => {
    const closingContents = view?.webContents;
    if (closingContents && !closingContents.isDestroyed())
      closingContents.close();
    view = null;
    window = null;
    remoteSession.removeAllListeners("will-download");
  });
  const contents = view.webContents;
  contents.on("before-input-event", menuKeyboardEntry);
  let restoreZoomOnLoad = true;
  contents.on("context-menu", (_event, params) => {
    const template: MenuItemConstructorOptions[] = [];
    if (params.isEditable) {
      template.push(
        { role: "undo", label: "撤销", enabled: params.editFlags.canUndo },
        { role: "redo", label: "重做", enabled: params.editFlags.canRedo },
        { type: "separator" },
        { role: "cut", label: "剪切", enabled: params.editFlags.canCut },
        { role: "copy", label: "复制", enabled: params.editFlags.canCopy },
        { role: "paste", label: "粘贴", enabled: params.editFlags.canPaste },
        {
          role: "selectAll",
          label: "全选",
          enabled: params.editFlags.canSelectAll,
        },
      );
    } else if (params.selectionText)
      template.push({
        role: "copy",
        label: "复制",
        enabled: params.editFlags.canCopy,
      });
    if (template.length && window && !smokeMode) {
      contents.focus();
      Menu.buildFromTemplate(template).popup({ window });
    }
  });
  contents.on("before-input-event", (event, input) => {
    if (
      input.type === "keyDown" &&
      input.key === "F5" &&
      !input.alt &&
      !input.control &&
      !input.meta &&
      !input.shift
    ) {
      event.preventDefault();
      void loadWorkspace(contents.getURL() || config.startUrl);
    }
  });
  contents.once("destroyed", () => {
    if (remoteClosePending) window?.close();
  });
  contents.on("will-prevent-unload", (event) => {
    const leave =
      !smokeMode &&
      window &&
      dialog.showMessageBoxSync(window, {
        type: "question",
        title: "尚有内容未保存",
        message: "工作区正在保存或有未同步内容。",
        detail: "离开页面可能丢失尚未保存的修改。",
        buttons: ["留在页面", "仍然离开"],
        defaultId: 0,
        cancelId: 0,
      }) === 1;
    if (leave) event.preventDefault();
    else {
      remoteClosePending = false;
      closingConfirmed = false;
      connection = "ready";
      cancelPendingNavigation?.();
      sendState();
    }
  });
  contents.on("did-navigate", (_event, url, responseCode) => {
    // Reset only after commit: beforeunload can cancel a started navigation.
    sidebarDocument++;
    sidebarStyleKey = null;
    mainResponseFailed = responseCode >= 400;
    if (isInternalUrl(url, config.origin)) lastWorkspaceUrl = url;
  });
  contents.on("will-attach-webview", (event) => event.preventDefault());
  contents.on("will-navigate", (event, url) => {
    if (isInternalUrl(url, config.origin)) return;
    event.preventDefault();
    void openExternal(url);
  });
  contents.on("will-redirect", (event, url, _inPlace, isMainFrame) => {
    if (isMainFrame && !isInternalUrl(url, config.origin))
      event.preventDefault();
  });
  contents.on("will-frame-navigate", (event) => {
    if (
      !event.isMainFrame &&
      !isInternalUrl(event.url, config.origin) &&
      !(
        event.url.startsWith("blob:") &&
        new URL(event.url).origin === config.origin
      ) &&
      event.url !== "about:blank"
    )
      event.preventDefault();
  });
  contents.setWindowOpenHandler(({ url }) => {
    if (isInternalUrl(url, config.origin)) void loadWorkspace(url);
    else void openExternal(url);
    return { action: "deny" };
  });
  contents.on("did-finish-load", () => {
    connection = mainResponseFailed ? "error" : "ready";
    if (connection === "ready" && restoreZoomOnLoad) {
      contents.setZoomLevel(restored.zoom);
      restoreZoomOnLoad = false;
    }
    sendState();
    if (connection === "ready") void applySidebarStyle().catch(() => undefined);
    if (connection === "ready") contents.focus();
  });
  contents.on("did-navigate-in-page", (_event, url, isMainFrame) => {
    if (isMainFrame && isInternalUrl(url, config.origin)) {
      connection = "ready";
      lastWorkspaceUrl = url;
    }
    sendState();
    if (page === "workspace" && connection === "ready") contents.focus();
  });
  contents.on(
    "did-fail-load",
    (_event, errorCode, _description, _url, mainFrame) => {
      if (mainFrame && errorCode !== -3) {
        connection = "error";
        sendState();
      }
    },
  );
  contents.on("render-process-gone", () => {
    connection = "error";
    sendState();
  });
  remoteSession.on("will-download", (event, item, sourceContents) => {
    if (
      sourceContents !== contents ||
      !isAllowedDownload(
        item.getURL(),
        item.getInitiatorOrigin(),
        config.origin,
      )
    ) {
      event.preventDefault();
      return;
    }
    const id = randomUUID();
    const record: DownloadRecord = {
      id,
      filename: sanitizeFilename(item.getFilename()),
      status: "progressing",
      received: 0,
      total: item.getTotalBytes(),
      item,
    };
    downloads.set(id, record);
    if (smokeMode)
      item.setSavePath(path.join(app.getPath("userData"), record.filename));
    else
      item.setSaveDialogOptions({
        title: "保存 Conuo 文件",
        defaultPath: path.join(app.getPath("downloads"), record.filename),
        buttonLabel: "保存",
        properties: ["showOverwriteConfirmation", "createDirectory"],
      });
    item.on("updated", (_event, status) => {
      record.status = status;
      record.received = item.getReceivedBytes();
      record.total = item.getTotalBytes();
      sendState();
    });
    item.once("done", (_event, status) => {
      record.status = status;
      record.received = item.getReceivedBytes();
      if (status === "completed") record.savedPath = item.getSavePath();
      record.item = undefined;
      sendState();
    });
    sendState();
  });
  window.webContents.on("did-finish-load", sendState);
  await window.loadURL(SHELL_URL);
  if (smokeMode) console.log("desktop-smoke: shell loaded");
  buildMenu();
  if (!smokeMode) {
    if (restored.maximized) window.maximize();
    window.show();
  }
  await loadWorkspace();
  if (smokeMode) console.log("desktop-smoke: workspace loaded");
}

ipcMain.handle("desktop:state", (event) => {
  if (!isShellSender(event)) throw new Error("Unauthorized desktop sender");
  return state();
});
ipcMain.handle("desktop:action", async (event, payload: unknown) => {
  if (!isShellSender(event) || !validShellAction(payload))
    throw new Error("Unauthorized desktop action");
  const contents = view?.webContents;
  try {
    switch (payload.action) {
      case "toggle-sidebar":
        await toggleSidebar();
        break;
      case "menu":
        await popupAppMenu(payload.id!, payload.anchor!);
        break;
      case "back":
        navigateHistory("back");
        break;
      case "forward":
        navigateHistory("forward");
        break;
      case "reload":
        await loadWorkspace(contents?.getURL() || config.startUrl);
        break;
      case "home":
        await loadWorkspace();
        break;
      case "downloads":
        page = "downloads";
        break;
      case "connection":
        page = "connection";
        break;
      case "workspace":
        showWorkspace();
        break;
      case "browser":
        await openExternal(config.origin);
        break;
      case "cancel-download":
        downloads.get(payload.id!)?.item?.cancel();
        break;
      case "reveal-download": {
        const record = downloads.get(payload.id!);
        if (record?.status === "completed" && record.savedPath)
          shell.showItemInFolder(record.savedPath);
        break;
      }
    }
    sendState();
  } catch {
    // A WebContentsView covers local HTML below the titlebar. Reveal the local
    // recovery panel before its renderer presents an actionable failure notice.
    page = "connection";
    sendState();
    throw new Error("Desktop action could not be completed");
  }
});

async function runSmoke() {
  const contents = view!.webContents;
  await sidebarUpdate;
  console.log("desktop-smoke: process isolation assertions");
  const result: Record<string, boolean> = {
    shellLoaded: window?.webContents.getURL() === SHELL_URL,
    remoteLoaded: connection === "ready",
    remoteBridgeAbsent: await contents.executeJavaScript(
      "typeof window.conuoDesktop === 'undefined' && typeof require === 'undefined' && typeof process === 'undefined'",
    ),
    localBridgePresent: await window!.webContents.executeJavaScript(
      "typeof window.conuoDesktop?.action === 'function'",
    ),
    hidden: !window?.isVisible(),
    geolocationDenied: await contents.executeJavaScript(
      "navigator.permissions.query({name:'geolocation'}).then(p => p.state === 'denied')",
    ),
    popupDenied: await contents.executeJavaScript(
      "window.open('https://example.com/') === null",
    ),
    traditionalMenuHidden:
      process.platform === "darwin" || !window!.isMenuBarVisible(),
    nativeMenuCommandsPreserved: DESKTOP_MENU_IDS.every(
      (id) => !!Menu.getApplicationMenu()?.getMenuItemById(id)?.submenu,
    ),
    workspaceBelowTitleBar: view!.getBounds().y === TITLE_BAR_HEIGHT,
    titleBarAndHitTargets: await window!.webContents.executeJavaScript(`(() => {
      const bar = document.querySelector('.toolbar');
      const button = document.querySelector('.toolbar button');
      return Math.round(bar.getBoundingClientRect().height) === ${TITLE_BAR_HEIGHT}
        && getComputedStyle(bar).getPropertyValue('-webkit-app-region') === 'drag'
        && getComputedStyle(button).getPropertyValue('-webkit-app-region') === 'no-drag';
    })()`),
    titleBarControlsReserve: await window!.webContents
      .executeJavaScript(`(() => {
      const bar = document.querySelector('.toolbar').getBoundingClientRect();
      const overlay = navigator.windowControlsOverlay?.getTitlebarAreaRect();
      return ${process.platform === "darwin"} || (bar.width > 500 && bar.right <= (overlay?.width ? overlay.x + overlay.width : innerWidth - 138) + 1);
    })()`),
  };
  console.log("desktop-smoke: sidebar toggle assertions");
  const readSidebar = () =>
    contents.executeJavaScript(`(() => {
    const sidebar = document.querySelector('.app-shell > aside.sidebar');
    const main = document.querySelector('.app-shell > main.app-main');
    const style = getComputedStyle(sidebar);
    return {
      visible: style.display !== 'none' && style.visibility === 'visible' && sidebar.getBoundingClientRect().right > 0,
      mainWidth: main.getBoundingClientRect().width,
      draft: document.getElementById('draft').value,
      toolsVisible: getComputedStyle(document.getElementById('reader-tools')).display !== 'none',
      scrimHidden: getComputedStyle(document.querySelector('.sidebar-scrim')).display === 'none',
      mobileOpenHidden: getComputedStyle(document.querySelector('.mobile-menu')).display === 'none',
    };
  })()`);
  const beforeSidebar = await readSidebar();
  // Exercise the actual toolbar click handler, preload and authenticated IPC.
  await window!.webContents.executeJavaScript(
    "document.getElementById('sidebar-toggle').click()",
  );
  for (let attempt = 0; attempt < 20; attempt++) {
    if (!(await readSidebar()).visible) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const afterSidebar = await readSidebar();
  result.sidebarButtonHidesNavigation =
    beforeSidebar.visible && !afterSidebar.visible;
  result.sidebarExpandsContentWithoutChangingDraft =
    afterSidebar.mainWidth > beforeSidebar.mainWidth &&
    afterSidebar.draft === beforeSidebar.draft &&
    afterSidebar.toolsVisible &&
    afterSidebar.scrimHidden;
  await loadWorkspace(`${config.origin}/#library`);
  await sidebarUpdate;
  result.sidebarStaysHiddenAfterNavigation = !(await readSidebar()).visible;
  await loadWorkspace();
  await sidebarUpdate;
  result.sidebarStaysHiddenAfterReload = !(await readSidebar()).visible;
  await window!.webContents.executeJavaScript(
    "window.conuoDesktop.action('toggle-sidebar')",
  );
  result.sidebarCanBeRestored = (await readSidebar()).visible;
  await window!.webContents.executeJavaScript(
    "Promise.all(Array.from({length: 4}, () => window.conuoDesktop.action('toggle-sidebar')))",
  );
  result.rapidSidebarTogglesStayConsistent =
    !sidebarHidden && (await readSidebar()).visible;
  const oldZoom = contents.getZoomLevel();
  contents.setZoomLevel(3);
  const priorBounds = window!.getBounds();
  window!.setSize(880, 640);
  resizeView();
  await new Promise((resolve) => setTimeout(resolve, 100));
  const zoomedVisible = (await readSidebar()).visible;
  await window!.webContents.executeJavaScript(
    "window.conuoDesktop.action('toggle-sidebar')",
  );
  const zoomedHidden = !(await readSidebar()).visible;
  await window!.webContents.executeJavaScript(
    "window.conuoDesktop.action('toggle-sidebar')",
  );
  result.sidebarToggleWorksAtPhoneBreakpoint =
    zoomedVisible &&
    zoomedHidden &&
    (await readSidebar()).visible &&
    (await readSidebar()).mobileOpenHidden;
  contents.setZoomLevel(oldZoom);
  window!.setBounds(priorBounds);
  resizeView();
  result.sidebarButtonReplacesLogoAndFileMenuRemains =
    await window!.webContents.executeJavaScript(
      "!!document.querySelector('.app-menu [data-id=file]') && !document.querySelector('.toolbar img') && document.querySelector('.toolbar').firstElementChild.id === 'sidebar-toggle' && document.getElementById('sidebar-toggle').getAttribute('aria-expanded') === 'true'",
    );
  console.log("desktop-smoke: navigation assertion");
  await loadWorkspace(`${config.origin}/#library`);
  result.hashNavigationVisible =
    connection === "ready" &&
    view?.getVisible() === true &&
    contents.getURL().endsWith("#library");
  page = "downloads";
  sendState();
  const wentBack = new Promise<void>((resolve) =>
    contents.once("did-navigate-in-page", () => setImmediate(resolve)),
  );
  navigateHistory("back");
  await wentBack;
  result.historyBackFromDownloadsShowsWorkspace =
    state().page === "workspace" &&
    view?.getVisible() === true &&
    contents.getURL().endsWith("#home");
  page = "connection";
  sendState();
  const wentForward = new Promise<void>((resolve) =>
    contents.once("did-navigate-in-page", () => setImmediate(resolve)),
  );
  navigateHistory("forward");
  await wentForward;
  result.historyForwardFromConnectionShowsWorkspace =
    state().page === "workspace" &&
    view?.getVisible() === true &&
    contents.getURL().endsWith("#library");
  await loadWorkspace();
  const navigationAttempt = new Promise<void>((resolve) =>
    contents.once("will-navigate", () => setImmediate(resolve)),
  );
  await contents.executeJavaScript(
    "setTimeout(() => { location.href = 'https://example.com/'; }, 0); true",
  );
  await navigationAttempt;
  result.crossOriginNavigationBlocked = isInternalUrl(
    contents.getURL(),
    config.origin,
  );
  await contents.executeJavaScript(
    "location.href = 'file:///conuo-blocked-navigation'; true",
  );
  result.localFileNavigationBlocked = isInternalUrl(
    contents.getURL(),
    config.origin,
  );
  console.log("desktop-smoke: download assertion");
  const downloaded = new Promise<DownloadRecord>((resolve) => {
    contents.session.once("will-download", (_event, item) =>
      item.once("done", () => resolve([...downloads.values()].at(-1)!)),
    );
  });
  await contents.executeJavaScript(
    "(() => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['{\"conuoDesktopSmoke\":true}'], {type:'application/json'})); a.download = 'conuo-smoke-backup.json'; document.body.append(a); a.click(); a.remove(); })()",
    true,
  );
  const record = await downloaded;
  result.blobDownloadSaved =
    record.status === "completed" &&
    !!record.savedPath &&
    (await readFile(record.savedPath, "utf8")) === '{"conuoDesktopSmoke":true}';
  const downloading = new Promise<DownloadRecord>((resolve) => {
    contents.session.once("will-download", (_event, item) => {
      const pendingRecord = [...downloads.values()].at(-1)!;
      item.once("updated", () => resolve(pendingRecord));
    });
  });
  await contents.executeJavaScript(
    "(() => { const a = document.createElement('a'); a.href = '/slow-download'; a.download = 'conuo-cancel-test.bin'; document.body.append(a); a.click(); a.remove(); })()",
    true,
  );
  const pendingDownload = await downloading;
  page = "downloads";
  sendState();
  const flushShell = () =>
    window!.webContents.executeJavaScript(
      "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
    );
  await flushShell();
  result.downloadPanelMovesFocusToHeading =
    await window!.webContents.executeJavaScript(
      "document.activeElement.id === 'downloads-title'",
    );
  await window!.webContents.executeJavaScript(`(() => {
    const row = document.querySelector('[data-id="${pendingDownload.id}"].download');
    window.smokeDownloadButton = row.querySelector('button');
    window.smokeDownloadButton.focus();
    window.smokeAnnouncement = document.getElementById('download-announcement').textContent;
    window.smokeProgress = row.querySelector('progress').value;
  })()`);
  await new Promise<void>((resolve) =>
    pendingDownload.item!.once("updated", () => resolve()),
  );
  await flushShell();
  result.downloadProgressKeepsButtonAndFocus = await window!.webContents
    .executeJavaScript(`
    document.activeElement === window.smokeDownloadButton && window.smokeDownloadButton.isConnected`);
  result.downloadProgressUpdatesWithoutLiveSpam = await window!.webContents
    .executeJavaScript(`(() => {
    const progress = document.querySelector('[data-id="${pendingDownload.id}"].download progress');
    return progress.value > window.smokeProgress && progress.max > progress.value
      && !!progress.getAttribute('aria-label') && !!progress.getAttribute('aria-valuetext')
      && document.getElementById('download-announcement').textContent === window.smokeAnnouncement;
  })()`);
  const cancelled = new Promise<boolean>((resolve) =>
    pendingDownload.item!.once("done", (_event, status) =>
      resolve(status === "cancelled"),
    ),
  );
  await window!.webContents.executeJavaScript(
    "window.smokeDownloadButton.click()",
  );
  result.downloadCancellation = await cancelled;
  await flushShell();
  result.cancelledDownloadRetainsRowFocusAndAnnounces = await window!
    .webContents.executeJavaScript(`(() => {
    const row = document.querySelector('[data-id="${pendingDownload.id}"].download');
    return document.activeElement === row && row.querySelector('button').hidden
      && document.getElementById('download-announcement').textContent.includes('已取消');
  })()`);
  page = "connection";
  sendState();
  await flushShell();
  result.connectionPanelMovesFocusToHeading =
    await window!.webContents.executeJavaScript(
      "document.activeElement.id === 'connection-title'",
    );
  await window!.webContents.executeJavaScript(
    "document.querySelector('#connection-panel [data-action=workspace]').focus()",
  );
  sendState();
  await flushShell();
  result.backgroundStateDoesNotStealPanelFocus =
    await window!.webContents.executeJavaScript(
      "document.activeElement.dataset.action === 'workspace'",
    );
  // Inject only the popup's close/selection response; run the actual menu dispatch.
  showWorkspace();
  await contents.executeJavaScript("document.getElementById('draft').focus()");
  const originalFocus = contents.focus.bind(contents);
  let remoteFocusCalls = 0;
  contents.focus = () => {
    remoteFocusCalls += 1;
    originalFocus();
  };
  try {
    await popupAppMenu("edit", { x: 160, y: 40 }, (_menu, close) => close());
    await flushShell();
    result.cancelledNativeMenuRestoresOriginWithoutRemoteFocus =
      remoteFocusCalls === 0 &&
      (await window!.webContents.executeJavaScript(
        "document.activeElement.dataset.id === 'edit'",
      ));
    await popupAppMenu("edit", { x: 160, y: 40 }, (menu, close) => {
      const select = menu.items.find((item) => item.label === "全选")!;
      select.click({} as Electron.KeyboardEvent, window!, contents);
      close();
    });
    for (let attempt = 0; attempt < 10; attempt++) {
      result.nativeEditMenuTargetsWorkspaceOnSelection =
        remoteFocusCalls === 1 &&
        (await contents.executeJavaScript(
          "(() => { const draft = document.getElementById('draft'); return draft.selectionStart === 0 && draft.selectionEnd === draft.value.length; })()",
        ));
      if (result.nativeEditMenuTargetsWorkspaceOnSelection) break;
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    await popupAppMenu("file", { x: 112, y: 40 }, (menu, close) => {
      const download = menu.items.find((item) => item.label === "下载")!;
      download.click({} as Electron.KeyboardEvent, window!, contents);
      close();
    });
    await flushShell();
    result.nativeMenuNavigationKeepsDestinationFocus =
      await window!.webContents.executeJavaScript(
        "document.activeElement.id === 'downloads-title'",
      );
  } finally {
    contents.focus = originalFocus;
  }
  const failingDownload: DownloadRecord = {
    id: randomUUID(),
    filename: "controlled-retry.txt",
    status: "progressing",
    received: 1,
    total: 100,
    item: {
      cancel() {
        throw new Error("Controlled download action failure");
      },
    } as unknown as DownloadItem,
  };
  downloads.set(failingDownload.id, failingDownload);
  sendState();
  await flushShell();
  await window!.webContents.executeJavaScript(
    `document.querySelector('[data-id="${failingDownload.id}"].download button').click()`,
  );
  await flushShell();
  result.actionFailureIsVisibleWithRecovery =
    view?.getVisible() === false &&
    (await window!.webContents.executeJavaScript(
      "!document.getElementById('action-error').hidden && !document.getElementById('connection-panel').hidden && document.getElementById('action-error-message').textContent.includes('操作未完成')",
    ));
  failingDownload.item = {
    cancel() {
      failingDownload.status = "cancelled";
      failingDownload.item = undefined;
    },
  } as unknown as DownloadItem;
  await window!.webContents.executeJavaScript(
    "document.getElementById('retry-action').click()",
  );
  await flushShell();
  result.actionRetryUsesSameItemAndClearsNotice =
    failingDownload.status === "cancelled" &&
    (await window!.webContents.executeJavaScript(
      "document.getElementById('action-error').hidden",
    ));
  downloads.delete(failingDownload.id);
  sendState();
  window!.webContents.send("desktop:state", { ...state(), platform: "darwin" });
  await flushShell();
  result.macRendererShortcutHintsMatchCommands =
    await window!.webContents.executeJavaScript(
      "document.getElementById('back').title.includes('⌘+[') && document.getElementById('forward').title.includes('⌘+]') && document.getElementById('downloads-button').title.includes('⌘+J') && document.querySelector('.toolbar [data-action=reload]').title.includes('⌘+R')",
    );
  sendState();
  console.log("desktop-smoke: recovery assertion");
  await loadWorkspace(`${config.origin}/unavailable`);
  result.networkFailureVisible =
    connection === "error" && view?.getVisible() === false;
  for (let attempt = 0; attempt < 20; attempt++) {
    result.errorPageRendered = await window!.webContents.executeJavaScript(
      "!document.getElementById('connection-state').hidden && document.getElementById('state-title').textContent === '暂时无法连接云端'",
    );
    if (result.errorPageRendered) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (process.env.CONUO_DESKTOP_SMOKE_SCREENSHOT) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    await writeFile(
      process.env.CONUO_DESKTOP_SMOKE_SCREENSHOT,
      (
        await window!.webContents.capturePage(undefined, { stayHidden: true })
      ).toPNG(),
    );
    const originalBounds = window!.getBounds();
    window!.setSize(880, 640);
    resizeView();
    await new Promise((resolve) => setTimeout(resolve, 200));
    result.narrowTitleBarFits = await window!.webContents
      .executeJavaScript(`(() => {
      const bar = document.querySelector('.toolbar').getBoundingClientRect();
      const menus = document.querySelector('.app-menu').getBoundingClientRect();
      const tools = document.querySelector('.utility-nav').getBoundingClientRect();
      const gap = document.querySelector('.title-drag-space').getBoundingClientRect();
      return tools.right <= bar.right && menus.right < tools.left && gap.width >= 56
        && document.documentElement.scrollWidth === innerWidth;
    })()`);
    result.titleBarColorMatches = await window!.webContents
      .executeJavaScript(`(() => {
      const bar = getComputedStyle(document.querySelector('.toolbar'));
      return bar.backgroundColor === 'rgb(247, 247, 248)'
        && getComputedStyle(document.body).backgroundColor === bar.backgroundColor;
    })()`);
    await writeFile(
      path.join(
        path.dirname(process.env.CONUO_DESKTOP_SMOKE_SCREENSHOT),
        "titlebar-narrow.png",
      ),
      (
        await window!.webContents.capturePage(undefined, { stayHidden: true })
      ).toPNG(),
    );
    window!.setBounds(originalBounds);
    resizeView();
  }
  await loadWorkspace();
  result.networkRecovery = connection === "ready";
  console.log("desktop-smoke: beforeunload assertion");
  await contents.executeJavaScript(
    "window.onbeforeunload = () => 'unsaved'; true",
    true,
  );
  const closePrevented = new Promise<void>((resolve) =>
    contents.once("will-prevent-unload", () => setImmediate(resolve)),
  );
  contents.close({ waitForBeforeUnload: true });
  await closePrevented;
  console.log("desktop-smoke: close protection confirmed");
  result.unsavedCloseProtected = !contents.isDestroyed();
  // Let Chromium acknowledge the cancelled close before testing a distinct reload.
  await new Promise((resolve) => setTimeout(resolve, 150));
  const oldUrl = contents.getURL();
  await loadWorkspace(`${config.origin}/cancelled-navigation`);
  result.unsavedReloadProtected =
    connection === "ready" && contents.getURL() === oldUrl;
  const originalInsertCSS = contents.insertCSS.bind(contents);
  let releaseSidebarStyle!: () => void;
  let signalStyleInserted!: () => void;
  const styleInserted = new Promise<void>((resolve) => {
    signalStyleInserted = resolve;
  });
  const styleReleased = new Promise<void>((resolve) => {
    releaseSidebarStyle = resolve;
  });
  contents.insertCSS = async (...args) => {
    const key = await originalInsertCSS(...args);
    signalStyleInserted();
    await styleReleased;
    return key;
  };
  try {
    const pendingSidebar = toggleSidebar();
    await styleInserted;
    await loadWorkspace(`${config.origin}/cancelled-sidebar-navigation`);
    releaseSidebarStyle();
    await pendingSidebar;
    const retainedSidebar = await readSidebar();
    result.sidebarToggleSurvivesCancelledNavigation =
      contents.getURL() === oldUrl &&
      retainedSidebar.visible === !sidebarHidden &&
      retainedSidebar.draft === beforeSidebar.draft;
  } finally {
    releaseSidebarStyle();
    contents.insertCSS = originalInsertCSS;
  }
  await contents.executeJavaScript("window.onbeforeunload = null; true");
  console.log("desktop-smoke: HTTP error assertion");
  await loadWorkspace(`${config.origin}/server-error`);
  result.httpErrorProtected =
    connection === "error" && view?.getVisible() === false;
  await loadWorkspace();
  console.log("desktop-smoke: close with active download assertion");
  const closeDownload = new Promise<DownloadRecord>((resolve) => {
    contents.session.once("will-download", () =>
      resolve([...downloads.values()].at(-1)!),
    );
  });
  await contents.executeJavaScript(
    "(() => { const a = document.createElement('a'); a.href = '/slow-download'; a.download = 'conuo-close-test.bin'; document.body.append(a); a.click(); a.remove(); })()",
    true,
  );
  const closeRecord = await closeDownload;
  const originalMessageBox = dialog.showMessageBox;
  let dialogResponse = 0;
  let confirmationCount = 0;
  dialog.showMessageBox = async () => {
    confirmationCount++;
    return { response: dialogResponse, checkboxChecked: false };
  };
  const closingWindow = window!;
  try {
    closingWindow.close();
    await new Promise((resolve) => setTimeout(resolve, 150));
    result.closeWithContinueKeepsDownload =
      !closingWindow.isDestroyed() &&
      !!closeRecord.item &&
      closeRecord.status === "progressing";
    dialogResponse = 1;
    const closed = new Promise<boolean>((resolve) => {
      const deadline = setTimeout(() => resolve(false), 1500);
      closingWindow.once("closed", () => {
        clearTimeout(deadline);
        resolve(true);
      });
    });
    closingWindow.close();
    result.closeWithCancelDestroysWindow = await closed;
    result.closeWithCancelStopsDownload =
      closeRecord.status === "cancelled" && !closeRecord.item;
    result.closeConfirmationRunsOncePerChoice = confirmationCount === 2;
  } finally {
    dialog.showMessageBox = originalMessageBox;
  }
  if (process.env.CONUO_DESKTOP_SMOKE_RESULT)
    await writeFile(
      process.env.CONUO_DESKTOP_SMOKE_RESULT,
      JSON.stringify(result),
    );
  app.exit(Object.values(result).every(Boolean) ? 0 : 1);
}

app.on(
  "certificate-error",
  (event, _contents, _url, _error, _certificate, callback) => {
    event.preventDefault();
    callback(false);
  },
);
if (!smokeMode && !app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => {
    if (window) {
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
    }
  });
  app
    .whenReady()
    .then(async () => {
      await createWindow();
      if (smokeMode) await runSmoke();
    })
    .catch((error: unknown) => {
      console.error(
        "Conuo desktop could not start. Verify desktop configuration and packaged assets.",
      );
      if (smokeMode)
        console.error(
          "Desktop smoke error:",
          error instanceof Error ? error.message : "Unknown failure",
        );
      app.exit(1);
    });
  app.on("activate", () => {
    if (!window) void createWindow().catch(() => app.exit(1));
  });
  app.on("window-all-closed", () => {
    if (!smokeMode && process.platform !== "darwin") app.quit();
  });
}
