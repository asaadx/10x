/**
 * Tests for prompt rendering.
 *
 * Both throws are the reason this module exists, so both are pinned. An unfilled marker is a
 * perfectly valid file and a perfectly deliverable prompt — the only reader that would ever
 * notice is the agent being told to bind to a port called `{{portStart}}` — and a supplied key
 * that matches nothing is the same rename seen from the caller's side.
 *
 * `loadPrompt` is exercised against the real `prompts/` directory too: the whole point of
 * resolving it from `import.meta.dirname` is that it works whatever the cwd is, and `node
 * --test` runs from `backend/`.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { loadPrompt, renderPrompt, sessionBranchFor, sessionMessage } from "./prompts.ts";
import { ticketIdFromMessage } from "./cloud.ts";
import type { Project, Ticket } from "./types.ts";

describe("renderPrompt", () => {
  test("fills every occurrence of a marker and leaves the rest untouched", () => {
    assert.equal(
      renderPrompt("ports {{start}}-{{end}}, PORT={{start}}\n", { start: 4110, end: 4119 }),
      "ports 4110-4119, PORT=4110\n",
    );
  });

  test("a template with no markers and no values renders itself", () => {
    assert.equal(renderPrompt("just prose\n", {}), "just prose\n");
  });

  test("an unsubstituted marker throws, naming the file and the marker", () => {
    assert.throws(
      () => renderPrompt("PORT={{portStart}}\n", {}, "prompts/implementation.md"),
      /prompts\/implementation\.md: unsubstituted \{\{portStart\}\}/,
    );
  });

  test("a marker misspelled out of the accepted shape still throws", () => {
    // `{{port-start}}` is not a name any caller can pass, so substitution cannot reach it and
    // only the laxer leftover scan sees it — which is the whole reason that scan is laxer.
    assert.throws(() => renderPrompt("PORT={{port-start}}\n", {}), /unsubstituted \{\{port-start\}\}/);
  });

  test("a supplied key that matches no marker throws", () => {
    assert.throws(() => renderPrompt("PORT={{portStart}}\n", { portstart: 4110 }), /no \{\{marker\}\} for portstart/);
  });
});

describe("loadPrompt", () => {
  test("the implementation prompt renders with the keys sessionMessage passes", async () => {
    const rendered = await loadPrompt("implementation", {
      ticketId: "demo-3",
      branch: "claude/10x-demo-3",
      baseBranch: "dev",
      repo: "acme/demo",
    });
    assert.ok(rendered.includes("acme/demo"));
    assert.ok(rendered.includes("claude/10x-demo-3"));
    assert.ok(rendered.includes("gh pr create --draft --base dev"));
    assert.ok(rendered.includes("tenx_sql()"));
    assert.ok(!rendered.includes("{{"));
    // The Herdr-era port block must not come back: a cloud session owns its whole container.
    assert.ok(!/PORT_RANGE_START|port block/i.test(rendered));
  });

  test("the plan prompt renders with the keys the plan route passes", async () => {
    const rendered = await loadPrompt("plan", { ticketId: "demo-3", repo: "acme/demo" });
    assert.ok(rendered.includes("tenx_state done"));
    assert.ok(rendered.includes("demo-3"));
    assert.ok(!rendered.includes("{{"));
  });

  test("loading a real prompt with nothing to fill it throws rather than shipping the marker", async () => {
    await assert.rejects(loadPrompt("implementation", {}), /prompts\/implementation\.md: unsubstituted/);
  });
});

const ticket: Ticket = {
  id: "demo-3",
  projectId: "demo",
  number: 3,
  title: "Add a {{button}}",
  description: "Users keep asking for {{it}}.",
  status: "todo",
  finished: false,
  died: false,
  archived: false,
  branch: null,
  agentName: null,
  sessionDir: null,
  prNumber: null,
  prUrl: null,
  prState: null,
  prAdditions: null,
  prDeletions: null,
  playbook: "Frontend",
  priority: "low",
  taskBreakdown: [
    { text: "Draw it", done: true },
    { text: "Wire it", done: false },
  ],
  acceptanceCriteria: [],
  attachments: [],
  screenshots: { before: null, after: null },
  startedAt: null,
  sessionId: null,
  sessionUrl: null,
  sessionKind: null,
  agentState: null,
  agentNote: null,
  agentUpdatedAt: null,
  createdAt: "2026-09-29T00:00:00.000Z",
  updatedAt: "2026-09-29T00:00:00.000Z",
};

const project = { owner: "acme", repo: "demo", baseBranch: "dev" } as Project;

describe("sessionMessage", () => {
  test("opens with the id line the fake driver reads, then the ticket, then the instructions", async () => {
    const message = await sessionMessage("impl", ticket, project);
    assert.equal(ticketIdFromMessage(message), "demo-3");
    assert.ok(message.startsWith("10x ticket demo-3 — Add a {{button}}\n"));
    assert.ok(message.includes("- [x] Draw it\n- [ ] Wire it"));
    assert.ok(message.includes("Acceptance criteria:\n(empty)"));
    assert.ok(message.includes(sessionBranchFor("demo-3")));
  });

  test("marker-shaped text in the user's own ticket does not trip the leftover check", async () => {
    // It would, if the ticket were substituted into the template rather than concatenated.
    const message = await sessionMessage("plan", ticket, project);
    assert.ok(message.includes("Users keep asking for {{it}}."));
  });

  test("a plan message names no branch, so the fake plays a planner", async () => {
    const message = await sessionMessage("plan", ticket, project);
    assert.ok(!message.includes("claude/10x-"));
  });
});
