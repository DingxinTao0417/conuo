// A fixed presentation adapter for the deployed Web workspace. No page code or
// arbitrary CSS is accepted over IPC; the remote renderer still has no preload.
export function workspaceSidebarCSS(hidden: boolean): string {
  return `
    .app-shell > button.sidebar-scrim { display: none !important; }
    .app-shell > main.app-main > .topbar > button.mobile-menu { display: none !important; }
    .app-shell > aside.sidebar {
      display: ${hidden ? "none" : "flex"} !important;
    }
    @media (max-width: 620px) {
      .app-shell > aside.sidebar {
        position: relative !important;
        visibility: visible !important;
        transform: none !important;
        transition: none !important;
        flex-basis: 224px !important;
        max-width: 60vw !important;
      }
    }
  `;
}
