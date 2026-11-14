// Connection from the content script to the background service worker.
//
// The service worker may be stopped by the browser at any time. The port then disconnects;
// we reconnect on the next message and tell the owner, which re-sends whatever is still pending.
import { PORT_NAME, type ClientMessage, type ServerMessage } from '../shared/messages.ts';

export class BackgroundClient {
  private port: chrome.runtime.Port | null = null;
  private alive = true;
  private everConnected = false;

  constructor(
    private readonly onMessage: (message: ServerMessage) => void,
    private readonly onReconnect: () => void,
  ) {}

  private connect(): chrome.runtime.Port | null {
    if (!this.alive) return null;
    try {
      const port = chrome.runtime.connect({ name: PORT_NAME });
      port.onMessage.addListener((message: ServerMessage) => this.onMessage(message));
      port.onDisconnect.addListener(() => {
        void chrome.runtime.lastError; // read to silence "unchecked lastError"
        if (this.port === port) this.port = null;
      });
      // A reconnect means the background lost its queue; the owner re-sends after the current call stack.
      if (this.everConnected) queueMicrotask(() => this.onReconnect());
      this.everConnected = true;
      return port;
    } catch {
      // The extension was reloaded or removed: this content script is orphaned.
      this.alive = false;
      return null;
    }
  }

  /** Sends a message; returns false when the extension is gone. */
  send(message: ClientMessage): boolean {
    for (let attempt = 0; attempt < 2; attempt++) {
      this.port ??= this.connect();
      if (!this.port) return false;
      try {
        this.port.postMessage(message);
        return true;
      } catch {
        this.port = null; // disconnected between the check and the send; try once more
      }
    }
    return false;
  }

  get orphaned(): boolean {
    return !this.alive;
  }

  close(): void {
    this.alive = false;
    this.port?.disconnect();
    this.port = null;
  }
}
