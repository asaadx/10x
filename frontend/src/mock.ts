import type { Project, Ticket } from "@/types.ts";

/**
 * Fixtures for `VITE_MOCK_MODE=true`, typed against the real `GET /tickets` shape so they cannot
 * drift from it.
 *
 * Chosen to cover every visual state the board can reach rather than to look tidy. Agent states
 * (all self-reported by the cloud agent, docs/prototype-cloud.md): a session just started, a
 * working agent, a blocked agent with its question in `agentNote`, a finished run awaiting
 * review, and one that reported `failed`. Sessions: a planning session open on a Backlog ticket
 * and implementation sessions everywhere past To Do, plus one In Progress ticket whose session
 * link is missing (the disabled Steer). Previews: one running with a dev command, one checked
 * out on a project with no dev command, and one whose dev command exited. PRs: merged,
 * closed-unmerged, and open still awaiting review. Plus an empty description next to a title
 * long enough to truncate, a description long enough for the single-line clamp to matter, a
 * second project with tickets of its own so the project filter has something to prove, and
 * spread across playbooks and priorities.
 *
 * Projects cover provisioning as well as tickets: two ready, one still downloading, and one that
 * failed with a re-link message. The failed one keeps a Done ticket with an open pull request,
 * because deleting a broken project is exactly the moment the open-PR guard has to refuse.
 */

const iso = (daysAgo: number, hour = 9) =>
  new Date(Date.UTC(2026, 7, 31 - daysAgo, hour, 0, 0)).toISOString();

/** Minutes before now, for `agentUpdatedAt` — so "3m ago" reads as fresh on any day. */
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

/** A claude.ai session link in the shape `claude --cloud` prints. */
const session = (id: string) => ({ sessionId: id, sessionUrl: `https://claude.ai/code/${id}` });

/**
 * A complete ticket rather than a `Partial`, so the shared defaults are checked against the
 * real type once instead of failing at every spread site. Every fixture overrides
 * its identity fields.
 */
const base: Ticket = {
  id: "",
  projectId: "10x",
  number: 0,
  title: "",
  description: "",
  status: "backlog",
  // Null until the agent reports the branch it actually pushed.
  branch: null,
  // Herdr-era columns the backend still carries for migration safety; the board reads none.
  agentName: null,
  sessionDir: null,
  finished: false,
  died: false,
  screenshots: { before: null, after: null },
  archived: false,
  busy: false,
  startedAt: null,
  // No cloud session until Plan or Start creates one; the agent fills agentState/agentNote.
  sessionId: null,
  sessionUrl: null,
  sessionKind: null,
  agentState: null,
  agentNote: null,
  agentUpdatedAt: null,
  preview: null,
  // Never null: the column is NOT NULL with this exact default (see the backend's db.ts), and
  // it is the option the sheet's picker shows first.
  playbook: "Fullstack",
  priority: "low",
  // Empty until a Plan agent (or a human) fills them in; the columns default to '[]', never null.
  taskBreakdown: [],
  acceptanceCriteria: [],
  attachments: [],
  prNumber: null,
  prUrl: null,
  prState: null,
  prAdditions: null,
  prDeletions: null,
  createdAt: iso(0),
  updatedAt: iso(0),
};

export const MOCK_PROJECTS: Project[] = [
  {
    id: "10x",
    name: "10x",
    description: "The board that spawns these agents. Dogfooding target.",
    owner: "asaadx",
    repo: "10x",
    // Deliberately NOT under $PROJECTS_ROOT: this is the pre-existing project, whose folder is
    // the user's own checkout. It is what covers the delete dialog's "left alone" branch.
    repoPath: "/home/asaad/GitHub/10x",
    ownsClone: false,
    baseBranch: "dev",
    provisionState: "ready",
    provisionError: "",
    devCommand: "pnpm dev:web --port $PORT",
    createdAt: iso(30),
    updatedAt: iso(30),
  },
  {
    id: "10x-test",
    name: "10x-test",
    description: "Throwaway target repo the e2e suite spawns real agents against.",
    owner: "asaadx",
    repo: "10x-test",
    repoPath: "/home/asaad/.10x/repos/10x-test",
    ownsClone: true,
    baseBranch: "master",
    provisionState: "ready",
    provisionError: "",
    // No dev command: Preview only checks the branch out, which is the hint path.
    devCommand: "",
    createdAt: iso(20),
    updatedAt: iso(20),
  },
  {
    id: "hearth-home",
    name: "Hearth Home",
    description: "Home automation dashboard. Added from a paste and still coming down the wire.",
    owner: "asaadx",
    repo: "hearth-home",
    repoPath: "/home/asaad/.10x/repos/hearth-home",
    ownsClone: true,
    baseBranch: "main",
    provisionState: "cloning",
    provisionError: "",
    devCommand: "",
    createdAt: iso(0, 8),
    updatedAt: iso(0, 8),
  },
  {
    id: "jarvis",
    name: "Jarvis",
    description: "Voice assistant. Its remote moved, so nothing here can be started until it is re-linked.",
    owner: "asaadx",
    repo: "jarvis",
    repoPath: "/home/asaad/.10x/repos/jarvis",
    ownsClone: true,
    baseBranch: "main",
    provisionState: "failed",
    provisionError:
      "Clone failed: repository asaadx/jarvis not found. It may have been renamed, made private or deleted — re-link the project to its current URL.",
    devCommand: "",
    createdAt: iso(14),
    updatedAt: iso(0, 7),
  },
];

