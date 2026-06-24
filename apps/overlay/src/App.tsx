/**
 * App.tsx — Root component
 * Wires the WebSocket connection hook to the overlay renderer.
 */

import { OverlayEngine } from "./OverlayEngine";
import { useRelayConnection } from "./useWebSocket";

export default function App() {
  // Establish the resilient WebSocket connection on mount.
  // Incoming payloads are fed directly into the queue store.
  useRelayConnection();

  return (
    <div className="w-screen h-screen bg-transparent overflow-hidden">
      <OverlayEngine />
    </div>
  );
}
