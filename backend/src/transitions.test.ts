/**
 * Tests for the legal-transitions table. It is pure data plus three lookups, so the cases that
 * matter are the refusals: `POST /tickets/:id/status` is the one route that will write any
 * status it is handed, and this table is the only thing stopping it from writing
 * `in_progress` onto a ticket with no worktree, no branch, no port block and no agent
 * (memory/operations.md).
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { Status } from "./types.ts";
import {
  STATUSES,
  TRANSITIONS,
  isPureStatusWrite,
  isTransitionStatus,
  planStatusMove,
  transitionFor,
  type TransitionStatus,
} from "./transitions.ts";

/** True only when the two unions accept exactly each other, in both directions. */
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

describe("the table", () => {
  /*
   * transitions.ts restates the `Status` union rather than importing it, so that it stays as
   * import-free as types.ts. This is the tripwire that makes the restatement safe: adding a
   * status on one side and not the other turns `Exact` into `false`, and `pnpm typecheck`
   * fails on the assignment below. The runtime assertion is incidental.
   */
  test("the restated status union still matches types.ts", () => {
    const sameUnion: Exact<TransitionStatus, Status> = true;
    assert.equal(sameUnion, true);
  });

  test("no pair is listed twice", () => {
    const pairs = TRANSITIONS.map((t) => `${t.from}->${t.to}`);
    assert.deepEqual([...new Set(pairs)], pairs);
  });

  // A status missing from the table entirely is a column nothing can enter or leave, which is
  // a dead card rather than a compile error.
  test("every status appears in the machine", () => {
    const mentioned = new Set(TRANSITIONS.flatMap((t) => [t.from, t.to]));
    assert.deepEqual([...STATUSES].filter((s) => !mentioned.has(s)), []);
  });

  test("done is terminal — delete only", () => {
    assert.deepEqual(TRANSITIONS.filter((t) => t.from === "done"), []);
  });
});

describe("isTransitionStatus", () => {
  for (const status of STATUSES) {
    test(`${status} is a status`, () => {
      assert.equal(isTransitionStatus(status), true);
    });
  }

  // The body of a `/status` request is untrusted JSON, and `toStatus` in db.ts is the wrong
  // tool for it: that one decodes anything it does not recognise as `backlog`, which is right
  // for a stored row and would silently teleport a ticket if used on input.
  for (const junk of ["Backlog", "in progress", "", null, undefined, 3, ["todo"], { to: "todo" }]) {
    test(`${JSON.stringify(junk) ?? "undefined"} is not a status`, () => {
      assert.equal(isTransitionStatus(junk), false);
    });
  }
});

describe("planStatusMove", () => {
  test("accepting a plan is a pure status write and is allowed", () => {
    const plan = planStatusMove("backlog", "todo");
    assert.equal(plan.ok, true);
    assert.equal(isPureStatusWrite("backlog", "todo"), true);
  });

  test("sending a ticket back to be re-planned is allowed too", () => {
    assert.equal(planStatusMove("todo", "backlog").ok, true);
    assert.equal(isPureStatusWrite("todo", "backlog"), true);
  });

  // The load-bearing refusal. Without it a caller reaches In Progress without spawning
  // anything, and the board renders a running card that owns no resources at all.
  test("a move to in_progress is refused and told to use /spawn", () => {
    const plan = planStatusMove("todo", "in_progress");
    assert.equal(plan.ok, false);
    if (plan.ok) return;
    assert.equal(plan.error, "transition_has_side_effects");
    assert.equal(plan.owner, "POST /tickets/:id/spawn");
    assert.match(plan.message, /\/spawn/);
    assert.equal(isPureStatusWrite("todo", "in_progress"), false);
  });

  test("each side-effecting move names the route that owns it", () => {
    const owners = [
      ["in_progress", "todo", "POST /tickets/:id/cancel"],
      ["in_review", "done", "POST /tickets/:id/accept"],
      ["in_review", "in_progress", "POST /tickets/:id/reject"],
    ] as const;
    for (const [from, to, owner] of owners) {
      const plan = planStatusMove(from, to);
      assert.equal(plan.ok, false);
      if (plan.ok) continue;
      assert.equal(plan.error, "transition_has_side_effects");
      assert.equal(plan.owner, owner);
    }
  });

  // Legal, but nobody asks for it: it fires from the agent-status callback when a turn
  // settles. A caller who could request it would be claiming a turn had ended.
  test("the automatic move into review is refused as well", () => {
    const plan = planStatusMove("in_progress", "in_review");
    assert.equal(plan.ok, false);
    if (plan.ok) return;
    assert.equal(plan.error, "transition_has_side_effects");
    assert.equal(plan.owner, "the agent poller");
  });

  /*
   * A different mistake from the one above, and worth its own code: no route will ever accept
   * these, so telling the caller to go and use one would be a lie. `backlog → in_progress` is
   * the interesting one — it is what Start did before To Do became the ready column.
   */
  test("a pair the machine does not have is illegal rather than misrouted", () => {
    for (const [from, to] of [
      ["backlog", "in_progress"],
      ["backlog", "done"],
      ["todo", "in_review"],
      ["done", "todo"],
      ["in_review", "backlog"],
    ] as const) {
      const plan = planStatusMove(from, to);
      assert.equal(plan.ok, false);
      if (plan.ok) continue;
      assert.equal(plan.error, "illegal_transition", `${from} -> ${to}`);
      assert.equal(plan.owner, undefined);
      assert.equal(isPureStatusWrite(from, to), false);
    }
  });

  test("a status cannot be moved to itself", () => {
    for (const status of STATUSES) {
      assert.equal(transitionFor(status, status), undefined);
      assert.equal(planStatusMove(status, status).ok, false);
    }
  });
});
