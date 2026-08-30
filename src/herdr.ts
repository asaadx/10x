/**
 * Herdr socket client.
 *
 * Transport facts that drive this design (memory/herdr-omp-lifecycle.md memory/socket.md):
 *  - newline-delimited JSON over a unix socket, NOT WebSocket
 *  - the server closes the connection after every response, so one connection per request
 *  - `events.subscribe` is the sole exception: its connection stays open and streams
 *  - `params` is mandatory even when empty
 *  - works fine outside a Herdr pane; HERDR_ENV is a policy gate, not a technical one
 */
import { connect, type Socket } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

export const SOCKET_PATH =
  process.env.HERDR_SOCKET_PATH ?? join(homedir(), ".config", "herdr", "herdr.sock");

export class HerdrError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "HerdrError";
    this.code = code;
  }
}

type ErrorFrame = { code: string; message: string };

function readErrorFrame(frame: object): ErrorFrame | undefined {
  if (!("error" in frame)) return undefined;
  const err = frame.error;
  if (typeof err !== "object" || err === null) return { code: "bad_error", message: "malformed" };
  const code = "code" in err && typeof err.code === "string" ? err.code : "unknown_error";
  const message = "message" in err && typeof err.message === "string" ? err.message : "";
  return { code, message };
}

/**
 * One request, one connection. Resolves with the `result` payload or throws HerdrError.
 * The caller declares the expected result shape; Herdr's schema is the contract.
 */
export function request<T>(
  method: string,
  params: Record<string, unknown> = {},
  timeoutMs = 120_000,
): Promise<T> {
  const { promise, resolve, reject } = Promise.withResolvers<T>();
  const sock = connect(SOCKET_PATH);
  let buf = "";
  let settled = false;

  const finish = (fn: () => void) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    sock.destroy();
    fn();
  };

  const timer = setTimeout(
    () => finish(() => reject(new HerdrError("timeout", `${method} exceeded ${timeoutMs}ms`))),
    timeoutMs,
  );

  sock.on("connect", () => {
    sock.write(JSON.stringify({ id: `10x:${method}`, method, params }) + "\n");
  });

  sock.on("data", (chunk) => {
    buf += chunk.toString();
    const nl = buf.indexOf("\n");
    if (nl === -1) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(buf.slice(0, nl));
    } catch (err) {
      return finish(() => reject(new HerdrError("bad_json", String(err))));
    }
    if (typeof parsed !== "object" || parsed === null) {
      return finish(() => reject(new HerdrError("bad_frame", "response was not an object")));
    }

    const failure = readErrorFrame(parsed);
    if (failure) return finish(() => reject(new HerdrError(failure.code, failure.message)));

    const result = "result" in parsed ? parsed.result : undefined;
    finish(() => resolve(result as T));
  });

  sock.on("error", (err) => finish(() => reject(new HerdrError("socket_error", err.message))));
  sock.on("close", () =>
    finish(() => reject(new HerdrError("closed", `${method}: closed before a response`))),
  );

  return promise;
}

export type Subscription = { type: string; [key: string]: unknown };

/**
 * Long-lived event stream. The first frame is the `subscription_started` ack;
 * every later line is a pushed event.
 *
 * NOTE: `pane.agent_status_changed` REQUIRES a pane_id — there is no global
 * agent-status stream, so this is one connection per running ticket (memory/socket.md).
 */
export function subscribe(
  subscriptions: Subscription[],
  onEvent: (event: string, data: unknown) => void,
): { close: () => void } {
  let sock: Socket | null = connect(SOCKET_PATH);
  let buf = "";

  sock.on("connect", () => {
    sock?.write(
      JSON.stringify({ id: "10x:events", method: "events.subscribe", params: { subscriptions } }) +
        "\n",
    );
  });

  sock.on("data", (chunk) => {
    buf += chunk.toString();
    for (;;) {
      const nl = buf.indexOf("\n");
      if (nl === -1) break;
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;

      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (err) {
        console.warn("herdr event stream: unparseable line dropped:", err);
        continue;
      }
      if (typeof parsed !== "object" || parsed === null) continue;
      if ("event" in parsed && typeof parsed.event === "string") {
        onEvent(parsed.event, "data" in parsed ? parsed.data : undefined);
      }
    }
  });

  sock.on("error", (err) => {
    // The stream is best-effort: reconciliation is the real safety net. Still say so,
    // because a dead stream means ticket statuses silently stop updating.
    console.warn("herdr event stream error (statuses will stop updating):", err.message);
  });

  return {
    close: () => {
      sock?.destroy();
      sock = null;
    },
  };
}
