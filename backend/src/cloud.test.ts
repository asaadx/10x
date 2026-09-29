/**
 * Tests for cloud.ts: the stdout parsing the `cli` driver depends on, the `cli` driver itself
 * against a stand-in `claude` script (argv, cwd and error reporting are the contract — the real
 * binary is never run here), and the `fake` driver's agent playback through a real `Sql`.
 */
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  cliDriver,
  cloudDriverFromEnv,
  fakeDriver,
  parseSendResult,
  parseSessionUrl,
  runTokenFromMessage,
  tail,
  ticketIdFromMessage,
} from "./cloud.ts";
import { localSql } from "./sql.ts";

const dir = mkdtempSync(join(tmpdir(), "10x-cloud-test-"));
after(() => rmSync(dir, { recursive: true, force: true }));

describe("parseSessionUrl", () => {
  test("finds a session_ URL among other output", () => {
    const out = "Starting…\nSession created: https://claude.ai/code/session_01AbC23 (open in browser)\n";
    assert.deepEqual(parseSessionUrl(out), {
      sessionId: "session_01AbC23",
      sessionUrl: "https://claude.ai/code/session_01AbC23",
    });
  });

  test("accepts the cse_ id shape too", () => {
    assert.equal(parseSessionUrl("https://claude.ai/code/cse_9f8e7d")?.sessionId, "cse_9f8e7d");
  });

  test("the FIRST URL wins when several are printed", () => {
    const out = "https://claude.ai/code/session_first\nsee also https://claude.ai/code/session_second";
    assert.equal(parseSessionUrl(out)?.sessionId, "session_first");
  });

  test("no session URL is null, including a claude.ai link that is not one", () => {
    assert.equal(parseSessionUrl("done."), null);
    assert.equal(parseSessionUrl("https://claude.ai/code/artifact/abc"), null);
    assert.equal(parseSessionUrl("https://example.com/code/session_x"), null);
  });
});

describe("parseSendResult", () => {
  test("ok: true is delivered", () => {
    assert.deepEqual(parseSendResult('{"ok":true,"session_id":"session_x","url":"u"}\n'), { ok: true });
  });

  test("ok: false carries the CLI's error", () => {
    assert.deepEqual(parseSendResult('{"ok":false,"error":"session archived"}'), {
      ok: false,
      error: "session archived",
    });
  });

  test("anything unparseable is a failure, never a silent success", () => {
    assert.equal(parseSendResult("").ok, false);
    assert.equal(parseSendResult("Sent!").ok, false);
    assert.equal(parseSendResult("[]").ok, false);
    assert.equal(parseSendResult("null").ok, false);
  });
});

test("tail keeps the end of a long stream", () => {
  assert.equal(tail("abc", 5), "abc");
  assert.equal(tail("0123456789", 3), "…789");
});

test("ticketIdFromMessage reads the id line sessionMessage writes", () => {
  assert.equal(ticketIdFromMessage("10x ticket demo-3 — Add a button\n\nbody"), "demo-3");
  assert.equal(ticketIdFromMessage("no id here"), null);
});

