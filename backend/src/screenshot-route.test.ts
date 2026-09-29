/**
 * Route-level tests for the screenshot upload and serving surface: `POST
 * /tickets/:id/screenshots/:side` (the visual-diff skill's upload path) and `GET
 * /screenshots/<file>` (what `ScreenshotPane` renders). Unit coverage for the storage itself
 * lives in screenshots.test.ts; this is the one binary-body route in the whole API, so what
 * matters here is that the HTTP layer moves the bytes without corrupting them and that
 * deleting a ticket takes its files with it — the same shape as archive.test.ts.
 */
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import type { Server, Socket } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const dir = mkdtempSync(join(tmpdir(), "10x-screenshot-route-test-"));
const socketPath = join(dir, "herdr.sock");
const PORT = 4323;
process.env.STATE_DIR = dir;
process.env.DB_PATH = join(dir, "10x.db");
process.env.HERDR_SOCKET_PATH = socketPath;

// db.ts reads STATE_DIR/DB_PATH at module load, so this must be dynamic — see plan.test.ts.
const { db, initDb, nowIso } = await import("./db.ts");
await initDb();

const API_URL = `http://localhost:${PORT}`;
const PROJECT_ID = "shot-test";

// ---------------------------------------------------------------------------
// Fake Herdr: only what a screenshot-less DELETE's teardown conversation touches — the ticket
// carries no PR, so the route never reaches GitHub.
// ---------------------------------------------------------------------------

type Frame = { result?: unknown; error?: { code: string; message: string } };
type Handler = (params: Record<string, unknown>) => Frame;

const calls: { method: string; params: Record<string, unknown> }[] = [];

const handlers: Record<string, Handler> = {
  "workspace.list": () => ({ result: { type: "workspace_list", workspaces: [] } }),
  "agent.list": () => ({ result: { type: "agent_list", agents: [] } }),
  "worktree.list": () => ({ result: { type: "worktree_list", worktrees: [] } }),
  "agent.get": () => ({ error: { code: "agent_not_found", message: "no such agent" } }),
  "worktree.open": () => ({ error: { code: "worktree_not_found", message: "nothing on disk" } }),
};

const sockets: Socket[] = [];
const herdr: Server = createServer((socket) => {
  sockets.push(socket);
  let buf = "";
  socket.on("data", (chunk) => {
    buf += chunk.toString();
    const nl = buf.indexOf("\n");
    if (nl === -1) return;
    const line = buf.slice(0, nl);
    buf = "";
    const parsed: unknown = JSON.parse(line);
    if (typeof parsed !== "object" || parsed === null || !("method" in parsed)) {
      socket.end(JSON.stringify({ error: { code: "bad_frame", message: line } }) + "\n");
      return;
    }
    const method = String(parsed.method);
    const params =
      "params" in parsed && typeof parsed.params === "object" && parsed.params !== null
        ? (parsed.params as Record<string, unknown>)
        : {};
    calls.push({ method, params });
    const handler = handlers[method];
    const frame: Frame = handler ? handler(params) : { error: { code: "unknown_method", message: method } };
    socket.end(JSON.stringify({ id: "fake", ...frame }) + "\n");
  });
});
{
  const { promise, resolve } = Promise.withResolvers<void>();
  herdr.listen(socketPath, resolve);
  await promise;
}

// ---------------------------------------------------------------------------
// The store, seeded directly.
// ---------------------------------------------------------------------------

await db.execute(
  "INSERT INTO projects (id, name, repo_path, base_branch, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  [PROJECT_ID, PROJECT_ID, "/tmp/does-not-matter", "main", nowIso(), nowIso()],
);

let nextNumber = 1;
async function seedTicket(status = "in_progress"): Promise<string> {
  const number = nextNumber++;
  const id = `${PROJECT_ID}-${number}`;
  await db.execute(
    `INSERT INTO tickets (id, project_id, number, title, description, status,
                          finished, died, branch, agent_name, session_dir, created_at, updated_at)
     VALUES (?, ?, ?, 'Ticket', '', ?, 0, 0, NULL, NULL, NULL, ?, ?)`,
    [id, PROJECT_ID, number, status, nowIso(), nowIso()],
  );
  return id;
}

// ---------------------------------------------------------------------------
// The server child.
// ---------------------------------------------------------------------------

const child = spawn(process.execPath, [join(import.meta.dirname, "server.ts")], {
  env: { ...process.env, PORT: String(PORT), STATE_DIR: dir, DB_PATH: join(dir, "10x.db"), HERDR_SOCKET_PATH: socketPath },
  stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
child.stdout.on("data", (c: unknown) => {
  serverLog += String(c);
});
child.stderr.on("data", (c: unknown) => {
  serverLog += String(c);
});

{
  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      await fetch(`${API_URL}/projects`).then((r) => r.text());
      break;
    } catch (err) {
      if (Date.now() > deadline) throw new Error(`server never came up: ${serverLog}\n${err}`);
      await delay(100);
    }
  }
}

