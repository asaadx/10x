import { PLAYBOOKS, PRIORITIES, type Playbook, type Priority } from "@/types.ts";

/**
 * A new ticket's composer is local-only state until Add — `POST /tickets` is the only write —
 * so an accidental Escape or backdrop click used to throw away everything typed. This module is
 * the persistence for that: one draft per project scope, written by `TicketSheet` on every
 * create-mode field change while the sheet is open, read back the next time "New ticket" opens
 * from the same scope, and cleared on Cancel or a successful Add. This file owns only the
 * storage shape and the read/write/clear operations; `TicketSheet` decides when to call them.
 */

export type ChecklistRowDraft = { text: string; done: boolean };

export type NewTicketDraft = {
  projectId: string;
  playbook: Playbook;
  priority: Priority;
  title: string;
  description: string;
  taskBreakdown: ChecklistRowDraft[];
  acceptanceCriteria: ChecklistRowDraft[];
};

const KEY_PREFIX = "10x.new-ticket-draft.";

// Callers pass `defaultProjectId` straight from `App.tsx`, which already collapses the project
// picker's `ALL_PROJECTS` sentinel (`lib/board.ts`) down to "" — the same value the Project
// `<select>` uses for its own unselected placeholder, and a value no real project id can ever
// be, since a project id is a slug. That makes "" safe to branch on here, but the All-projects
// draft is still keyed under its own name rather than the bare empty string, so a key seen in
// devtools reads as a scope instead of as an accident.
const ALL_PROJECTS_SCOPE = "all-projects";

// Shared by all three operations below, which must agree on exactly one storage key per scope.
function keyFor(scopeProjectId: string): string {
  return KEY_PREFIX + (scopeProjectId === "" ? ALL_PROJECTS_SCOPE : scopeProjectId);
}

// Type guard, not a rename: it is what lets `isDraft` narrow an `unknown` array element without
// an inline cast.
function isChecklistRowDraft(value: unknown): value is ChecklistRowDraft {
  return (
    typeof value === "object" &&
    value !== null &&
    "text" in value &&
    "done" in value &&
    typeof value.text === "string" &&
    typeof value.done === "boolean"
  );
}

// Validated field-by-field rather than trusted as-is: this is `JSON.parse` output from a store a
// user (or a browser extension, or a stale schema from a previous build) can write anything
// into, and a malformed draft silently corrupting a real create is worse than falling back to
// today's defaults.
function isDraft(value: unknown): value is NewTicketDraft {
  if (typeof value !== "object" || value === null) return false;
  if (
    !("projectId" in value) ||
    !("title" in value) ||
    !("description" in value) ||
    !("playbook" in value) ||
    !("priority" in value) ||
    !("taskBreakdown" in value) ||
    !("acceptanceCriteria" in value)
  ) {
    return false;
  }
  return (
    typeof value.projectId === "string" &&
    typeof value.title === "string" &&
    typeof value.description === "string" &&
    PLAYBOOKS.some((playbook) => playbook === value.playbook) &&
    PRIORITIES.some((priority) => priority === value.priority) &&
    Array.isArray(value.taskBreakdown) &&
    value.taskBreakdown.every(isChecklistRowDraft) &&
    Array.isArray(value.acceptanceCriteria) &&
    value.acceptanceCriteria.every(isChecklistRowDraft)
  );
}

/** The stored draft for this scope, or null if there is none, or it fails to parse or validate. */
export function readNewTicketDraft(scopeProjectId: string): NewTicketDraft | null {
  const raw = localStorage.getItem(keyFor(scopeProjectId));
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isDraft(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function writeNewTicketDraft(scopeProjectId: string, draft: NewTicketDraft): void {
  localStorage.setItem(keyFor(scopeProjectId), JSON.stringify(draft));
}

export function clearNewTicketDraft(scopeProjectId: string): void {
  localStorage.removeItem(keyFor(scopeProjectId));
}