export const MOCK_TICKETS: Ticket[] = [
  {
    ...base,
    id: "10x-8",
    number: 8,
    title: "Hide old Done tickets behind a filter",
    description: "Done grows without bound. An `archived` flag and a toggle, not a sixth column.",
    status: "backlog",
    playbook: "Frontend",
    // A planning session is open and the planner is talking it through with the human.
    ...session("session_01PlanHideDone"),
    sessionKind: "plan",
    agentState: "working",
    agentNote: "Reading the board's Done column code; will propose a toggle in the toolbar.",
    agentUpdatedAt: minutesAgo(2),
    createdAt: iso(0, 11),
    updatedAt: iso(0, 11),
  },
  {
    ...base,
    id: "10x-7",
    number: 7,
    title: "Add a keyboard shortcut for the composer",
    description: "Cmd+N should open the New ticket drawer from anywhere on the board.",
    status: "backlog",
    playbook: "Frontend",
    // The planner finished: both checklists are filled, so To Do becomes the primary action.
    ...session("session_01PlanShortcut"),
    sessionKind: "plan",
    agentState: "done",
    agentNote: "Plan written: bind Cmd/Ctrl+N globally, skip when an input has focus, open the composer in Backlog.",
    agentUpdatedAt: minutesAgo(40),
    taskBreakdown: [
      { text: "Add a window keydown listener for Cmd/Ctrl+N", done: false },
      { text: "Ignore it while an input, textarea or dialog has focus", done: false },
    ],
    acceptanceCriteria: [{ text: "Cmd+N opens the New ticket sheet from any column", done: false }],
    createdAt: iso(0),
    updatedAt: iso(0),
  },
  {
    ...base,
    id: "10x-6",
    number: 6,
    title: "Reject should preserve the previous reason",
    description:
      "When a ticket is rejected twice, the drawer starts empty. Pre-fill it with the last reason so a small amendment does not mean retyping the whole thing.",
    status: "todo",
    playbook: "Frontend",
    priority: "medium",
    createdAt: iso(3),
    updatedAt: iso(3),
  },
  {
    ...base,
    id: "10x-5",
    number: 5,
    title: "Stop the preview's dev server on Accept",
    description: "Accept should free the preview checkout and its ports rather than leave them running.",
    status: "in_progress",
    playbook: "Backend",
    priority: "high",
    ...session("session_01ImplPreviewStop"),
    sessionKind: "impl",
    agentState: "working",
    agentNote: "Wired DELETE /tickets/:id/preview into the accept route; writing the test now.",
    agentUpdatedAt: minutesAgo(1),
    branch: "claude/10x-10x-5",
    taskBreakdown: [
      { text: "Find the preview for the ticket being accepted", done: true },
      { text: "Kill its process group and remove the checkout", done: true },
      { text: "Release the port block", done: false },
    ],
    acceptanceCriteria: [
      { text: "No preview survives past Accept", done: false },
      { text: "Killing never reaches outside the preview's process group", done: false },
    ],
    attachments: [
      { name: "port-scan.png", size: 84213, mime: "image/png", path: "/home/asaad/.10x/attachments/10x-5-1.png" },
    ],
    createdAt: iso(1),
    updatedAt: iso(0, 14),
    startedAt: iso(0, 14),
  },
  {
    ...base,
    id: "10x-9",
    number: 9,
    title: "Validate the project slug at creation time",
    description: "Reject a slug that cannot become a branch, at the point the project is created.",
    status: "in_progress",
    playbook: "Backend",
    priority: "high",
    // Blocked: the agent wrote its question into agentNote and is waiting in the session tab.
    ...session("session_01ImplSlugCheck"),
    sessionKind: "impl",
    agentState: "blocked",
    agentNote:
      "Should an existing project whose slug is now invalid be migrated automatically, or only refused for new projects? Migrating renames branches that may already have open PRs.",
    agentUpdatedAt: minutesAgo(12),
    branch: "claude/10x-10x-9",
    taskBreakdown: [
      { text: "Reject a slug that cannot become a valid branch name", done: true },
      { text: "Surface the rejection in the New Project form", done: false },
    ],
    createdAt: iso(1, 12),
    updatedAt: iso(0, 9),
    startedAt: iso(0, 9),
  },
  {
    ...base,
    id: "10x-4",
    number: 4,
    title: "Search should match ticket ids",
    description: "Typing 10x-4 should find this card.",
    status: "in_progress",
    playbook: "Frontend",
    // The agent reported it could not finish.
    ...session("session_01ImplSearchIds"),
    sessionKind: "impl",
    agentState: "failed",
    agentNote: "Could not install dependencies: the environment's network allowlist blocks registry.npmjs.org.",
    agentUpdatedAt: minutesAgo(95),
    createdAt: iso(2),
    updatedAt: iso(1),
  },
  {
    ...base,
    id: "10x-11",
    number: 11,
    title: "Retry a session start that timed out",
    description: "`claude --cloud` sometimes takes longer than the route waits; the ticket shows starting with no link.",
    status: "in_progress",
    playbook: "DevOps",
    priority: "medium",
    // Starting, and the session URL has not been recorded yet — the disabled Steer state.
    sessionKind: "impl",
    agentState: "starting",
    createdAt: iso(1, 8),
    updatedAt: iso(0, 13),
    startedAt: iso(0, 13),
  },
  {
    ...base,
    id: "10x-3",
    number: 3,
    title: "Keep the sheet's scroll position across a poll",
    description: "The poll re-renders the sheet and it jumps back to the top.",
    status: "in_review",
    playbook: "Frontend",
    priority: "medium",
    ...session("session_01ImplSheetScroll"),
    sessionKind: "impl",
    agentState: "done",
    agentNote:
      "Draft PR #44 is up. The sheet now keeps its scroll offset across polls; before/after screenshots are on the PR.",
    agentUpdatedAt: minutesAgo(25),
    branch: "claude/10x-10x-3",
    prNumber: 44,
    prUrl: "https://github.com/asaadx/10x/pull/44",
    prState: "open",
    prAdditions: 38,
    prDeletions: 6,
    // A running preview with the project's dev command.
    preview: {
      path: "/home/asaad/.10x/previews/10x-3",
      port: 4120,
      url: "http://localhost:4120",
      command: "pnpm dev:web --port $PORT",
      running: true,
    },
    taskBreakdown: [
      { text: "Stop the poll from resetting the sheet body", done: true },
      { text: "Keep the scroll offset across a refresh", done: true },
    ],
    acceptanceCriteria: [{ text: "Scrolling the sheet survives the next poll", done: true }],
    createdAt: iso(4),
    updatedAt: iso(0, 11),
  },
  {
    ...base,
    id: "10x-14",
    number: 14,
    title: "Free the port block when a preview's process dies",
    description:
      "If the dev command crashes, the preview entry stays and holds its ports until someone clicks Stop.",
    status: "in_review",
    playbook: "Backend",
    priority: "high",
    ...session("session_01ImplPortFree"),
    sessionKind: "impl",
    agentState: "done",
    agentNote: "Pushed to claude/10x-10x-14; no PR number recorded yet, so Accept will open one from the branch.",
    agentUpdatedAt: minutesAgo(180),
    branch: "claude/10x-10x-14",
    // The dev command ran and exited.
    preview: {
      path: "/home/asaad/.10x/previews/10x-14",
      port: 4130,
      url: "http://localhost:4130",
      command: "pnpm dev:web --port $PORT",
      running: false,
    },
    createdAt: iso(2, 10),
    updatedAt: iso(0, 8),
  },
  {
    ...base,
    id: "10x-2",
    number: 2,
    title: "Record merged and closed PR state from a webhook",
    description: "State derives from merged plus state, never from action.",
    status: "done",
    playbook: "Backend",
    ...session("session_01ImplWebhookState"),
    sessionKind: "impl",
    agentState: "done",
    agentNote: "Webhook handler records prState from `merged` + `state`.",
    agentUpdatedAt: iso(2, 12),
    branch: "claude/10x-10x-2",
    prNumber: 30,
    prUrl: "https://github.com/asaadx/10x/pull/30",
    prState: "merged",
    prAdditions: 412,
    prDeletions: 87,
    createdAt: iso(6),
    updatedAt: iso(2),
  },
  {
    ...base,
    id: "10x-1",
    number: 1,
    title: "Spike: drag and drop between columns",
    description: "Abandoned — only two of the eight moves are legal, so buttons already say it better.",
    status: "done",
    branch: "claude/10x-10x-1",
    prNumber: 12,
    prUrl: "https://github.com/asaadx/10x/pull/12",
    prState: "closed",
    prAdditions: 64,
    prDeletions: 9,
    createdAt: iso(9),
    updatedAt: iso(5),
  },
  {
    ...base,
    id: "10x-10",
    number: 10,
    title: "Show the emerald open-PR icon on the Done card",
    description: "Merged and closed both render today; an open PR still awaiting review renders nothing.",
    status: "done",
    playbook: "Frontend",
    ...session("session_01ImplOpenPrIcon"),
    sessionKind: "impl",
    agentState: "done",
    agentUpdatedAt: iso(0, 10),
    branch: "claude/10x-10x-10",
    prNumber: 41,
    prUrl: "https://github.com/asaadx/10x/pull/41",
    prState: "open",
    prAdditions: 118,
    prDeletions: 22,
    createdAt: iso(3),
    updatedAt: iso(0, 10),
  },
  {
    ...base,
    id: "10x-12",
    number: 12,
    title:
      "Reserve the description line's height even when a ticket has no description at all so cards in a five-column board do not jump",
    description: "",
    status: "todo",
    playbook: "Frontend",
    createdAt: iso(2, 15),
    updatedAt: iso(2, 15),
  },
  {
    ...base,
    id: "10x-13",
    number: 13,
    title: "Expand the description in the ticket sheet",
    description:
      "The card clamps a description to one line, which is correct for the board but hides everything past the first sentence. The sheet already has the room to show the whole thing. Add an affordance in the sheet that reveals the full text on demand, rather than truncating there too.",
    status: "backlog",
    playbook: "Frontend",
    createdAt: iso(0, 16),
    updatedAt: iso(0, 16),
  },
  {
    ...base,
    id: "10x-test-1",
    projectId: "10x-test",
    number: 1,
    title: "Point the webhook receiver at the second repo",
    description: "The GitHub App is only installed on 10x today; 10x-test needs its own delivery URL.",
    status: "backlog",
    playbook: "Backend",
    createdAt: iso(5),
    updatedAt: iso(5),
  },
  {
    ...base,
    id: "10x-test-2",
    projectId: "10x-test",
    number: 2,
    title: "Give 10x-test its own port block",
    description: "Reusing 10x's range collides the moment both projects run an agent at once.",
    status: "in_progress",
    playbook: "Backend",
    priority: "medium",
    ...session("session_01ImplTestPorts"),
    sessionKind: "impl",
    agentState: "working",
    agentNote: "First push done; iterating on the port allocator tests.",
    agentUpdatedAt: minutesAgo(6),
    branch: "claude/10x-10x-test-2",
    // 10x-test has no dev command: the branch is checked out and nothing was started.
    preview: {
      path: "/home/asaad/.10x/previews/10x-test-2",
      port: 4140,
      url: "http://localhost:4140",
      command: "",
      running: false,
    },
    createdAt: iso(1, 10),
    updatedAt: iso(0, 12),
    startedAt: iso(0, 12),
  },
  {
    ...base,
    id: "10x-test-3",
    projectId: "10x-test",
    number: 3,
    title: "Merge the base-branch bump for 10x-test",
    description: "10x-test tracks master, not dev, so the agent needed a per-project base branch.",
    status: "done",
    playbook: "DevOps",
    branch: "claude/10x-10x-test-3",
    prNumber: 4,
    prUrl: "https://github.com/asaadx/10x-test/pull/4",
    prState: "merged",
    prAdditions: 56,
    prDeletions: 11,
    createdAt: iso(4, 9),
    updatedAt: iso(1, 9),
  },
  {
    ...base,
    id: "hearth-home-1",
    projectId: "hearth-home",
    number: 1,
    title: "Group the thermostat cards by floor",
    description: "Written while the repo is still downloading — a backlog does not need the code.",
    status: "todo",
    playbook: "Frontend",
    createdAt: iso(0, 8),
    updatedAt: iso(0, 8),
  },
  {
    ...base,
    id: "hearth-home-2",
    projectId: "hearth-home",
    number: 2,
    // Backlog as well as To Do, because Plan starts a session too: both buttons are gated while
    // the repo is downloading, and only a card in each column proves it.
    title: "Work out why the hallway sensor drops off overnight",
    description: "",
    status: "backlog",
    playbook: "Backend",
    createdAt: iso(0, 9),
    updatedAt: iso(0, 9),
  },
  {
    ...base,
    id: "jarvis-3",
    projectId: "jarvis",
    number: 3,
    title: "Stream partial transcripts to the client",
    description: "The PR is still open on GitHub, so deleting this project has to be refused rather than destroy its branch.",
    status: "done",
    playbook: "Backend",
    priority: "medium",
    branch: "claude/10x-jarvis-3",
    prNumber: 7,
    prUrl: "https://github.com/asaadx/jarvis/pull/7",
    prState: "open",
    prAdditions: 203,
    prDeletions: 41,
    createdAt: iso(8),
    updatedAt: iso(1, 16),
  },
];

