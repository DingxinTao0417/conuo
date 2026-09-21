/* Local renderer: no Node.js access and no remote content in this document. */
const byId = (id) => document.getElementById(id);
const environmentLabel = {
  staging: "预发布环境",
  development: "本地开发",
  production: "正式环境",
};
const stateLabel = {
  ready: "云端工作区",
  loading: "正在连接",
  error: "连接不可用",
};
const downloadLabels = {
  progressing: "正在下载",
  completed: "已保存",
  cancelled: "已取消",
  interrupted: "下载中断，请在资料页重新下载",
};
const bytes = (size) =>
  size < 1024 * 1024
    ? `${Math.ceil(size / 1024)} KB`
    : `${(size / 1024 / 1024).toFixed(1)} MB`;

let previousPage;
let menuFocusRequest = 0;
let failedAction = null;
const downloadRows = new Map();
const pendingActions = new Set();
const text = (element, value) => {
  if (element.textContent !== value) element.textContent = value;
};

function clearActionError() {
  const hadFocus = byId("action-error").contains(document.activeElement);
  failedAction = null;
  byId("action-error").hidden = true;
  if (hadFocus) {
    document.querySelector("main section:not([hidden]) h1")?.focus();
  }
}

function renderDownloads(items) {
  const list = byId("download-list");
  const currentIds = new Set(items.map((item) => item.id));
  const announcements = [];
  for (const [id, entry] of downloadRows) {
    if (!currentIds.has(id)) {
      if (entry.row.contains(document.activeElement))
        byId("downloads-title").focus();
      entry.row.remove();
      downloadRows.delete(id);
    }
  }
  const empty = list.querySelector(".empty");
  if (items.length) empty?.remove();
  else if (!empty) {
    const message = document.createElement("div");
    message.className = "empty";
    message.innerHTML =
      '<span class="empty-symbol" aria-hidden="true">↓</span><strong>还没有下载文件</strong><p>在资料阅读器下载原文件，或从账号设置导出备份。<br>保存后，可以在这里查看结果和打开所在文件夹。</p>';
    list.append(message);
  }
  items.toReversed().forEach((item, index) => {
    let entry = downloadRows.get(item.id);
    if (!entry) {
      const row = document.createElement("div");
      row.className = "download";
      row.dataset.id = item.id;
      row.setAttribute("role", "listitem");
      row.tabIndex = -1;
      row.innerHTML =
        '<span class="download-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8zM14 3v5h5M9 13h6M9 17h4"/></svg></span><div class="download-info"><div class="download-name"></div><div class="download-meta"><span class="download-status"></span><span class="download-size"></span></div><progress class="download-progress"></progress></div><button type="button"></button>';
      entry = {
        row,
        name: row.querySelector(".download-name"),
        status: row.querySelector(".download-status"),
        size: row.querySelector(".download-size"),
        progress: row.querySelector("progress"),
        button: row.querySelector("button"),
        previousStatus: item.status,
      };
      downloadRows.set(item.id, entry);
    }
    // Moving an existing focused row through append() also loses focus in Chromium.
    // Only insert new or genuinely reordered rows; progress updates keep every node.
    if (list.children[index] !== entry.row)
      list.insertBefore(entry.row, list.children[index] || null);
    text(entry.name, item.filename);
    text(entry.status, downloadLabels[item.status] || "处理中");
    text(
      entry.size,
      `${bytes(item.received)}${item.total ? ` / ${bytes(item.total)}` : ""}`,
    );
    entry.row.dataset.status = item.status;
    entry.row.setAttribute(
      "aria-label",
      `${item.filename}，${downloadLabels[item.status] || "处理中"}`,
    );
    entry.progress.hidden = !item.cancellable;
    entry.progress.setAttribute("aria-label", `${item.filename} 下载进度`);
    if (item.total > 0) {
      entry.progress.max = item.total;
      entry.progress.value = Math.min(Math.max(0, item.received), item.total);
      entry.progress.setAttribute(
        "aria-valuetext",
        `${Math.round((item.received / item.total) * 100)}%，${bytes(item.received)} / ${bytes(item.total)}`,
      );
    } else {
      entry.progress.removeAttribute("value");
      entry.progress.removeAttribute("aria-valuetext");
    }
    const actionable = item.cancellable || item.status === "completed";
    if (!actionable && document.activeElement === entry.button)
      entry.row.focus();
    entry.button.hidden = !actionable;
    entry.button.dataset.action =
      item.status === "completed" ? "reveal-download" : "cancel-download";
    entry.button.dataset.id = item.id;
    text(
      entry.button,
      item.status === "completed" ? "在文件夹中显示" : "取消下载",
    );
    entry.button.setAttribute(
      "aria-label",
      `${entry.button.textContent}：${item.filename}`,
    );
    if (
      entry.previousStatus !== item.status &&
      ["completed", "cancelled", "interrupted"].includes(item.status)
    ) {
      announcements.push(`${item.filename}：${downloadLabels[item.status]}`);
    }
    entry.previousStatus = item.status;
  });
  const active = items.filter((item) => item.cancellable).length;
  text(
    byId("download-summary"),
    items.length
      ? `${items.length} 个文件${active ? ` · ${active} 项进行中` : " · 本次下载记录"}`
      : "",
  );
  if (announcements.length)
    text(byId("download-announcement"), announcements.join("；"));
}

