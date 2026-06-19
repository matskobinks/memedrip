import { useEffect, useMemo, useState } from "react";

const initialStatus: ConnectionStatus = {
  connected: false,
  connecting: false,
  serverUrl: "",
  lastError: null
};

export const App = () => {
  const [serverUrl, setServerUrl] = useState("http://localhost:3000");
  const [status, setStatus] = useState<ConnectionStatus>(initialStatus);
  const [volume, setVolume] = useState(80);

  useEffect(() => {
    return window.electronAPI.onStatus((nextStatus) => {
      setStatus(nextStatus);
      if (nextStatus.serverUrl) {
        setServerUrl(nextStatus.serverUrl);
      }
    });
  }, []);

  useEffect(() => {
    window.electronAPI.setVolume(volume / 100);
  }, [volume]);

  const statusLabel = useMemo(() => {
    if (status.connected) {
      return "Connecté";
    }

    if (status.connecting) {
      return "Connexion…";
    }

    return "Déconnecté";
  }, [status.connected, status.connecting]);

  const toggleConnection = async () => {
    if (status.connected || status.connecting) {
      await window.electronAPI.disconnect();
      return;
    }

    await window.electronAPI.connect(serverUrl.trim());
  };

  return (
    <main className="panel">
      <h1>MemeDrip</h1>
      <label className="field">
        <span>Serveur WebSocket</span>
        <input
          value={serverUrl}
          onChange={(event) => setServerUrl(event.target.value)}
          placeholder="https://mon-serveur.example"
        />
      </label>

      <div className="status-row">
        <span className={`dot ${status.connected ? "ok" : "ko"}`} />
        <span>{statusLabel}</span>
      </div>

      <label className="field">
        <span>Volume ({volume}%)</span>
        <input type="range" min={0} max={100} value={volume} onChange={(event) => setVolume(Number(event.target.value))} />
      </label>

      {status.lastError ? <p className="error">{status.lastError}</p> : null}

      <button type="button" onClick={toggleConnection}>
        {status.connected || status.connecting ? "Se déconnecter" : "Se connecter"}
      </button>
    </main>
  );
};