/**
 * Bulk tickets for `/list`, whose whole reason to exist is a board past the point cards scale.
 * Generated rather than hand-written because what matters here is spread, not individual
 * states: every status, priority, playbook and agent state, checklists at several ratios, PRs
 * with and without a known state, and `updatedAt` spread over weeks so every sort key has
 * something to reorder. No PR is `open`, so the project-delete guard still reads only the
 * fixtures above.
 */
const BULK_TITLES = [
  "Paginate the tickets endpoint",
  "Keyboard shortcut to create a ticket",
  "Cache project lookups for a minute",
  "Show the base branch on the project picker",
  "Retry webhook deliveries that time out",
  "Collapse empty columns on narrow screens",
  "Explain why Start is disabled in a tooltip",
  "Record who accepted a ticket",
  "Document the agent reporting protocol",
  "Move fixture data behind a factory",
  "Research cheaper session start latency",
  "Index tickets by project and status",
  "Badge tickets whose agent asked a question",
  "Trim trailing whitespace from checklist rows",
  "Warn before closing a sheet with unsaved edits",
  "Link the session tab from the card",
  "Export the board as CSV",
  "Surface the last agent note on hover",
  "Rotate the webhook secret without downtime",
  "Tighten the CSP for the served bundle",
  "Add a dark-mode screenshot to the README",
  "Profile the board read under 500 tickets",
  "Let a playbook carry a default priority",
  "Show relative time on done tickets",
] as const;

