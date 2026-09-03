/**
 * Tests for the pure lifecycle helpers. Every case here maps to a bug that actually
 * happened (or a ceiling that actually bit), recorded in memory/herdr-omp-lifecycle.md.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  AGENT_NAME_RE,
  PROJECT_SLUG_RE,
  agentNameFor,
  branchFor,
  isAgentReady,
  isPlanAgentName,
  isSettled,
  normalizeEvent,
  planAgentNameFor,
  validateProjectSlug,
} from "./lifecycle.ts";

describe("normalizeEvent", () => {
  // Herdr emits `pane.agent_status_changed` DOTTED but `pane_closed` UNDERSCORED, while the
  // schema declares both underscored (memory/socket.md). An exact match on either form silently drops half
  // the stream with no error — the run that cost this project its status pipeline.
  for (const name of ["pane_agent_status_changed", "pane_closed", "pane_exited"]) {
    const dotted = name.replace("pane_", "pane.");
    test(`${dotted} and ${name} collapse to ${name}`, () => {
      assert.equal(normalizeEvent(dotted), name);
      assert.equal(normalizeEvent(name), name);
      assert.equal(normalizeEvent(dotted), normalizeEvent(name));
    });
  }

  test("normalizing is idempotent", () => {
    const once = normalizeEvent("pane.agent_status_changed");
    assert.equal(normalizeEvent(once), once);
  });
});

describe("isAgentReady", () => {
  // `done` is the same underlying ready state as `idle`, reached while the tab was unseen
  // (memory/agent-status.md). Every re-attached agent reports `done`, so accepting only `idle` broke agent
  // reuse 100% of the time and hung for the full readiness timeout.
  test("idle + interactive_ready is ready", () => {
    assert.equal(isAgentReady({ agent_status: "idle", interactive_ready: true }), true);
  });

  test("done + interactive_ready is ready — same state as idle", () => {
    assert.equal(isAgentReady({ agent_status: "done", interactive_ready: true }), true);
  });

  // `interactive_ready` is the tell for a premature `agent.start` return: true on a real
  // start, absent when premature (memory/spawn.md). A settled status alone proves nothing.
  for (const status of ["idle", "done"]) {
    test(`${status} with interactive_ready false is not ready`, () => {
      assert.equal(isAgentReady({ agent_status: status, interactive_ready: false }), false);
    });

    test(`${status} with interactive_ready absent is not ready`, () => {
      assert.equal(isAgentReady({ agent_status: status }), false);
    });
  }

  for (const status of ["working", "blocked", "unknown"]) {
    test(`${status} is never ready, even with interactive_ready`, () => {
      assert.equal(isAgentReady({ agent_status: status, interactive_ready: true }), false);
    });
  }

  test("undefined agent is not ready", () => {
    assert.equal(isAgentReady(undefined), false);
  });

  test("empty agent record is not ready", () => {
    assert.equal(isAgentReady({}), false);
  });
});

describe("isSettled", () => {
  for (const status of ["idle", "done"]) {
    test(`${status} is settled`, () => assert.equal(isSettled(status), true));
  }
  // `unknown` means "an agent is present but unclassified" — it never proves completion (memory/agent-status.md).
  for (const status of ["working", "blocked", "unknown"]) {
    test(`${status} is not settled`, () => assert.equal(isSettled(status), false));
  }
});

describe("branchFor / agentNameFor", () => {
  test("both derive from project and number", () => {
    assert.equal(branchFor("10x", 7), "ticket/10x/7");
    assert.equal(agentNameFor("10x", 7), "ticket-10x-7");
  });

  // memory/naming.md, the highest-risk trap: Herdr derives the worktree DIRECTORY from the branch by
  // lowercasing and replacing `/` with `-`. The two helpers are aligned on purpose so that
  // worktree dir and agent name are the same string; if they drift, reuse, teardown and
  // dispatch all break at once.
  test("branch lowercased with / -> - is exactly the agent name", () => {
    for (const [project, number] of [
      ["10x", 7],
      ["a", 1],
      ["my-app", 42],
      ["x".repeat(20), 1234],
    ] as const) {
      assert.equal(
        branchFor(project, number).replaceAll("/", "-").toLowerCase(),
        agentNameFor(project, number),
      );
    }
  });
});

describe("agent name budget", () => {
  // `ticket-` costs 7 and the separator 1, leaving 24 of the 32-char ceiling for
  // slug + number. 20 + 4 is exactly 24 — the reason validateProjectSlug caps at 20.
  test("20-char slug with a 4-digit number lands exactly on the 32-char ceiling", () => {
    const name = agentNameFor("a".repeat(20), 1234);
    assert.equal(name.length, 32);
    assert.match(name, AGENT_NAME_RE);
  });

  test("25-char slug blows the ceiling — why the cap is 20, not longer", () => {
    const name = agentNameFor("a".repeat(25), 1234);
    assert.ok(name.length > 32, `expected over 32 chars, got ${name.length}`);
    assert.doesNotMatch(name, AGENT_NAME_RE);
  });
});

describe("planAgentNameFor / isPlanAgentName", () => {
  test("a planner's name is the ticket's agent name plus -plan", () => {
    assert.equal(planAgentNameFor("10x", 7), "ticket-10x-7-plan");
  });

  // The whole point of the suffix: `runner.ts` catches `agent_name_taken` and re-attaches
  // silently, so a shared name would make Start adopt the planner and leave a ticket reading
  // In Progress with no worktree, no branch and no instruction — and no error anywhere.
  test("it can never collide with the implementation agent's name", () => {
    for (const [project, number] of [
      ["10x", 7],
      ["a", 1],
      ["my-app", 42],
    ] as const) {
      assert.notEqual(planAgentNameFor(project, number), agentNameFor(project, number));
    }
  });

  // The suffix costs 5 of the 32, so the slug budget for a PLANNABLE ticket is 19 -
  // len(number), not the 24 `agentNameFor` alone allows. `startPlanning` tests the result
  // against AGENT_NAME_RE for exactly this case rather than letting Herdr refuse it after a
  // workspace already exists.
  test("a slug at the 20-char cap overflows the ceiling once -plan is added", () => {
    assert.match(agentNameFor("a".repeat(20), 1234), AGENT_NAME_RE);
    assert.doesNotMatch(planAgentNameFor("a".repeat(20), 1234), AGENT_NAME_RE);
    assert.match(planAgentNameFor("a".repeat(15), 1234), AGENT_NAME_RE);
  });

  test("only the shape planAgentNameFor produces is recognised as a planner", () => {
    assert.equal(isPlanAgentName(planAgentNameFor("10x", 7)), true);
    assert.equal(isPlanAgentName(planAgentNameFor("my-app", 1234)), true);
    // The sweep CLOSES what it matches, so a human's workspace label must never match.
    for (const label of ["refactor-plan", "10x", "ticket-10x-7", "plan", "ticket-10x-plan"]) {
      assert.equal(isPlanAgentName(label), false, label);
    }
  });
});

describe("validateProjectSlug", () => {
  // A LEADING DIGIT IS LEGAL. Herdr requires an agent name to start with a letter, but
  // `agentNameFor` always prefixes `ticket-`, so that letter is already guaranteed and the
  // slug needs no such rule. Verified by Main on all three legs before the regex was
  // relaxed: `git check-ref-format --branch ticket/10x/1` passes, `ticket-10x-7` matches
  // AGENT_NAME_RE, and a real worktree was created on that branch. The old leading-letter
  // rule rejected `10x` — this project's own name — for nothing.
  const accepted = ["10x", "target", "a", "my-app", "9lives", "a".repeat(20)];

  for (const slug of accepted) {
    test(`accepts ${JSON.stringify(slug)}`, () => {
      assert.deepEqual(validateProjectSlug(slug), { ok: true });
    });
  }

  const rejected: Array<[string, string]> = [
    ["", "empty is not a slug"],
    ["a".repeat(21), "21 chars overruns the 20-char budget"],
    ["My-App", "uppercase would survive the branch but not the agent name"],
    // The valuable trap: dots are legal in git branches and illegal in Herdr agent names,
    // so a dotted slug yields a valid branch and an invalid agent name — failing only at
    // spawn time, after the worktree already exists.
    ["my.app", "dot is branch-legal but agent-name-illegal"],
    // AGENT_NAME_RE permits `_`; the slug rule does not. Legal in both, excluded anyway to
    // keep `-` as the one canonical separator.
    ["my_app", "underscore excluded to keep a single separator"],
    ["-x", "leading hyphen"],
  ];

  for (const [slug, why] of rejected) {
    test(`rejects ${JSON.stringify(slug)} — ${why}`, () => {
      const result = validateProjectSlug(slug);
      assert.equal(result.ok, false);
      assert.ok(!result.ok && result.message.length > 0, "rejection must explain itself");
    });
  }

  test("a dotted slug really would produce a valid branch and an invalid agent name", () => {
    assert.equal(branchFor("my.app", 1), "ticket/my.app/1");
    assert.doesNotMatch(agentNameFor("my.app", 1), AGENT_NAME_RE);
  });

  // The invariant that licenses the relaxed rule: whatever the slug, the `ticket-` prefix
  // supplies the leading letter. Drop the prefix and every digit-leading slug breaks spawn.
  test("every accepted slug yields an agent name Herdr accepts", () => {
    for (const slug of accepted) {
      assert.ok(PROJECT_SLUG_RE.test(slug), `${slug} should match PROJECT_SLUG_RE`);
      assert.match(agentNameFor(slug, 1234), AGENT_NAME_RE);
    }
  });

  test("digit-leading slugs are only safe because of the ticket- prefix", () => {
    assert.match(agentNameFor("10x", 7), AGENT_NAME_RE);
    assert.doesNotMatch("10x-7", AGENT_NAME_RE);
  });
});
