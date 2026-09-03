/**
 * Records the full 10x lifecycle to a WebM: plan a ticket by talking to an agent,
 * promote it, let a second agent implement it, then accept and open a real PR.
 *
 * Two properties of this machine shape the whole script.
 *
 * Wayland refuses client-side window placement, so the browser cannot be tiled
 * beside the terminal and the two surfaces cannot share a frame. The browser is
 * closed for the conversation segment and relaunched afterwards, which reads as a
 * person switching applications.
 *
 * GNOME ties a screencast to the calling D-Bus connection, so `busctl call`
 * records for a second and then stops with "screencast ended unexpectedly".
 * scripts/screencast.py holds that connection open instead, and must be stopped
 * with SIGINT so the WebM trailer is flushed.
 *
 * Requires GITHUB_TOKEN with push access to asaadx/10x-test: Accept pushes a
 * branch and opens a pull request. Teardown is the caller's job — the script
 * leaves the ticket in place and prints its id, because deleting it would also
 * delete the evidence if the run needs inspecting.
 */

import { type ChildProcess, execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { type Browser, chromium, type Page } from "@playwright/test";

const exec = promisify(execFile);

const BOARD = "http://127.0.0.1:4030";
const PROJECT = "10x-test";
const OUT = process.argv[2] ?? "/home/asaad/GitHub/10x/demo.webm";
const SCREENCAST = "/home/asaad/GitHub/10x/scripts/screencast.py";

/** Long enough for a viewer to read what just changed before the next thing moves. */
const BEAT = 2200;

type ChecklistItem = { text: string; done: boolean };
type Ticket = {
  id: string;
  status: string;
  title: string;
  taskBreakdown: ChecklistItem[];
  acceptanceCriteria: ChecklistItem[];
  agentStatus: string | null;
  prUrl: string | null;
};

const beat = async (ms: number = BEAT): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  await promise;
};

const log = (msg: string): void => console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);

const herdr = async (args: string[]): Promise<string> =>
  (await exec("herdr", args, { maxBuffer: 32 * 1024 * 1024 })).stdout;

async function tickets(): Promise<Ticket[]> {
  const res = await fetch(`${BOARD}/tickets`);
  if (!res.ok) throw new Error(`GET /tickets -> ${res.status}`);
  const body = (await res.json()) as { tickets: Ticket[] };
  return body.tickets;
}

async function waitForTicket(pred: (t: Ticket) => boolean, budgetMs: number, what: string): Promise<Ticket> {
  const deadline = Date.now() + budgetMs;
  let last = "";
  while (Date.now() < deadline) {
    const all = await tickets();
    const found = all.find(pred);
    if (found) return found;
    const now = all[0];
    const state = now ? `${now.status}/${now.agentStatus ?? "-"}` : "no ticket";
    if (state !== last) {
      log(`  waiting for ${what} — currently ${state}`);
      last = state;
    }
    await beat(2000);
  }
  throw new Error(`timed out after ${budgetMs}ms waiting for ${what}`);
}

async function openBoard(): Promise<{ browser: Browser; page: Page }> {
  const browser = await chromium.launch({
    channel: "chromium",
    headless: false,
    args: ["--no-first-run", "--no-default-browser-check", "--hide-crash-restore-bubble", "--start-maximized"],
  });
  const ctx = await browser.newContext({ viewport: null, colorScheme: "dark" });
  const page = await ctx.newPage();
  await page.goto(BOARD, { waitUntil: "networkidle" });
  await page.waitForSelector('section[data-status="backlog"]');
  return { browser, page };
}

/**
 * Answers the planning agent as the human it is waiting on. The replies are
 * deliberately generic: the agent picks its own questions, so a scripted exchange
 * would desynchronise on the first surprise.
 */
const REPLIES = [
  "Yes. Keep it as small as possible — one new file, no dependencies, no tests, and nothing else touched.",
  "Acceptance is just that the file exists at the repo root with exactly that content, and git status is otherwise clean.",
  "That covers it. Please write the breakdown and acceptance criteria onto the ticket now.",
];

/**
 * Answers the planning agent by typing into its pane, and knows the difference
 * between the two kinds of turn it can end on.
 *
 * Typing rather than `agent prompt` is not a stylistic choice. `agent.prompt`
 * REFUSES a blocked agent — `agent_blocked`, and it sends nothing — and an agent
 * that has just asked a question is exactly what `blocked` means. The one moment
 * you most need to answer is the one moment prompt cannot. A keyboard always works.
 *
 * The second kind of turn is a structured `Ask`: a radio list with a recommended
 * option, drawn in a box. Typed prose does not answer it; it wants Enter. Sending
 * text at it looks like it worked and leaves the agent blocked forever.
 *
 * `herdr agent wait` with no --until already matches idle, done or blocked, which
 * is exactly "the agent stopped talking". --timeout is milliseconds.
 */
async function converse(agent: string, pane: string, ticketId: string): Promise<void> {
  for (let turn = 1; turn <= 6; turn++) {
    log(`  turn ${turn}: waiting for the agent to stop speaking`);
    await herdr(["agent", "wait", agent, "--timeout", "180000"]).catch((e: unknown) =>
      log(`  wait returned: ${String(e).slice(0, 120)}`),
    );
    await beat(3600); // let a viewer read the agent's message before the reply lands

    const done = (await tickets()).find((x) => x.id === ticketId);
    if (done && done.taskBreakdown.length > 0 && done.acceptanceCriteria.length > 0) {
      log(`  plan written: ${done.taskBreakdown.length} steps, ${done.acceptanceCriteria.length} criteria`);
      return;
    }

    const screen = await herdr(["pane", "read", pane]).catch(() => "");
    if (screen.includes("Enter select")) {
      log("  agent asked a structured question — taking the recommended option");
      await herdr(["pane", "send-keys", pane, "enter"]);
    } else {
      const reply = REPLIES[Math.min(turn, REPLIES.length) - 1] ?? REPLIES[REPLIES.length - 1]!;
      log(`  replying: ${reply.slice(0, 62)}…`);
      await herdr(["pane", "send-text", pane, reply]);
      await beat(800); // the typed line is on screen before it is submitted
      await herdr(["pane", "send-keys", pane, "enter"]);
    }
    await beat(1800);
  }
  log("  conversation budget spent; continuing with whatever the agent wrote");
}

