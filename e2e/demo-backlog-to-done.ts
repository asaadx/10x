/**
 * The Backlog -> Done demo run: one non-interactive pass of the whole product flow — compose,
 * promote, Start, wait out a real agent turn, Accept — driven through the board UI in a real
 * browser, against the REAL `asaadx/10x-test` repo.
 *
 * NOT a Playwright spec, and deliberately not named `*.spec.ts`: neither `playwright.config.ts`
 * project can pick this up, because it is a repeatable demo/verification run rather than a
 * member of the test suite. Plain TypeScript executed by `node`, the same way
 * `backend/src/server.ts` is run.
 *
 * It COSTS MONEY and it PUBLISHES: Start spawns a real coding agent and Accept pushes a branch
 * and opens a real pull request on `asaadx/10x-test`. Hence `pnpm demo:real-agent-pr`, which is
 * the only intended entry point (it builds the frontend first — the board serves it, and the UI
 * cannot load without `frontend/dist`).
 *
 * Everything it creates is torn down again, on the failure path too: see `teardown` below.
 *
 * PARTLY VERIFIED. The browser launch and every locator chain below were exercised against a
 * real board on a throwaway local repo, up to and including the Start button (located, never
 * clicked). The three steps that cost money or publish — Start, the agent's turn, Accept — and
 * therefore the GitHub half of the teardown, have never been run.
 */
