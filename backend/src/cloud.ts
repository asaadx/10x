/**
 * Claude Code cloud sessions — the ONLY module that knows the `claude` CLI exists
 * (docs/prototype-cloud.md, "cloud.ts").
 *
 * The board drives the user's own logged-in `claude` binary and nothing else: no subscription
 * token is stored, forwarded or intermediated by 10x. That constraint is why this is a
 * subprocess wrapper rather than an HTTP client.
 *
 * Two things the CLI cannot do shape the rest of the system, and are worth knowing before
 * touching anything here:
 *
 *  - There is no way to READ a session's status. So nothing in this interface asks for one;
 *    the agent writes its own state into the shared database and the board polls that
 *    (server.ts's poller). A "getStatus" here would be a function with no implementation.
 *  - There is no way to stop or archive a session. Cancel is a polite message; the user
 *    archives the session in claude.ai if they want it gone.
 *
 * Two drivers, picked by `CLOUD_DRIVER`:
 *
 *  - `cli` (default) shells out to `CLAUDE_BIN ?? "claude"`.
 *  - `fake` records every call and, with `FAKE_AGENT_MS`, plays the agent's side of the
 *    protocol through the same `Sql` client the board reads — so the unit suite and e2e can
 *    drive a ticket from Backlog to Review with no network and no money spent.
 */
import { execFile } from "node:child_process";
import { appendFileSync } from "node:fs";
import { promisify } from "node:util";
import type { Sql } from "./sql.ts";

const run = promisify(execFile);

export type StartSessionOptions = {
  /** The project's local clone. `claude --cloud` reads the repo it is started in. */
  cwd: string;
  /** The bare upstream branch the session starts from (`--ref`). */
  baseBranch: string;
  /** The whole opening message: instructions plus the ticket (prompts.ts `sessionMessage`). */
  message: string;
  /** A human label for logs. The CLI has no title flag we rely on. */
  title: string;
};

export type StartedSession = { sessionId: string; sessionUrl: string };

export interface CloudDriver {
  startSession(o: StartSessionOptions): Promise<StartedSession>;
  /** Queue a message into a running session. Resolves once the CLI has accepted it. */
  sendMessage(sessionId: string, text: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Parsing — pure, and the part of the CLI contract most likely to drift.
// ---------------------------------------------------------------------------

/**
 * Session ids come in two shapes (`session_…` and `cse_…`) and the CLI prints the URL among
 * other chatter, so the FIRST match anywhere in stdout wins. Anchoring on a whole line would
 * break the day the CLI prefixes it with "Session: " or wraps it in colour codes.
 */
const SESSION_URL_RE = /https:\/\/claude\.ai\/code\/(session_\w+|cse_\w+)/;

export function parseSessionUrl(stdout: string): StartedSession | null {
  const m = SESSION_URL_RE.exec(stdout);
  if (!m?.[1]) return null;
  return { sessionId: m[1], sessionUrl: m[0] };
}

/**
 * `-p … --output-format json` answers `{ok, session_id, url}` or `{ok: false, error}`. Anything
 * that is not a JSON object with `ok: true` is a failure — including a zero exit with garbage
 * on stdout, because "the CLI said nothing we understand" must never read as "delivered".
 */
export function parseSendResult(stdout: string): { ok: true } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    return { ok: false, error: `unparseable CLI output: ${tail(stdout, 500)}` };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { ok: false, error: `unexpected CLI output: ${tail(stdout, 500)}` };
  }
  const record = parsed as Record<string, unknown>;
  if (record["ok"] === true) return { ok: true };
  const error = record["error"];
  return { ok: false, error: typeof error === "string" ? error : JSON.stringify(parsed) };
}

/** The end of a stream is where a CLI says what went wrong; the start is usually a banner. */
export const tail = (text: string, max = 2000): string =>
  text.length <= max ? text : `…${text.slice(text.length - max)}`;

// ---------------------------------------------------------------------------
// cli driver
// ---------------------------------------------------------------------------

/**
 * Generous on purpose: starting a cloud session provisions a container before the CLI prints
 * anything, and a timeout that fires first would leave a session running that the board never
 * learned the id of — an agent working on a ticket nobody can see.
 */
const CLI_TIMEOUT_MS = Number(process.env.CLOUD_TIMEOUT_MS || 180_000);

type ExecError = Error & { stdout?: unknown; stderr?: unknown; code?: unknown };

