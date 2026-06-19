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

interface ElectronAPI {
  connect: (url: string) => Promise<ConnectionStatus>;
  disconnect: () => Promise<ConnectionStatus>;
  onStatus: (callback: (status: ConnectionStatus) => void) => () => void;
  setVolume: (volume: number) => void;
  onDrop: (callback: (payload: DropPayload) => void) => () => void;
  onVolume: (callback: (volume: number) => void) => () => void;
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}

export {};