describe("cli driver", () => {
  /** A stand-in `claude`: logs argv and cwd, then answers according to MODE. */
  const bin = join(dir, "claude");
  const argvLog = join(dir, "argv.log");
  writeFileSync(
    bin,
    [
      "#!/bin/sh",
      `printf '%s\\n' "$PWD" "$@" > "${argvLog}"`,
      'case "$MODE" in',
      "  start-ok) echo 'Launching…'; echo 'https://claude.ai/code/session_abc123' ;;",
      "  start-nourl) echo 'something went sideways' ;;",
      "  start-crash) echo 'partial out'; echo 'boom: not logged in' >&2; exit 3 ;;",
      "  start-url-then-fail) echo 'https://claude.ai/code/session_late9'; exit 1 ;;",
      "  send-ok) echo '{\"ok\":true,\"session_id\":\"session_abc123\"}' ;;",
      "  send-refused) echo '{\"ok\":false,\"error\":\"no such session\"}' ;;",
      "esac",
      "",
    ].join("\n"),
  );
  chmodSync(bin, 0o755);
  const driver = cliDriver(bin);
  const argv = () => readFileSync(argvLog, "utf8").trimEnd().split("\n");

  test("startSession runs `--cloud <message> --ref <base>` in the clone and parses the URL", async () => {
    process.env.MODE = "start-ok";
    const got = await driver.startSession({ cwd: dir, baseBranch: "dev", message: "do it\nplease", title: "t" });
    assert.deepEqual(got, { sessionId: "session_abc123", sessionUrl: "https://claude.ai/code/session_abc123" });
    // The multi-line message arrives as ONE argv entry; printf splits it on the newline here.
    assert.deepEqual(argv(), [dir, "--cloud", "do it", "please", "--ref", "dev"]);
  });

  test("a URL printed before the CLI fails is still the session (not orphaned)", async () => {
    process.env.MODE = "start-url-then-fail";
    const got = await driver.startSession({ cwd: dir, baseBranch: "main", message: "m", title: "t" });
    assert.equal(got.sessionId, "session_late9");
  });

  test("no URL in stdout is an error that quotes stdout", async () => {
    process.env.MODE = "start-nourl";
    await assert.rejects(
      driver.startSession({ cwd: dir, baseBranch: "main", message: "m", title: "t" }),
      /printed no session URL[\s\S]*something went sideways/,
    );
  });

  test("a non-zero exit carries both streams' tails", async () => {
    process.env.MODE = "start-crash";
    await assert.rejects(
      driver.startSession({ cwd: dir, baseBranch: "main", message: "m", title: "t" }),
      (err: Error) => /partial out/.test(err.message) && /not logged in/.test(err.message),
    );
  });

  test("sendMessage runs `-p <text> --cloud <id> --output-format json` and checks ok", async () => {
    process.env.MODE = "send-ok";
    await driver.sendMessage("session_abc123", "fix the typo");
    assert.deepEqual(argv().slice(1), ["-p", "fix the typo", "--cloud", "session_abc123", "--output-format", "json"]);
  });

  test("sendMessage with ok:false rejects with the CLI's error", async () => {
    process.env.MODE = "send-refused";
    await assert.rejects(driver.sendMessage("session_abc123", "x"), /no such session/);
  });

  test("a missing binary is an error, not a hang", async () => {
    await assert.rejects(
      cliDriver(join(dir, "nope")).startSession({ cwd: dir, baseBranch: "main", message: "m", title: "t" }),
      /claude --cloud failed/,
    );
  });
});