/** One error message carrying both streams' tails, so a failed spawn is diagnosable from the board. */
function cliError(what: string, err: unknown, stdout = "", stderr = ""): Error {
  const e = err as ExecError | undefined;
  const out = typeof e?.stdout === "string" ? e.stdout : stdout;
  const errText = typeof e?.stderr === "string" ? e.stderr : stderr;
  const reason = err instanceof Error ? err.message.split("\n")[0] : what;
  return new Error(
    `${what}: ${reason}\n--- stdout (tail) ---\n${tail(out) || "(empty)"}\n--- stderr (tail) ---\n${tail(errText) || "(empty)"}`,
  );
}

// `||`, not `??`, for every variable read here: `.env.example` lists them with empty values,
// and `loadEnvFile` sets an empty line to "" — which must mean "unset", not "run a binary
// named ''" or "play the agent after 0 ms".
export function cliDriver(bin = process.env.CLAUDE_BIN || "claude"): CloudDriver {
  const opts = { timeout: CLI_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 };
  return {
    async startSession({ cwd, baseBranch, message }) {
      let stdout: string;
      let stderr: string;
      try {
        ({ stdout, stderr } = await run(bin, ["--cloud", message, "--ref", baseBranch], { ...opts, cwd }));
      } catch (err) {
        // The session may well be live even though the CLI then timed out or exited non-zero:
        // if it already printed the URL, that is the session — dropping it would orphan a
        // running agent while the board handed the ticket back to To Do.
        const printed = (err as ExecError | undefined)?.stdout;
        const salvaged = typeof printed === "string" ? parseSessionUrl(printed) : null;
        if (salvaged) return salvaged;
        throw cliError("claude --cloud failed", err);
      }
      const session = parseSessionUrl(stdout);
      if (!session) throw cliError("claude --cloud printed no session URL", undefined, stdout, stderr);
      return session;
    },

    async sendMessage(sessionId, text) {
      let stdout: string;
      let stderr: string;
      try {
        ({ stdout, stderr } = await run(
          bin,
          ["-p", text, "--cloud", sessionId, "--output-format", "json"],
          opts,
        ));
      } catch (err) {
        throw cliError(`claude -p --cloud ${sessionId} failed`, err);
      }
      const result = parseSendResult(stdout);
      if (!result.ok) {
        throw cliError(`claude -p --cloud ${sessionId} was refused: ${result.error}`, undefined, stdout, stderr);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// fake driver
// ---------------------------------------------------------------------------

export type FakeCall =
  | { kind: "start"; sessionId: string; cwd: string; baseBranch: string; title: string; message: string }
  | { kind: "send"; sessionId: string; text: string };

export type FakeDriver = CloudDriver & { calls: FakeCall[] };

export type FakeOptions = {
  /** The store the fake agent writes into. Without it the fake only records. */
  sql?: Sql;
  /** Play the agent: `working` after this many ms, `done` after twice that. Unset = never. */
  agentMs?: number;
  /** Which calls throw, for testing the board's hand-back paths. */
  fail?: ReadonlySet<"start" | "send">;
  /** Append each call as a JSON line, so a test can read what a server CHILD process sent. */
  logFile?: string;
};

/**
 * The ticket id the session is about, read out of its opening message. The real agent learns
 * it the same way — the message is all a cloud session is given — so the fake needs no
 * back-channel the real protocol lacks. `sessionMessage` in prompts.ts writes this line.
 */
export function ticketIdFromMessage(message: string): string | null {
  return /^10x ticket (\S+)/m.exec(message)?.[1] ?? null;
}

/**
 * An implementation session is told which branch to push (`claude/10x-<id>`); a plan session
 * has no branch. That is the only difference the fake agent's behaviour depends on.
 */
/**
 * The run token, read the way a real agent reads it: the prompts pass it as the argument right
 * after the ticket id at the end of every scoped `tenx_sql` call (prompts/*.md).
 */
export function runTokenFromMessage(message: string, ticketId: string): string | null {
  const escaped = ticketId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Only the instructions, which follow the ticket block (prompts.ts sessionMessage): a title
  // like "Fix demo-3 bug" must not read as the token "bug".
  const separator = message.lastIndexOf("\n---\n");
  if (separator === -1) return null;
  const instructions = message.slice(separator + 1);
  return new RegExp(`${escaped} (\\S+)[ \\t]*$`, "m").exec(instructions)?.[1] ?? null;
}

const isImplementation = (message: string): boolean => message.includes("claude/10x-");

export function fakeDriver(o: FakeOptions = {}): FakeDriver {
  const calls: FakeCall[] = [];
  /** sessionId → what the fake agent needs to replay a turn on a follow-up message. */
  const sessions = new Map<string, { ticketId: string; runToken: string; impl: boolean }>();
  let n = 0;

  const record = (call: FakeCall) => {
    calls.push(call);
    if (o.logFile) appendFileSync(o.logFile, `${JSON.stringify(call)}\n`);
  };

  /*
   * Every write is conditioned on `run_token = ?`, the token the board quoted in the opening
   * message — exactly the scope the real prompts give an agent (prompts/*.md, db.ts run_token).
   * So the fake exercises the real guard: a turn that outlives its run (a cancelled ticket, a
   * spawn the board handed back, a planner left open after Start) writes nothing instead of
   * resurrecting state on a row that has moved on.
   */
  const write = async (runToken: string, ticketId: string, set: Record<string, string>) => {
    if (!o.sql) return;
    const columns = Object.keys(set);
    await o.sql.execute(
      `UPDATE tickets SET ${columns.map((c) => `${c} = ?`).join(", ")}, agent_updated_at = ? ` +
        "WHERE id = ? AND run_token = ?",
      [...columns.map((c) => set[c] ?? null), new Date().toISOString(), ticketId, runToken],
    );
  };

  const playTurn = (sessionId: string) => {
    const session = sessions.get(sessionId);
    const ms = o.agentMs;
    if (!session || ms === undefined || !o.sql) return;
    const { ticketId, runToken, impl } = session;
    const fail = (err: unknown) => console.warn(`[fake agent ${ticketId}] write failed:`, err);
    setTimeout(() => {
      write(runToken, ticketId, { agent_state: "working" }).catch(fail);
    }, ms);
    setTimeout(() => {
      const done: Record<string, string> = impl
        ? {
            branch: `claude/10x-${ticketId}`,
            agent_note: "Fake agent: pushed claude/10x-" + ticketId + " (no real work was done).",
          }
        : { agent_note: "Fake planner: nothing to add (no real conversation took place)." };
      // `agent_state` last in the SET list is cosmetic — one UPDATE is atomic either way — but
      // it mirrors the real protocol, where `done` is the agent's very last write.
      write(runToken, ticketId, { ...done, agent_state: "done" }).catch(fail);
    }, ms * 2);
  };

  return {
    calls,
    async startSession({ cwd, baseBranch, message, title }) {
      n += 1;
      const sessionId = `session_fake_${n}`;
      record({ kind: "start", sessionId, cwd, baseBranch, title, message });
      if (o.fail?.has("start")) throw new Error("fake cloud: startSession configured to fail");
      const ticketId = ticketIdFromMessage(message);
      const runToken = ticketId ? runTokenFromMessage(message, ticketId) : null;
      if (ticketId && runToken) sessions.set(sessionId, { ticketId, runToken, impl: isImplementation(message) });
      playTurn(sessionId);
      return { sessionId, sessionUrl: `https://claude.ai/code/${sessionId}` };
    },
    async sendMessage(sessionId, text) {
      record({ kind: "send", sessionId, text });
      if (o.fail?.has("send")) throw new Error("fake cloud: sendMessage configured to fail");
      playTurn(sessionId);
    },
  };
}

/** The driver the server uses, from the environment. `sql` is only read by the fake. */
export function cloudDriverFromEnv(sql: Sql, env: NodeJS.ProcessEnv = process.env): CloudDriver {
  const kind = env.CLOUD_DRIVER || "cli";
  if (kind === "cli") return cliDriver();
  if (kind === "fake") {
    const fail = new Set(
      (env.FAKE_CLOUD_FAIL ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter((s): s is "start" | "send" => s === "start" || s === "send"),
    );
    const agentMs = env.FAKE_AGENT_MS ? Number(env.FAKE_AGENT_MS) : undefined;
    if (agentMs !== undefined && !(Number.isFinite(agentMs) && agentMs >= 0)) {
      throw new Error(`FAKE_AGENT_MS must be a non-negative number, got "${env.FAKE_AGENT_MS}"`);
    }
    return fakeDriver({
      sql,
      ...(agentMs === undefined ? {} : { agentMs }),
      fail,
      ...(env.FAKE_CLOUD_LOG ? { logFile: env.FAKE_CLOUD_LOG } : {}),
    });
  }
  // A typo must not silently fall back to spending real sessions, or to a fake in production.
  throw new Error(`CLOUD_DRIVER must be "cli" or "fake", got "${kind}"`);
}
