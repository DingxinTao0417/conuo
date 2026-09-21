import { contextBridge, ipcRenderer } from "electron";

// This preload is attached only to the packaged local shell, never to the website.
contextBridge.exposeInMainWorld(
  "conuoDesktop",
  Object.freeze({
    action: (action: string, id?: string, anchor?: { x: number; y: number }) =>
      ipcRenderer.invoke("desktop:action", { action, id, anchor }),
    subscribe: (callback: (state: unknown) => void) => {
      const listener = (_event: unknown, state: unknown) => callback(state);
      ipcRenderer.on("desktop:state", listener);
      void ipcRenderer.invoke("desktop:state").then(callback);
      return () => ipcRenderer.removeListener("desktop:state", listener);
    },
  }),
);