/** The plan agent's pane, which `agent get` reports once the agent exists. */
async function paneOf(agent: string): Promise<string> {
  const raw = await herdr(["agent", "get", agent]);
  const parsed: unknown = JSON.parse(raw);
  const pane =
    typeof parsed === "object" && parsed !== null && "result" in parsed
      ? (parsed as { result?: { agent?: { pane_id?: unknown } } }).result?.agent?.pane_id
      : undefined;
  if (typeof pane !== "string") throw new Error(`could not read pane_id for ${agent}`);
  return pane;
}

async function startRecording(): Promise<ChildProcess> {
  // Crop the top strip. GNOME posts "Screencast ended unexpectedly" as an internal
  // MessageTray notification whenever a cast starts or stops, and it is not
  // reachable through the freedesktop Notifications API, so it cannot be dismissed
  // — only excluded. Losing the clock and the browser tab bar with it is a bonus.
  const cast = spawn("python3", [SCREENCAST, OUT, "30", "0", "150", "1920", "930"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  cast.stdout?.on("data", (b: Buffer) => {
    if (String(b).includes("RECORDING")) resolve();
  });
  cast.on("exit", (code) => reject(new Error(`screencast exited early with ${code}`)));
  setTimeout(() => reject(new Error("screencast did not report RECORDING within 15s")), 15_000);
  await promise;
  return cast;
}

async function run(): Promise<void> {
  if (!process.env["GITHUB_TOKEN"]) {
    throw new Error("GITHUB_TOKEN required: Accept pushes a branch and opens a PR on asaadx/10x-test");
  }

  let cast: ChildProcess | null = null;
  let browser: Browser | null = null;
  let ticketId: string | null = null;

  try {
    cast = await startRecording();
    log(`recording -> ${OUT}`);
    await beat(1600);

    // An empty board, and a ticket that is still only an idea.
    let opened = await openBoard();
    browser = opened.browser;
    await beat(2600);

    log("creating the ticket");
    await opened.page.click('section[data-status="backlog"] button:has-text("New ticket")');
    await opened.page.waitForSelector("#c-title");
    await beat(900);
    await opened.page.selectOption("#c-project", PROJECT).catch(() => undefined);
    await opened.page.click("#c-title");
    await opened.page.type("#c-title", "Add a probe file", { delay: 30 });
    await beat(600);
    await opened.page.click("#c-desc");
    await opened.page.type("#c-desc", "We need one tiny file committed, to prove the pipeline end to end.", { delay: 22 });
    await beat(1300);
    await opened.page.click('button:has-text("Add")');

    const created = await waitForTicket((t) => t.status === "backlog", 20_000, "the ticket to reach Backlog");
    ticketId = created.id;
    log(`created ${ticketId}`);
    await beat(2800);

    // Plan is a conversation, not a form.
    log("clicking Plan");
    await opened.page.click(`article[aria-label="${ticketId}"] button:has-text("Plan")`);
    const agent = `ticket-${PROJECT}-${ticketId.split("-").pop()}-plan`;
    await beat(4200);

    const pane = await paneOf(agent);
    log(`closing the browser so the ${agent} pane (${pane}) is visible`);
    await browser.close();
    browser = null;
    await beat(3600);

    await converse(agent, pane, ticketId);
    await beat(2600);

    // The plan is on the card; a human reads it and accepts it.
    log("reopening the board");
    opened = await openBoard();
    browser = opened.browser;
    await beat(2600);

    log("opening the ticket to show what the agent wrote");
    await opened.page.click(`article[aria-label="${ticketId}"]`);
    await beat(5200);
    await opened.page.keyboard.press("Escape");
    await beat(1800);

    log("promoting to To Do");
    await opened.page.click(`article[aria-label="${ticketId}"] button:has-text("To Do")`);
    await waitForTicket((t) => t.status === "todo", 20_000, "To Do");
    await beat(2600);

    // A second agent implements it in its own worktree.
    log("Start — spawning the implementation agent");
    await opened.page.click(`article[aria-label="${ticketId}"] button:has-text("Start")`);
    await waitForTicket((t) => t.status === "in_progress", 120_000, "In Progress");
    await beat(3200);

    log("waiting for the agent's turn to settle");
    await waitForTicket((t) => t.status === "in_review", 900_000, "In Review");
    await beat(3600);

    // Accept opens a real pull request.
    log("Accept — pushing the branch and opening the PR");
    await opened.page.click(`article[aria-label="${ticketId}"] button:has-text("Accept")`);
    const done = await waitForTicket((t) => t.status === "done" && t.prUrl !== null, 180_000, "Done with a PR");
    log(`done — ${done.prUrl}`);
    await beat(6500);
  } finally {
    if (browser) await browser.close().catch(() => undefined);
    if (cast) {
      log("stopping the recording");
      const { promise, resolve } = Promise.withResolvers<void>();
      cast.on("exit", () => resolve());
      cast.kill("SIGINT");
      await promise;
    }
    log(`ticket left in place for teardown: ${ticketId ?? "none"}`);
  }
}

await run();
