/**
 * Test harness shared by the route-level suites: the server under test as a real child process,
 * and a fake GitHub as a real local HTTP server. Not a `*.test.ts`, so `node --test` never runs
 * it on its own.
 *
 * A child process rather than an in-process import, because `server.ts` is a script: it awaits
 * the migration, listens, starts the poller and installs signal handlers at load. Driving it
 * over real HTTP is also what the frontend does, so the routes are tested at their contract.
 *
 * GitHub is faked by redirecting `fetch` inside the child (`github-fetch-shim.ts`, loaded with
 * `node --import`), so `github.ts` keeps its hardcoded API base and needs no test mode.
 */
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export type GhResponse = { status: number; body: unknown };
export type GhCall = { method: string; path: string; body: string };

export type FakeGitHub = {
  url: string;
  /** Consumed one per request, in order. Reassign or push; read at request time. */
  queue: GhResponse[];
  calls: GhCall[];
  close(): Promise<void>;
};

export async function startFakeGitHub(): Promise<FakeGitHub> {
  const gh: FakeGitHub = {
    url: "",
    queue: [],
    calls: [],
    close: async () => undefined,
  };
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => {
      raw += String(c);
    });
    req.on("end", () => {
      gh.calls.push({ method: req.method ?? "", path: req.url ?? "", body: raw });
      const next = gh.queue.shift() ?? { status: 500, body: { message: "no fake GitHub response queued" } };
      res.writeHead(next.status, { "content-type": "application/json" });
      res.end(JSON.stringify(next.body));
    });
  });
  const port = await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve(typeof addr === "object" && addr !== null ? addr.port : 0);
    });
  });
  gh.url = `http://127.0.0.1:${port}`;
  gh.close = () => new Promise<void>((r) => server.close(() => r()));
  return gh;
}

export type ApiResult = { status: number; body: Record<string, unknown> };

export type TestServer = {
  url: string;
  api(method: string, path: string, body?: unknown): Promise<ApiResult>;
  /** Everything the child printed so far — for failure messages. */
  log(): string;
  stop(): Promise<void>;
};

export type TestServerOptions = {
  port: number;
  stateDir: string;
  /** Extra environment. `undefined` deletes a variable the parent has. */
  env?: Record<string, string | undefined>;
  /** Redirect `https://api.github.com` to this fake. */
  githubUrl?: string;
};

export async function startTestServer(o: TestServerOptions): Promise<TestServer> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(o.port),
    STATE_DIR: o.stateDir,
    DB_PATH: join(o.stateDir, "10x.db"),
    // Never the real CLI from a test: a typo in a suite's env would otherwise spend a session.
    CLOUD_DRIVER: "fake",
    // Fast enough that a poller test does not wait five seconds per assertion.
    AGENT_POLL_MS: "100",
  };
  if (o.githubUrl) env.GITHUB_FETCH_SHIM_TARGET = o.githubUrl;
  for (const [key, value] of Object.entries(o.env ?? {})) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  const args = o.githubUrl
    ? ["--import", join(import.meta.dirname, "github-fetch-shim.ts"), join(import.meta.dirname, "server.ts")]
    : [join(import.meta.dirname, "server.ts")];
  const child = spawn(process.execPath, args, { env, stdio: ["ignore", "pipe", "pipe"] });

  let log = "";
  child.stdout.on("data", (c: unknown) => {
    log += String(c);
  });
  child.stderr.on("data", (c: unknown) => {
    log += String(c);
  });
  const exited = new Promise<void>((resolve) => child.on("exit", () => resolve()));

  const url = `http://localhost:${o.port}`;
  const deadline = Date.now() + 15_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`server exited before listening:\n${log}`);
    try {
      await fetch(`${url}/projects`).then((r) => r.text());
      break;
    } catch (err) {
      if (Date.now() > deadline) throw new Error(`server never came up: ${log}\n${err}`);
      await delay(100);
    }
  }

  return {
    url,
    async api(method, path, body) {
      const res = await fetch(`${url}${path}`, {
        method,
        headers: { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    },
    log: () => log,
    async stop() {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      await Promise.race([exited, delay(5000)]);
    },
  };
}
