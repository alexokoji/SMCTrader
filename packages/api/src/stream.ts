import type { Server } from "node:http";
import { WebSocket, WebSocketServer, type WebSocket as WsClient } from "ws";

export type StreamEvent =
  | { type: "state"; payload: unknown }
  | {
      type: "activity";
      event: { timestamp: number; kind: string; symbol: string; detail: string; level: string };
    }
  | { type: "system"; level: "warning" | "error" | "info"; detail: string };

interface Client {
  ws: WsClient;
  alive: boolean;
}

const HEARTBEAT_MS = 30_000;

/**
 * WebSocket event stream for the real-time dashboard (section 71).
 * Broadcasts state snapshots, individual activity events and system
 * warnings/errors. Each connected client first receives a full snapshot.
 */
export class ApiEventStream {
  readonly url = "/ws";
  private wss?: WebSocketServer;
  private clients: Set<Client> = new Set();
  private heartbeat?: ReturnType<typeof setInterval>;
  /** Called on every new connection with a function used to push the initial state. */
  onClientConnected?: (send: (event: StreamEvent) => void) => void;

  /** Attach to the HTTP server upgrade (must be called before listen()). */
  attach(server: Server): void {
    const wss = new WebSocketServer({ noServer: true });
    this.wss = wss;
    server.on("upgrade", (req, socket, head) => {
      const path = new URL(req.url ?? "/", "http://localhost").pathname;
      if (path === this.url) {
        wss.handleUpgrade(req, socket, head, (ws) => this.addClient(ws));
      } else {
        socket.destroy();
      }
    });
    this.heartbeat = setInterval(() => this.tickHeartbeat(), HEARTBEAT_MS);
    this.heartbeat.unref?.();
  }

  private addClient(ws: WsClient): void {
    const client: Client = { ws, alive: true };
    this.clients.add(client);
    const send = (event: StreamEvent) => this.send(client, event);
    this.onClientConnected?.(send);
    ws.on("pong", () => {
      client.alive = true;
    });
    ws.on("close", () => this.clients.delete(client));
    ws.on("error", () => this.clients.delete(client));
  }

  broadcast(event: StreamEvent): void {
    const payload = JSON.stringify(event);
    for (const client of this.clients) {
      if (client.ws.readyState === WebSocket.OPEN) {
        this.send(client, payload);
      }
    }
  }

  broadcastActivity(
    event: { timestamp: number; kind: string; symbol: string; detail: string; level: string },
  ): void {
    this.broadcast({ type: "activity", event });
  }

  broadcastState(payload: unknown): void {
    this.broadcast({ type: "state", payload });
  }

  system(level: "warning" | "error" | "info", detail: string): void {
    this.broadcast({ type: "system", level, detail });
  }

  get clientCount(): number {
    return this.clients.size;
  }

  private send(client: Client, payload: string | StreamEvent): void {
    if (client.ws.readyState !== WebSocket.OPEN) return;
    const data = typeof payload === "string" ? payload : JSON.stringify(payload);
    client.ws.send(data);
  }

  private tickHeartbeat(): void {
    for (const client of this.clients) {
      if (!client.alive) {
        client.ws.terminate();
        this.clients.delete(client);
        continue;
      }
      client.alive = false;
      client.ws.ping();
    }
  }

  stop(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const client of this.clients) {
      try {
        client.ws.terminate();
      } catch {
        /* ignore */
      }
    }
    this.clients.clear();
    this.wss?.close();
  }
}