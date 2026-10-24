import { createServer } from "node:net";

const PRESERVED_ERROR_CODES = new Set([
  "AUTOMATION_INVALID", "AUTOMATION_CONFIG", "AUTOMATION_UNCONFIGURED", "AUTOMATION_RESPONSE",
  "AUTOMATION_CANCELLED", "AUTOMATION_TIMEOUT", "AUTOMATION_NETWORK", "AUTOMATION_RATE_LIMIT",
  "AUTOMATION_PROVIDER", "AUTOMATION_BUSY", "AUTOMATION_SCOPE", "AUTOMATION_DISABLED",
  "AUTOMATION_CONSENT", "AUTOMATION_BUDGET",
  "EGO_ACTION_CONTEXT_INVALID",
  "EGO_ACTION_EXPIRED",
  "EGO_ACTION_RESULT_UNKNOWN",
  "EGO_ACTION_SCOPE_MISMATCH",
  "EGO_FRAME_UNAVAILABLE",
  "EGO_REFERENCE_DETACHED",
  "EGO_REFERENCE_STALE",
]);

export class DesktopRpcServer {
  constructor(dispatch, options = {}) {
    this.dispatch = dispatch;
    this.onDisconnect = options.onDisconnect || (() => {});
    this.diagnose = options.diagnose || (() => {});
    this.sockets = new Set();
    this.server = createServer((socket) => this.#accept(socket));
  }

  listen(pipeName) {
    return new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(pipeName, () => {
        this.server.off("error", reject);
        resolve();
      });
    });
  }

  close() {
    return new Promise((resolve, reject) => {
      for (const socket of this.sockets) socket.destroy();
      this.server.close((error) => error ? reject(error) : resolve());
    });
  }

  notify(method, params) {
    const message = `${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`;
    for (const socket of this.sockets) {
      if (!socket.destroyed) socket.write(message);
    }
  }

  #accept(socket) {
    this.sockets.add(socket);
    socket.on("error", () => socket.destroy());
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk;
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.trim()) void this.#handle(socket, line);
      }
    });
    socket.once("close", () => {
      this.sockets.delete(socket);
      this.onDisconnect();
    });
  }

  async #handle(socket, line) {
    let request;
    let input;
    const trace = (phase) => {
      if (!input) return;
      try { this.diagnose({ at: Date.now(), phase, rpcId: request.id, cdpId: input.id, type: input.params?.type }); } catch {}
    };
    try {
      request = JSON.parse(line);
      if (request.method === "cdp.send" && typeof request.params?.payload === "string") {
        try {
          const parsed = JSON.parse(request.params.payload);
          if (parsed.method === "Input.dispatchMouseEvent") input = parsed;
        } catch {}
      }
      trace("receive");
      const result = await this.dispatch(request.method, request.params || {});
      trace("dispatch_complete");
      if (!socket.destroyed) socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
      trace("reply_written");
    } catch (error) {
      trace("dispatch_error");
      if (!socket.destroyed) socket.write(`${JSON.stringify({
        jsonrpc: "2.0",
        id: request?.id || "invalid-request",
        error: {
          code: PRESERVED_ERROR_CODES.has(error?.code)
            ? error.code
            : PRESERVED_ERROR_CODES.has(error?.error_code)
              ? error.error_code
              : "EGO_DESKTOP_OPERATION_FAILED",
          message: error instanceof Error ? error.message : String(error),
          ...(error?.data && typeof error.data === "object" ? { data: error.data } : {}),
        },
      })}\n`);
    }
  }
}
