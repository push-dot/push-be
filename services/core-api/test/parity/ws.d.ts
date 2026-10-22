declare module "ws" {
  export class WebSocket {
    static readonly OPEN: number;
    readonly readyState: number;
    send(data: Uint8Array): void;
    close(): void;
    on(event: "message", listener: (data: Uint8Array) => void): this;
    on(event: "close", listener: () => void): this;
  }
  export class WebSocketServer {
    constructor(options: { port: number });
    on(event: "connection", listener: (socket: WebSocket) => void): this;
    on(event: "listening", listener: () => void): this;
    address(): unknown;
    close(callback: () => void): void;
  }
}
