import { app, BrowserWindow, Menu, Tray, nativeImage, ipcMain } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { io, Socket } from "socket.io-client";

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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rendererDist = path.resolve(__dirname, "../dist");
const preloadPath = path.resolve(__dirname, "preload.js");

let settingsWindow: BrowserWindow | null = null;
let dropWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let socket: Socket | null = null;
let quitting = false;
let volume = 0.8;

const status: ConnectionStatus = {
  connected: false,
  connecting: false,
  serverUrl: "",
  lastError: null
};

const createSettingsWindow = () => {
  settingsWindow = new BrowserWindow({
    width: 360,
    height: 320,
    resizable: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    void settingsWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    void settingsWindow.loadFile(path.join(rendererDist, "index.html"));
  }

  settingsWindow.on("close", (event) => {
    if (!quitting) {
      event.preventDefault();
      settingsWindow?.hide();
    }
  });
};

const createDropWindow = () => {
  dropWindow = new BrowserWindow({
    show: false,
    frame: false,
    transparent: true,
    fullscreen: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false,
    hasShadow: false,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  dropWindow.setAlwaysOnTop(true, "screen-saver");
  dropWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  dropWindow.setIgnoreMouseEvents(true, { forward: true });

  if (process.env.VITE_DEV_SERVER_URL) {
    void dropWindow.loadURL(`${process.env.VITE_DEV_SERVER_URL.replace(/\/$/, "")}/overlay.html`);
  } else {
    void dropWindow.loadFile(path.join(rendererDist, "overlay.html"));
  }
};

const broadcastStatus = () => {
  settingsWindow?.webContents.send("connection:status", status);
};

const connectSocket = (serverUrl: string): ConnectionStatus => {
  if (socket) {
    socket.removeAllListeners();
    socket.disconnect();
  }

  status.connecting = true;
  status.connected = false;
  status.serverUrl = serverUrl;
  status.lastError = null;
  broadcastStatus();

  socket = io(serverUrl, {
    transports: ["websocket"],
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 8000,
    timeout: 8000
  });

  socket.on("connect", () => {
    status.connected = true;
    status.connecting = false;
    status.lastError = null;
    broadcastStatus();
  });

  socket.on("disconnect", (reason) => {
    status.connected = false;
    status.connecting = false;
    status.lastError = `Disconnected (${reason})`;
    broadcastStatus();
  });

  socket.on("connect_error", (error) => {
    status.connected = false;
    status.connecting = false;
    status.lastError = error.message;
    broadcastStatus();
  });

  socket.on("meme:drop", (payload: DropPayload) => {
    if (!dropWindow) {
      return;
    }

    dropWindow.showInactive();
    dropWindow.webContents.send("drop:show", payload);
    dropWindow.webContents.send("overlay:volume", volume);
  });

  return { ...status };
};

const disconnectSocket = (): ConnectionStatus => {
  if (socket) {
    socket.removeAllListeners();
    socket.disconnect();
    socket = null;
  }

  status.connected = false;
  status.connecting = false;
  status.lastError = null;
  broadcastStatus();

  return { ...status };
};

const createTray = () => {
  const icon = nativeImage.createFromDataURL(
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAA4AAAAOCAQAAAC1QeVaAAAALUlEQVR42mNgoBAwUqifgYGB4T8DA8M/AxMDEwMDAxMTC4iJgYEBiYGBgQEAAPfTA0fUtvwQAAAAAElFTkSuQmCC"
  );

  tray = new Tray(icon);
  tray.setToolTip("MemeDrip");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: "Open",
        click: () => settingsWindow?.show()
      },
      {
        label: "Quit",
        click: () => {
          quitting = true;
          app.quit();
        }
      }
    ])
  );

  tray.on("click", () => settingsWindow?.show());
};

app.whenReady().then(() => {
  createSettingsWindow();
  createDropWindow();
  createTray();
  broadcastStatus();
});

ipcMain.handle("socket:connect", (_event, serverUrl: string) => {
  return connectSocket(serverUrl);
});

ipcMain.handle("socket:disconnect", () => {
  return disconnectSocket();
});

ipcMain.on("settings:volume", (_event, nextVolume: number) => {
  volume = Math.max(0, Math.min(1, nextVolume));
  dropWindow?.webContents.send("overlay:volume", volume);
});

app.on("before-quit", () => {
  quitting = true;
  disconnectSocket();
});
