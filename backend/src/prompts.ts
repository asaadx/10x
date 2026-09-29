/**
 * Agent system prompts: read one from `prompts/` and fill in its `{{markers}}`.
 *
 * The prompts live outside `src/` because they are prose a human edits, not code — the same
 * reason `memory/` and `AGENTS.md` are not in a source tree. Nothing here is bundled or
 * compiled: the backend is run as `node backend/src/server.ts`, so `prompts/` is resolved
 * from `import.meta.dirname` exactly as `PUBLIC_DIR` resolves `frontend/dist` in server.ts.
 * A `process.cwd()`-relative path would work under `pnpm --filter @10x/backend dev` and
 * break for anyone starting the server from the repo root, which is how the e2e harness
 * starts it.
 *
 * Both checks in `renderPrompt` throw rather than degrade, because the failure they catch is
 * invisible: a prompt that still says "bind to port {{portStart}}" is a perfectly valid file
 * and a perfectly deliverable prompt, and the only thing that would ever notice is the agent
 * reading it. A renamed marker has to break the request, not the run.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ChecklistItem, Project, SessionKind, Ticket } from "./types.ts";

/** Prose, not source: a sibling of `backend/` and `frontend/`, resolved the same way. */
const PROMPT_DIR = join(import.meta.dirname, "..", "..", "prompts");

/** What a marker may be named. Anything else is a typo, and the leftover scan catches it. */
const MARKER = /\{\{(\w+)\}\}/g;
/** Deliberately laxer than `MARKER`, so `{{port-start}}` is reported instead of shipped. */
const ANY_MARKER = /\{\{[^}]*\}\}/g;

/**
 * Substitute `values` into `template`. `source` only names the file in errors.
 *
 * Pure, so the substitution rules are testable without a prompt file on disk.
 */
export function renderPrompt(
  template: string,
  values: Record<string, string | number>,
  source = "prompt",
): string {
  const markers = new Set(Array.from(template.matchAll(MARKER), (m) => m[1] as string));

  // Caught from this side because a renamed marker leaves the caller passing a key the
  // template no longer has — a substitution that silently does nothing, and the leftover
  // scan below would only report the marker it was meant to fill if the rename was partial.
  const unknown = Object.keys(values).filter((key) => !markers.has(key));
  if (unknown.length > 0) {
    throw new Error(`${source}: no {{marker}} for ${unknown.join(", ")}`);
  }

  const rendered = template.replace(MARKER, (whole, name: string) =>
    name in values ? String(values[name]) : whole,
  );

  const leftover = rendered.match(ANY_MARKER);
  if (leftover) {
    throw new Error(`${source}: unsubstituted ${Array.from(new Set(leftover)).join(", ")}`);
  }

  return rendered;
}

/** Read `prompts/<name>.md` and render it. */
export async function loadPrompt(
  name: string,
  values: Record<string, string | number>,
): Promise<string> {
  const file = join(PROMPT_DIR, `${name}.md`);
  return renderPrompt(await readFile(file, "utf8"), values, `prompts/${name}.md`);
}

/**
 * The branch an implementation session is told to push. `claude/`-prefixed because that is what
 * cloud sessions reliably push (docs/prototype-cloud.md); the agent still writes the branch it
 * ACTUALLY pushed into the row, so this is a request, not a derivation anything relies on.
 */
export const sessionBranchFor = (ticketId: string): string => `claude/10x-${ticketId}`;

/**
 * The ticket as it stands, as prose. Its first line is `10x ticket <id> — <title>`, which is
 * the one fixed shape in the message: the fake cloud driver reads the id back out of it
 * (cloud.ts `ticketIdFromMessage`), exactly as the real agent has only this text to go on.
 *
 * Empty fields are named as empty rather than omitted, so an agent handed a title-only ticket
 * goes straight to the description instead of asking about one it can see is blank.
 */
export function ticketBlock(ticket: Ticket): string {
  const checked = (item: ChecklistItem) => `- [${item.done ? "x" : " "}] ${item.text}`;
  return [
    `10x ticket ${ticket.id} — ${ticket.title}`,
    "",
    "Description:",
    ticket.description.trim() || "(empty)",
    "",
    `Playbook: ${ticket.playbook}`,
    "",
    "Task breakdown:",
    ticket.taskBreakdown.map(checked).join("\n") || "(empty)",
    "",
    "Acceptance criteria:",
    ticket.acceptanceCriteria.map(checked).join("\n") || "(empty)",
  ].join("\n");
}

/**
 * A cloud session's opening message: the ticket, then the rendered instructions, as ONE text.
 * `claude --cloud` has no system-prompt flag we rely on, so the instructions travel in the
 * message itself.
 *
 * Concatenated rather than substituted into a `{{ticket}}` marker on purpose: the ticket is
 * user-written text, and a description that happens to contain `{{something}}` would trip the
 * leftover-marker check in `renderPrompt` — refusing a spawn over the user's own prose. Only
 * the values this module controls go through the marker checks.
 */
export async function sessionMessage(kind: SessionKind, ticket: Ticket, project: Project): Promise<string> {
  const repo = `${project.owner}/${project.repo}`;
  const instructions =
    kind === "impl"
      ? await loadPrompt("implementation", {
          ticketId: ticket.id,
          branch: sessionBranchFor(ticket.id),
          baseBranch: project.baseBranch,
          repo,
        })
      : await loadPrompt("plan", { ticketId: ticket.id, repo });
  return `${ticketBlock(ticket)}\n\n---\n\n${instructions}`;
}