function render(state) {
  document.body.dataset.platform = state.platform;
  document.body.dataset.fullscreen = String(state.fullscreen);
  document.documentElement.style.setProperty(
    "--titlebar-height",
    `${state.titleBarHeight}px`,
  );
  document.documentElement.style.setProperty(
    "--titlebar-color",
    state.titleBarColor,
  );
  const workspace = state.page === "workspace";
  byId("connection-state").hidden = !workspace || state.connection === "ready";
  byId("connection-panel").hidden = state.page !== "connection";
  byId("downloads-panel").hidden = state.page !== "downloads";
  byId("environment").textContent =
    state.environment === "staging"
      ? "预发布"
      : state.environment === "development"
        ? "开发"
        : "";
  text(
    byId("connection-label").querySelector(".sr-only"),
    stateLabel[state.connection],
  );
  byId("connection-label").className = `connection-label ${state.connection}`;
  byId("connection-button").title = stateLabel[state.connection];
  byId("connection-button").setAttribute(
    "aria-label",
    stateLabel[state.connection],
  );
  byId("back").disabled = !state.canBack;
  byId("forward").disabled = !state.canForward;
  const mac = state.platform === "darwin";
  byId("back").title = `后退 · ${mac ? "⌘+[" : "Alt+←"}`;
  byId("forward").title = `前进 · ${mac ? "⌘+]" : "Alt+→"}`;
  document.querySelector('.toolbar [data-action="reload"]').title =
    `重新加载 · ${mac ? "⌘+R" : "Ctrl+R"}`;
  byId("downloads-button").title = `下载 · ${mac ? "⌘+J" : "Ctrl+J"}`;
  const sidebarLabel = state.sidebarHidden ? "显示侧边栏" : "隐藏侧边栏";
  const sidebarShortcut = state.platform === "darwin" ? "⌘+\\" : "Ctrl+\\";
  byId("sidebar-toggle").disabled = !state.canToggleSidebar;
  byId("sidebar-toggle").setAttribute("aria-label", sidebarLabel);
  byId("sidebar-toggle").setAttribute(
    "aria-expanded",
    String(!state.sidebarHidden),
  );
  byId("sidebar-toggle").title = `${sidebarLabel} · ${sidebarShortcut}`;
  byId("state-title").textContent =
    state.connection === "error" ? "暂时无法连接云端" : "正在连接 Conuo";
  byId("state-description").textContent =
    state.connection === "error"
      ? "请检查网络连接，然后重试。重新连接不会删除你的云端资料。"
      : "正在载入云端工作区，请稍候。";
  byId("recovery-actions").hidden = state.connection !== "error";
  byId("detail-environment").textContent = environmentLabel[state.environment];
  byId("detail-origin").textContent = state.origin;
  byId("detail-version").textContent = `${state.version} · Preview`;
  byId("detail-status").textContent = stateLabel[state.connection];
  const active = state.downloads.filter(
    (item) => item.status === "progressing",
  ).length;
  byId("download-count").hidden = !active;
  byId("download-count").textContent = active > 9 ? "9+" : String(active);
  byId("downloads-button").setAttribute(
    "aria-label",
    active ? `下载 · ${active} 项进行中` : "下载",
  );
  renderDownloads(state.downloads);
  const localPage = state.page === "workspace" ? state.connection : state.page;
  if (localPage !== previousPage) {
    const heading =
      state.page === "downloads"
        ? "downloads-title"
        : state.page === "connection"
          ? "connection-title"
          : state.connection !== "ready"
            ? "state-title"
            : null;
    if (heading) byId(heading).focus({ preventScroll: true });
    previousPage = localPage;
  }
  // Main process requests this only after the native popup has closed without a command.
  if (state.menuFocusRequest && state.menuFocusRequest !== menuFocusRequest) {
    menuFocusRequest = state.menuFocusRequest;
    const button = document.querySelector(
      `.app-menu [data-id="${state.menuFocusId}"]`,
    );
    if (button && !mac) {
      document
        .querySelectorAll('.app-menu [role="menuitem"]')
        .forEach((item) => {
          item.tabIndex = item === button ? 0 : -1;
        });
      button.focus();
    }
  }
}

