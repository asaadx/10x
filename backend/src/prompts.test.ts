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
import { loadPrompt, renderPrompt } from "./prompts.ts";

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
  test("the implementation prompt renders with the keys the runner passes", async () => {
    const rendered = await loadPrompt("implementation", { portStart: 4110, portEnd: 4119 });
    assert.ok(rendered.includes("TCP ports 4110-4119"));
    assert.ok(rendered.includes("PORT=4110"));
    assert.ok(!rendered.includes("{{"));
  });

  test("the plan prompt renders with the keys the plan route passes", async () => {
    const rendered = await loadPrompt("plan", { apiUrl: "http://localhost:4010", ticketId: "demo-3" });
    assert.ok(rendered.includes("PATCH http://localhost:4010/tickets/demo-3"));
    assert.ok(!rendered.includes("{{"));
  });

  test("loading a real prompt with nothing to fill it throws rather than shipping the marker", async () => {
    await assert.rejects(loadPrompt("implementation", {}), /prompts\/implementation\.md: unsubstituted/);
  });
});