import { chromium, type Browser, type Locator, type Page } from "@playwright/test";
import { execFile } from "node:child_process";
import { mkdtemp, rm, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { request as herdr } from "../backend/src/herdr.ts";
import {
  api,
  boardRows,
  cleanupAll,
  createProject,
  PROBE_DESCRIPTION,
  requireHerdr,
  startBoard,
  storedTicket,
  stringField,
  ticketRow,
  type Board,
} from "./fixtures.ts";

const git = promisify(execFile);

const REPO_SLUG = "asaadx/10x-test";
/** Plain HTTPS, untokenised: `github.ts`'s `parseRemote` rejects anything else as `origin`. */
const REPO_URL = `https://github.com/${REPO_SLUG}.git`;
const PR_URL_PREFIX = `github.com/${REPO_SLUG}/pull/`;

const PROJECT_ID = "demo";
/** `createProject` names a project `Project <id>`; the pickers show that name, not the id. */
const PROJECT_NAME = `Project ${PROJECT_ID}`;

const TITLE = `Backlog-to-Done demo ${new Date().toISOString().replace(/\.\d+Z$/, "Z")}`;

/**
 * Every budget below is a deadline on a CONDITION, never a sleep: the board polls once a
 * second, so a DOM state that only waits on a poll gets seconds, while the two writes that do
 * real work (spawn, publish) get room for git and the network.
 */
const UI_MS = 20_000;
/** Start creates the worktree, reserves the port block and waits for the agent to be ready. */
const SPAWN_MS = 120_000;
/** The one unavoidable wait: a real model turn on the probe ticket. Generous by design. */
const TURN_MS = 900_000;
/** Accept pushes the branch and opens the PR before it answers. */
const ACCEPT_MS = 180_000;
/** Poll cadence while waiting on the agent, and how often that wait says it is still alive. */
const POLL_MS = 1_000;
const PROGRESS_MS = 10_000;

const TOKEN = process.env.GITHUB_TOKEN ?? "";

/**
 * Headed by default: the point of this run is a watchable pass through the board. `chromium`
 * is Playwright's bundled build — the default `chrome` channel is not installed here and
 * fails with "Chromium distribution 'chrome' is not found", which is also why
 * `.playwright/cli.config.json` pins the same channel for the CLI. It is the build this
 * repo's own Playwright wants, so it comes from `pnpm exec playwright install chromium`; the
 * one `npx playwright` downloaded for the CLI skill is a different revision and does not
 * satisfy it.
 */
const HEADLESS = process.env.DEMO_HEADLESS === "1";

const startedAt = Date.now();

/** `MM:SS` for a duration, so a progress line reads at a glance. */
function clock(ms: number): string {
  const total = Math.round(ms / 1000);
  const mm = String(Math.floor(total / 60)).padStart(2, "0");
  const ss = String(total % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

function log(message: string): void {
  console.log(`[${clock(Date.now() - startedAt)}] ${message}`);
}

/**
 * The step the run is inside. Read by the top-level catch so a failure names what failed
 * rather than only where the stack happened to unwind from.
 */
let currentStep = "startup";

async function step<T>(label: string, run: () => Promise<T>): Promise<T> {
  currentStep = label;
  log(`${label} ...`);
  const from = Date.now();
  const out = await run();
  log(`${label} — done in ${((Date.now() - from) / 1000).toFixed(1)}s`);
  return out;
}

/**
 * Nothing loads `.env` for a bare `node` invocation — the board inherits this process's
 * environment and `POST /tickets/:id/accept` answers `missing_github_token` without it — so
 * the message says to export it rather than pointing at a file that will not be read.
 */
function requireGithubToken(): void {
  if (TOKEN !== "") return;
  throw new Error(
    `GITHUB_TOKEN is not set. This run pushes a branch to ${REPO_SLUG} and opens a pull ` +
      `request against it, so it needs a token with push access to ${REPO_SLUG}. Nothing ` +
      "loads .env for a bare `node` invocation, so export it into this shell first: " +
      "`export GITHUB_TOKEN=...`",
  );
}

const GITHUB_API_HEADERS = {
  Authorization: `Bearer ${TOKEN}`,
  Accept: "application/vnd.github+json",
  "Content-Type": "application/json",
};

/**
 * Closes the PR and deletes the pushed branch on `asaadx/10x-test`, undoing exactly what
 * Accept created — the same two REST calls `e2e/accept.spec.ts` cleans up with, and for the
 * same reason: `fetch` straight at the GitHub API, like `backend/src/github.ts`, rather than
 * shelling out to `gh`.
 *
 * It also has to run BEFORE the ticket delete below: `DELETE /tickets/:id` reads the PR state
 * live and refuses with `pr_open` while the pull request is still open, which would otherwise
 * strand the worktree and the branch.
 */
async function closeGithubState(branch: string, prNumber: number | null): Promise<void> {
  if (prNumber !== null) {
    const res = await fetch(`https://api.github.com/repos/${REPO_SLUG}/pulls/${prNumber}`, {
      method: "PATCH",
      headers: GITHUB_API_HEADERS,
      body: JSON.stringify({ state: "closed" }),
    });
    log(`closed PR #${prNumber} (${res.status})`);
  }
  // 422 here is the "never pushed" case, which is a clean state rather than a failure.
  const ref = `https://api.github.com/repos/${REPO_SLUG}/git/refs/heads/${branch}`;
  const res = await fetch(ref, { method: "DELETE", headers: GITHUB_API_HEADERS });
  log(`deleted remote branch ${branch} (${res.status})`);
}

type WorkspaceRow = {
  workspace_id: string;
  worktree?: { checkout_path?: string; is_linked_worktree?: boolean } | null;
};

/**
 * The spawn implicitly opens a SOURCE workspace for the clone (memory/reconciliation.md), and
 * `cleanupAll` only knows the repos `makeRepo` handed out — this clone is our own `mkdtemp`,
 * so it would leave one dead workspace pointing at a deleted path per run.
 *
 * `workspace.close`, never `worktree.remove`: a source workspace is not a linked worktree and
 * removal refuses it. Guarded on both `is_linked_worktree` and the checkout path so a ticket
 * worktree can never be closed here by mistake.
 */
async function closeSourceWorkspace(clonePath: string): Promise<void> {
  const listed = await herdr<{ workspaces?: WorkspaceRow[] }>("workspace.list", {});
  for (const ws of listed.workspaces ?? []) {
    const path = ws.worktree?.checkout_path;
    if (ws.worktree?.is_linked_worktree !== false || path !== clonePath) continue;
    await herdr("workspace.close", { workspace_id: ws.workspace_id });
  }
}

// --- the board UI -----------------------------------------------------------
//
// Located by ARIA and by the two attributes the frontend documents as its e2e handles —
// `section[data-status]` for a column, `article[aria-label]` for a card — never by a class,
// which the redesign is free to change.

function cardIn(page: Page, status: string, ticketId: string): Locator {
  return page.locator(`section[data-status="${status}"] article[aria-label="${ticketId}"]`);
}

/**
 * Where the ticket is, as the board draws it. Waits for the card to appear in the column it
 * should now be in, then checks it is nowhere else: each column renders its own list, so the
 * same id in two of them is a real bug rather than a loose locator.
 */
async function expectColumn(page: Page, ticketId: string, status: string, timeoutMs: number): Promise<void> {
  await cardIn(page, status, ticketId).waitFor({ state: "visible", timeout: timeoutMs });
  const total = await page.locator(`article[aria-label="${ticketId}"]`).count();
  if (total !== 1) {
    throw new Error(`card ${ticketId} appears ${total} times on the board, expected exactly 1`);
  }
  log(`board shows ${ticketId} in ${status}`);
}

/**
 * The id of the ticket the composer just created. The composer answers with nothing the DOM
 * spells out, so the store is asked — polled, not slept on, because `POST /tickets` has
 * already returned by the time the sheet closes and this is only waiting out the board read.
 */
async function ticketIdByTitle(board: Board, title: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const row = (await boardRows(board)).find((t) => t["title"] === title);
    if (row !== undefined) return stringField(row, "id");
    await delay(POLL_MS);
  }
  throw new Error(`no ticket titled ${JSON.stringify(title)} reached the store in ${timeoutMs}ms`);
}

/**
 * The agent's turn. The only genuinely long wait in the run, so it prints every ten seconds:
 * a terminal that has said nothing for four minutes is indistinguishable from a hung one.
 *
 * Fails fast on the two ways this ends without reaching review — the run dying, and a spawn
 * failure handing the claim back to `todo` — rather than spending the whole budget on a
 * ticket that is never going to move.
 */
async function waitForReview(board: Board, ticketId: string): Promise<void> {
  const from = Date.now();
  const deadline = from + TURN_MS;
  let lastPrinted = 0;
  while (Date.now() < deadline) {
    const row = await ticketRow(board, ticketId);
    const status = row["status"];
    if (status === "in_review") return;
    if (row["died"] === true && row["finished"] !== true) {
      throw new Error(`the run died before finishing: ${JSON.stringify(row)}`);
    }
    if (status !== "in_progress") {
      throw new Error(`ticket ${ticketId} left In Progress for ${JSON.stringify(status)}`);
    }
    if (Date.now() - lastPrinted >= PROGRESS_MS) {
      lastPrinted = Date.now();
      const agentStatus = row["agentStatus"];
      // `blocked` means Herdr is refusing prompts until a human answers in the pane
      // (memory/agent-status.md), and nothing here can answer it — so it is called out rather
      // than reported as ordinary progress.
      const note = agentStatus === "blocked" ? " — BLOCKED, answer it in Herdr" : "";
      log(`  agent working — ${clock(Date.now() - from)} into the turn (agentStatus=${String(agentStatus)})${note}`);
    }
    await delay(POLL_MS);
  }
  throw new Error(`the agent never reached In Review within ${TURN_MS}ms`);
}

// --- the run ----------------------------------------------------------------

/** Everything the teardown has to undo, filled in as the run gets to it, never guessed. */
type Run = {
  board: Board | null;
  clonePath: string | null;
  ticketId: string | null;
  browser: Browser | null;
};

async function flow(run: Run): Promise<void> {
  const clonePath = await step(`clone ${REPO_SLUG}`, async () => {
    // Registered on `run` before the clone, not after: a clone that fails halfway still left
    // a directory behind.
    const dir = await mkdtemp(join(tmpdir(), "10x-demo-clone-"));
    run.clonePath = dir;
    await git("git", ["clone", "-q", REPO_URL, dir]);
    await git("git", ["checkout", "-q", "dev"], { cwd: dir });
    return dir;
  });

  const board = await step("start the board on a throwaway port and state dir", async () => {
    const started = await startBoard();
    run.board = started;
    return started;
  });

  await step(`register project ${PROJECT_ID}`, () => createProject(board, PROJECT_ID, clonePath));

  const page = await step("open the board UI", async () => {
    const browser = await chromium.launch({ channel: "chromium", headless: HEADLESS });
    run.browser = browser;
    // Five columns need the width; the demo is watched on a desktop.
    const opened = await browser.newPage({ viewport: { width: 1680, height: 940 } });
    await opened.goto(board.baseUrl);
    // The header is the one `banner`, and `aria-label="Project"` is the only thing naming its
    // picker. Waiting for our option is what waits out the first projects read — an `option`
    // in a closed native select is attached but not "visible".
    const picker = opened.getByRole("banner").getByRole("combobox", { name: "Project" });
    await picker.getByRole("option", { name: PROJECT_NAME }).waitFor({ state: "attached", timeout: UI_MS });
    await picker.selectOption({ label: PROJECT_NAME });
    return opened;
  });

  const ticketId = await step("create the ticket through the composer", async () => {
    // Both Backlog and To Do carry a New ticket button; this is the Backlog one, and a ticket
    // is created in `backlog` either way.
    await page.locator('section[data-status="backlog"]').getByRole("button", { name: "New ticket" }).click();
    // Project first: it decides the repo, and the Add button stays disabled until one is
    // chosen. Selected explicitly rather than relying on the header picker's default, so this
    // step does not depend on the one before it.
    await page.locator("#c-project").selectOption({ label: PROJECT_NAME });
    await page.locator("#c-title").fill(TITLE);
    await page.locator("#c-desc").fill(PROBE_DESCRIPTION);
    // `click` waits for enabled, which is the composer's own guard being satisfied rather
    // than a sleep over it.
    await page.getByRole("button", { name: "Add", exact: true }).click();
    const id = await ticketIdByTitle(board, TITLE, UI_MS);
    run.ticketId = id;
    log(`ticket ${id} created`);
    return id;
  });

  await step("assert the new ticket is in Backlog", () => expectColumn(page, ticketId, "backlog", UI_MS));

  await step("promote it to To Do", async () => {
    await cardIn(page, "backlog", ticketId).getByRole("button", { name: "To Do" }).click();
    await expectColumn(page, ticketId, "todo", UI_MS);
  });

  await step("Start the agent", async () => {
    await cardIn(page, "todo", ticketId).getByRole("button", { name: "Start" }).click();
    // The click returns as soon as it lands; the POST behind it creates the worktree, the port
    // block and the agent, and the card only moves once that answered.
    await expectColumn(page, ticketId, "in_progress", SPAWN_MS);
  });

  await step("wait for the agent's turn to finish", async () => {
    await waitForReview(board, ticketId);
    await expectColumn(page, ticketId, "in_review", UI_MS);
  });

  await step("Accept it", async () => {
    await cardIn(page, "in_review", ticketId).getByRole("button", { name: "Accept" }).click();
    // Accept pushes and opens the PR before it answers, and hands the claim back to
    // `in_review` if either fails — so the card reaching Done IS the publish having worked.
    await expectColumn(page, ticketId, "done", ACCEPT_MS);
  });

  await step("assert the pull request is real", async () => {
    const row = await ticketRow(board, ticketId);
    const prUrl = stringField(row, "prUrl");
    if (!prUrl.includes(PR_URL_PREFIX)) {
      throw new Error(`prUrl ${prUrl} is not a pull request on ${REPO_SLUG}`);
    }
    if (typeof row["prNumber"] !== "number") {
      throw new Error(`prNumber is ${JSON.stringify(row["prNumber"])}, expected a number`);
    }
    // The stored row, not the API's: `GET /tickets` derives `branch` when the column is null,
    // so this is the only read that proves a run actually claimed one.
    const stored = storedTicket(board, ticketId);
    if (stored.status !== "done" || stored.branch === null) {
      throw new Error(`stored ticket is ${JSON.stringify(stored)}, expected done with a branch`);
    }
    log(`PR #${row["prNumber"]} open at ${prUrl} from branch ${stored.branch}`);
  });
}

// --- teardown ---------------------------------------------------------------

/**
 * One cleanup attempt. Every step below is independent and failure-tolerant on purpose: the
 * teardown runs from a `finally`, so it also runs on a half-finished run where some of these
 * have nothing to do — and one of them throwing must not skip the rest, which is how a
 * worktree, an agent or an open PR would get stranded.
 */
async function attempt(what: string, run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (err) {
    console.warn(`cleanup: ${what} failed — check for leftovers:`, err);
  }
}

/**
 * What the teardown needs off the ticket row, read while the row still exists: the PR to
 * close, the branch to delete, and the worktree folder to prune. Its own failure is absorbed
 * here — an unreadable row means the steps that need it are skipped, not that the rest of the
 * teardown is abandoned.
 */
type Residue = { branch: string | null; prNumber: number | null; worktreeParent: string | null };

const NO_RESIDUE: Residue = { branch: null, prNumber: null, worktreeParent: null };

async function readResidue(board: Board, ticketId: string): Promise<Residue> {
  try {
    const row = await ticketRow(board, ticketId);
    const worktreePath = row["worktreePath"];
    return {
      // The derived branch is what a never-spawned ticket reports too, which is harmless
      // here: deleting a ref that was never pushed answers 422 and changes nothing.
      branch: typeof row["branch"] === "string" ? row["branch"] : null,
      prNumber: typeof row["prNumber"] === "number" ? row["prNumber"] : null,
      worktreeParent: typeof worktreePath === "string" ? dirname(worktreePath) : null,
    };
  } catch (err) {
    console.warn(`cleanup: could not read ticket ${ticketId} — check for leftovers:`, err);
    return NO_RESIDUE;
  }
}

/**
 * Undoes the run, in dependency order, whatever state it got to:
 *
 * 1. the browser, so nothing is holding the board open;
 * 2. the ticket row is READ first — the PR number, the branch and the worktree path live on
 *    it, and step 4 deletes it;
 * 3. GitHub: the PR closed and the pushed branch deleted, which also unblocks step 4's
 *    `pr_open` guard;
 * 4. `DELETE /tickets/:id`, the product's own destructive teardown — agent stopped, pane
 *    closed, worktree force-removed, local branch deleted, transcript removed
 *    (memory/teardown.md). This is what a crash midway needs, and why it runs off the ticket
 *    id rather than off any bookkeeping the crash might have skipped;
 * 5. `cleanupAll()`, which stops the board and drops its state dir;
 * 6. the clone's source workspace, the clone, and the empty per-repo worktree folder Herdr
 *    leaves behind.
 */
async function teardown(run: Run): Promise<void> {
  log("cleanup ...");
  const board = run.board;
  const ticketId = run.ticketId;

  await attempt("closing the browser", async () => {
    if (run.browser !== null) await run.browser.close();
  });

  const { branch, prNumber, worktreeParent } =
    board !== null && ticketId !== null ? await readResidue(board, ticketId) : NO_RESIDUE;

  if (branch !== null) {
    await attempt(`closing PR/branch ${branch} on ${REPO_SLUG}`, () => closeGithubState(branch, prNumber));
  }

  if (board !== null && ticketId !== null) {
    await attempt(`deleting ticket ${ticketId}`, async () => {
      const res = await api(board, "DELETE", `/tickets/${encodeURIComponent(ticketId)}`);
      if (res.status !== 200) {
        throw new Error(`DELETE /tickets/${ticketId} answered ${res.status}: ${JSON.stringify(res.body)}`);
      }
    });
  }

  await attempt("stopping the board and dropping its state dir", () => cleanupAll());

  const clonePath = run.clonePath;
  if (clonePath !== null) {
    await attempt("closing the clone's source workspace", () => closeSourceWorkspace(clonePath));
    await attempt("removing the clone", () => rm(clonePath, { recursive: true, force: true }));
  }

  if (worktreeParent !== null) {
    // `rmdir` refuses a non-empty directory, which is the safety we want: a surviving
    // checkout has to be reported, never quietly deleted.
    await attempt(`pruning ${worktreeParent}`, () => rmdir(worktreeParent));
  }

  log("cleanup — done");
}

// --- entry point ------------------------------------------------------------

const run: Run = { board: null, clonePath: null, ticketId: null, browser: null };
let code = 0;

try {
  currentStep = "preflight";
  requireGithubToken();
  requireHerdr();
  await flow(run);
  log(`PASS — Backlog to Done in ${clock(Date.now() - startedAt)}`);
} catch (err) {
  console.error(`\nFAILED during: ${currentStep}\n`, err);
  code = 1;
} finally {
  await teardown(run);
}

/*
 * Explicit exit: the Herdr client and the board's piped stdio can leave handles behind, and a
 * demo that appears to hang after it has finished is exactly what this run exists to avoid.
 * The empty write's callback fires only once everything queued has flushed, so a piped stdout
 * keeps its last lines.
 */
process.stdout.write("", () => process.exit(code));