async function performAction(target) {
  const action = target.dataset.action;
  if (!action || target.disabled || pendingActions.has(target)) return;
  const isMenu = action === "menu";
  const rect = target.getBoundingClientRect();
  pendingActions.add(target);
  if (isMenu) {
    target.setAttribute("aria-expanded", "true");
    document
      .querySelectorAll('.app-menu [role="menuitem"]')
      .forEach((button) => {
        button.tabIndex = button === target ? 0 : -1;
      });
  }
  try {
    await window.conuoDesktop.action(
      action,
      target.dataset.id,
      isMenu
        ? {
            x: Math.round(rect.left),
            y: Math.min(40, Math.round(rect.bottom + 2)),
          }
        : undefined,
    );
    if (failedAction?.target === target && failedAction.action === action) {
      clearActionError();
    }
    return true;
  } catch {
    failedAction = { target, action, id: target.dataset.id };
    byId("action-error").hidden = false;
    const retrySafe = ![
      "toggle-sidebar",
      "reload",
      "home",
      "back",
      "forward",
    ].includes(action);
    text(
      byId("action-error-message"),
      retrySafe
        ? "操作未完成。请重试，或返回工作区继续学习。"
        : "操作结果暂时无法确认。请返回工作区检查当前状态，再决定是否重试。",
    );
    byId("retry-action").textContent = retrySafe ? "重试此操作" : "返回工作区";
    byId("retry-action").dataset.retrySafe = String(retrySafe);
    return false;
  } finally {
    pendingActions.delete(target);
    if (isMenu) target.setAttribute("aria-expanded", "false");
  }
}

document.addEventListener("click", (event) => {
  const target =
    event.target instanceof Element
      ? event.target.closest("[data-action]")
      : null;
  if (!target) return;
  event.preventDefault();
  void performAction(target);
});
byId("retry-action").addEventListener("click", async () => {
  if (!failedAction) return;
  const target = failedAction.target;
  if (
    byId("retry-action").dataset.retrySafe === "true" &&
    target.isConnected &&
    !target.hidden &&
    target.dataset.action === failedAction.action &&
    target.dataset.id === failedAction.id
  )
    await performAction(target);
  else if (
    await performAction(document.querySelector('[data-action="workspace"]'))
  ) {
    clearActionError();
  }
});
byId("dismiss-error").addEventListener("click", () => {
  const target = failedAction?.target;
  failedAction = null;
  byId("action-error").hidden = true;
  if (target?.isConnected && target.getClientRects().length && !target.disabled)
    target.focus();
  else byId("connection-button").focus();
});
document.querySelector(".app-menu").addEventListener("keydown", (event) => {
  const buttons = [...document.querySelectorAll('.app-menu [role="menuitem"]')];
  const index = buttons.indexOf(event.target);
  if (index < 0) return;
  if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
    event.preventDefault();
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? buttons.length - 1
          : (index + (event.key === "ArrowRight" ? 1 : -1) + buttons.length) %
            buttons.length;
    buttons.forEach((button, i) => (button.tabIndex = i === next ? 0 : -1));
    buttons[next].focus();
  } else if (event.key === "ArrowDown") {
    event.preventDefault();
    buttons[index].click();
  }
});
window.conuoDesktop.subscribe(render);