const BULK_STATUSES = ["backlog", "todo", "in_progress", "in_review", "done"] as const;
const BULK_PLAYBOOKS = ["Fullstack", "Frontend", "Backend", "Database", "DevOps", "Docs", "Research"] as const;
const BULK_PRIORITIES = ["low", "medium", "high"] as const;
const BULK_PR_STATES = ["merged", "closed", null] as const;
const BULK_ACTIVE_STATES = ["working", "starting", "blocked", "working", "failed"] as const;

MOCK_TICKETS.push(
  ...BULK_TITLES.map((title, i): Ticket => {
    const number = 15 + i;
    const status = BULK_STATUSES[(i * 3) % BULK_STATUSES.length]!;
    const total = i % 4 === 0 ? 0 : 2 + (i % 5);
    const done = status === "done" ? total : status === "backlog" ? 0 : Math.min(total, (i * 7) % (total + 1));
    const hasPr = status === "done" || (status === "in_review" && i % 2 === 0);
    const hasSession = status === "in_progress" || status === "in_review" || status === "done";
    const agentState = !hasSession
      ? null
      : status === "in_progress"
        ? BULK_ACTIVE_STATES[i % BULK_ACTIVE_STATES.length]!
        : "done";
    return {
      ...base,
      id: `10x-${number}`,
      number,
      title,
      description: `Bulk fixture ${number} for the list view.`,
      status,
      ...(hasSession ? session(`session_01Bulk${number}`) : {}),
      sessionKind: hasSession ? "impl" : null,
      agentState,
      agentNote: agentState === "blocked" ? "Which of the two APIs should this use?" : null,
      agentUpdatedAt: hasSession ? iso((i * 5) % 26, 8 + (i % 9)) : null,
      branch: hasSession ? `claude/10x-10x-${number}` : null,
      playbook: BULK_PLAYBOOKS[i % BULK_PLAYBOOKS.length]!,
      priority: BULK_PRIORITIES[(i * 2) % BULK_PRIORITIES.length]!,
      taskBreakdown: Array.from({ length: total }, (_, k) => ({ text: `Step ${k + 1}`, done: k < done })),
      prNumber: hasPr ? 50 + i : null,
      prUrl: hasPr ? `https://github.com/asaadx/10x/pull/${50 + i}` : null,
      prState: hasPr ? BULK_PR_STATES[i % BULK_PR_STATES.length]! : null,
      createdAt: iso(10 + (i % 20), 8),
      updatedAt: iso((i * 5) % 26, 8 + (i % 9)),
    };
  }),
);
