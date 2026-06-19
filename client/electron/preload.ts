import { contextBridge, ipcRenderer } from "electron";

interface DropPayload {
  id: string;
  kind: "image" | "video" | "gif";
  url: string;
  durationMs: number;
}

interface ConnectionStatus {
  connected: boolean;
  connecting: boolean;
  serverUrl: string;
  lastError: string | null;
}

contextBridge.exposeInMainWorld("electronAPI", {
  connect: (url: string) => ipcRenderer.invoke("socket:connect", url),
  disconnect: () => ipcRenderer.invoke("socket:disconnect"),
  onStatus: (callback: (status: ConnectionStatus) => void) => {
    const listener = (_event: unknown, status: ConnectionStatus) => callback(status);
    ipcRenderer.on("connection:status", listener);

    return () => {
      ipcRenderer.removeListener("connection:status", listener);
    };
  },
  setVolume: (volume: number) => ipcRenderer.send("settings:volume", volume),
  onDrop: (callback: (drop: DropPayload) => void) => {
    const listener = (_event: unknown, payload: DropPayload) => callback(payload);
    ipcRenderer.on("drop:show", listener);

    return () => {
      ipcRenderer.removeListener("drop:show", listener);
    };
  },
  onVolume: (callback: (volume: number) => void) => {
    const listener = (_event: unknown, volume: number) => callback(volume);
    ipcRenderer.on("overlay:volume", listener);

    return () => {
      ipcRenderer.removeListener("overlay:volume", listener);
    };
  }
});