describe("fake driver", () => {
  const sql = localSql(join(dir, "fake.db"));
  const seed = async (id: string, runToken: string) => {
    await sql.execute(
      "CREATE TABLE IF NOT EXISTS tickets (id TEXT PRIMARY KEY, run_token TEXT, branch TEXT, " +
        "agent_state TEXT, agent_note TEXT, agent_updated_at TEXT)",
    );
    await sql.execute("INSERT INTO tickets (id, run_token, agent_state) VALUES (?, ?, 'starting')", [id, runToken]);
  };
  const row = async (id: string) => (await sql.execute("SELECT * FROM tickets WHERE id = ?", [id])).rows[0];
  // The shape sessionMessage produces: ticket block, separator, instructions whose scoped
  // tenx_sql calls end in "<ticketId> <runToken>". The title deliberately ends in the id plus
  // a word, which must not be mistaken for the token.
  const message = (id: string, token: string, impl: boolean) =>
    `10x ticket ${id} — Fix ${id} bug\n\n---\n\n` +
    `tenx_sql "UPDATE tickets SET agent_state = ? WHERE id = ? AND run_token = ?" working ${id} ${token}\n` +
    (impl ? `Push to claude/10x-${id}.\n` : "");

  test("records calls and hands out distinct fake sessions", async () => {
    const fake = fakeDriver();
    const a = await fake.startSession({ cwd: "/r", baseBranch: "main", message: "m1", title: "one" });
    const b = await fake.startSession({ cwd: "/r", baseBranch: "main", message: "m2", title: "two" });
    await fake.sendMessage(a.sessionId, "hello");
    assert.notEqual(a.sessionId, b.sessionId);
    assert.match(a.sessionId, /^session_fake_\d+$/);
    assert.equal(a.sessionUrl, `https://claude.ai/code/${a.sessionId}`);
    assert.deepEqual(
      fake.calls.map((c) => c.kind),
      ["start", "start", "send"],
    );
  });

  test("runTokenFromMessage reads the token after the id, never the title", () => {
    assert.equal(runTokenFromMessage(message("p-9", "tok-9", true), "p-9"), "tok-9");
    assert.equal(runTokenFromMessage("10x ticket p-9 — Fix p-9 bug", "p-9"), null);
  });

  test("plays an implementation agent: working, then done with a branch and a note", async () => {
    await seed("p-1", "tok-1");
    const fake = fakeDriver({ sql, agentMs: 150 });
    await fake.startSession({ cwd: "/r", baseBranch: "main", message: message("p-1", "tok-1", true), title: "t" });
    // Checked mid-window (150..300 ms) so a loaded machine does not flake it.
    await delay(225);
    assert.equal((await row("p-1"))?.["agent_state"], "working");
    await delay(150);
    const done = await row("p-1");
    assert.equal(done?.["agent_state"], "done");
    assert.equal(done?.["branch"], "claude/10x-p-1");
    assert.equal(typeof done?.["agent_note"], "string");
    assert.equal(typeof done?.["agent_updated_at"], "string");
  });

  test("a plan session writes no branch", async () => {
    await seed("p-2", "tok-2");
    const fake = fakeDriver({ sql, agentMs: 10 });
    await fake.startSession({ cwd: "/r", baseBranch: "main", message: message("p-2", "tok-2", false), title: "t" });
    await delay(60);
    assert.equal((await row("p-2"))?.["agent_state"], "done");
    assert.equal((await row("p-2"))?.["branch"], null);
  });

  test("a turn whose run was replaced (cancel, restart, a stale planner) writes nothing", async () => {
    await seed("p-3", "tok-new");
    const fake = fakeDriver({ sql, agentMs: 10 });
    await fake.startSession({ cwd: "/r", baseBranch: "main", message: message("p-3", "tok-old", true), title: "t" });
    await delay(60);
    assert.equal((await row("p-3"))?.["agent_state"], "starting");
  });

  test("a follow-up message replays a turn under the same token", async () => {
    await seed("p-4", "tok-4");
    const fake = fakeDriver({ sql, agentMs: 10 });
    const s = await fake.startSession({ cwd: "/r", baseBranch: "main", message: message("p-4", "tok-4", true), title: "t" });
    await delay(60);
    await sql.execute("UPDATE tickets SET agent_state = 'working' WHERE id = 'p-4'");
    await fake.sendMessage(s.sessionId, "again");
    await delay(60);
    assert.equal((await row("p-4"))?.["agent_state"], "done");
  });

  test("configured failures throw after recording", async () => {
    const fake = fakeDriver({ fail: new Set(["start", "send"] as const) });
    await assert.rejects(fake.startSession({ cwd: "/r", baseBranch: "m", message: "x", title: "t" }), /configured to fail/);
    await assert.rejects(fake.sendMessage("s", "x"), /configured to fail/);
    assert.equal(fake.calls.length, 2);
  });

  test("logFile gets one JSON line per call", async () => {
    const logFile = join(dir, "calls.jsonl");
    const fake = fakeDriver({ logFile });
    await fake.startSession({ cwd: "/r", baseBranch: "m", message: "x", title: "t" });
    await fake.sendMessage("session_fake_1", "y");
    const lines = readFileSync(logFile, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { kind: string });
    assert.deepEqual(lines.map((l) => l.kind), ["start", "send"]);
  });
});

describe("cloudDriverFromEnv", () => {
  const sql = localSql(join(dir, "env.db"));
  test("an unknown driver name throws rather than falling back", () => {
    assert.throws(() => cloudDriverFromEnv(sql, { CLOUD_DRIVER: "fak" }), /CLOUD_DRIVER must be/);
  });
  test("a malformed FAKE_AGENT_MS throws", () => {
    assert.throws(() => cloudDriverFromEnv(sql, { CLOUD_DRIVER: "fake", FAKE_AGENT_MS: "soon" }), /FAKE_AGENT_MS/);
  });
  test("empty values — what `.env.example` ships — mean unset", async () => {
    const d = cloudDriverFromEnv(sql, { CLOUD_DRIVER: "fake", FAKE_AGENT_MS: "" });
    // No agent playback configured, so nothing is scheduled and nothing throws.
    await d.startSession({ cwd: "/", baseBranch: "m", message: "10x ticket x-1", title: "t" });
  });
  test("fake with FAKE_CLOUD_FAIL=start fails its starts", async () => {
    const d = cloudDriverFromEnv(sql, { CLOUD_DRIVER: "fake", FAKE_CLOUD_FAIL: "start" });
    await assert.rejects(d.startSession({ cwd: "/", baseBranch: "m", message: "x", title: "t" }));
  });
});