async function api(method: string, path: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${API_URL}${path}`, { method });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function upload(id: string, side: string, data: Uint8Array) {
  const res = await fetch(`${API_URL}/tickets/${id}/screenshots/${side}`, {
    method: "POST",
    headers: { "content-type": "image/png" },
    body: Buffer.from(data),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

after(async () => {
  child.kill("SIGTERM");
  for (const socket of sockets) socket.destroy();
  const { promise, resolve } = Promise.withResolvers<void>();
  herdr.close(() => resolve());
  await promise;
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------

describe("POST /tickets/:id/screenshots/:side", () => {
  test("stores the raw bytes untouched and the served path renders them back byte for byte", async () => {
    const id = await seedTicket();
    // Bytes chosen to include a NUL and high bytes: a route that treated this as UTF-8 text
    // anywhere along the way would corrupt it, which is the whole reason the upload bypasses
    // `readBody`'s JSON parse.
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0x80]);

    const up = await upload(id, "before", png);
    assert.equal(up.status, 200);
    assert.equal(up.body["path"], `/screenshots/${id}-before.png`);

    const served = await fetch(`${API_URL}${up.body["path"] as string}`);
    assert.equal(served.status, 200);
    assert.equal(served.headers.get("content-type"), "image/png");
    assert.deepEqual(new Uint8Array(await served.arrayBuffer()), png);

    const ticket = (await api("GET", `/tickets?project=${PROJECT_ID}`)).body["tickets"] as Record<
      string,
      unknown
    >[];
    const found = ticket.find((t) => t["id"] === id);
    assert.deepEqual(found?.["screenshots"], { before: `/screenshots/${id}-before.png`, after: null });
  });

  test("404s for a ticket that does not exist, naming the code", async () => {
    const res = await upload("no-such-ticket", "before", new Uint8Array([1]));
    assert.equal(res.status, 404);
    assert.equal(res.body["error"], "no_such_ticket");
  });

  test("400s on an empty body", async () => {
    const id = await seedTicket();
    const res = await upload(id, "after", new Uint8Array());
    assert.equal(res.status, 400);
    assert.equal(res.body["error"], "empty_body");
  });

  test("400s on a declared Content-Type other than image/png", async () => {
    const id = await seedTicket();
    const res = await fetch(`${API_URL}/tickets/${id}/screenshots/before`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json())["error"], "invalid_content_type");
  });

  test("400s when the declared type is image/png but the bytes are not really a PNG", async () => {
    const id = await seedTicket();
    const res = await upload(id, "before", new TextEncoder().encode("not a png"));
    assert.equal(res.status, 400);
    assert.equal(res.body["error"], "invalid_image");
  });

  test("413s once the body crosses the size cap, without writing a file", async () => {
    const id = await seedTicket();
    // server.ts's MAX_SCREENSHOT_BYTES is 10 MiB and not exported; this pins that exact
    // threshold, so a deliberate change to the cap must update this test alongside it.
    const oversized = Buffer.alloc(10 * 1024 * 1024 + 1);
    const res = await fetch(`${API_URL}/tickets/${id}/screenshots/before`, {
      method: "POST",
      headers: { "content-type": "image/png" },
      body: oversized,
    });
    assert.equal(res.status, 413);
    assert.equal((await res.json())["error"], "payload_too_large");

    const ticket = (await api("GET", `/tickets?project=${PROJECT_ID}`)).body["tickets"] as Record<
      string,
      unknown
    >[];
    assert.deepEqual(ticket.find((t) => t["id"] === id)?.["screenshots"], { before: null, after: null });
  });
});

describe("GET /screenshots/:file", () => {
  test("a file that was never uploaded 404s with the ordinary JSON envelope, not a crash", async () => {
    const res = await fetch(`${API_URL}/screenshots/never-uploaded-before.png`);
    assert.equal(res.status, 404);
    assert.equal((await res.json())["error"], "not_found");
  });

  test("path traversal out of the screenshots directory 404s rather than serving a file", async () => {
    const res = await fetch(`${API_URL}/screenshots/${encodeURIComponent("../package.json")}`);
    assert.equal(res.status, 404);
  });
});

describe("DELETE /tickets/:id", () => {
  test("deleting a ticket reclaims its screenshot files: the served path 404s afterward", async () => {
    const id = await seedTicket();
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const up = await upload(id, "before", png);
    const path = up.body["path"] as string;
    assert.equal((await fetch(`${API_URL}${path}`)).status, 200);

    const del = await api("DELETE", `/tickets/${id}`);
    assert.equal(del.status, 200);

    assert.equal((await fetch(`${API_URL}${path}`)).status, 404);
  });
});
