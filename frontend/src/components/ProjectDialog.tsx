import { IconBrandGithub } from "@tabler/icons-react";
import { ArrowRight, Check, GitBranch, Trash2, TriangleAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Checkbox } from "@/components/ui/checkbox.tsx";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import {
  createProject,
  deleteProject,
  lookupRepo,
  openPullRequests,
  parseGithubRemote,
  RequestError,
  updateProject,
  type OpenPullRequest,
  type RepoLookup,
} from "@/lib/api.ts";
import type { Project } from "@/types.ts";

/**
 * Adding a project asks for three things — a GitHub link, a name and a description — and works
 * everything else out from the repo rather than asking for it: the owner, the default branch,
 * the slug, and where 10x will keep its own copy. All of it is shown before you commit to it,
 * because two of those (the slug, and the seed commit) cannot be taken back afterwards.
 *
 * Edit mode is the same dialog with the two permanent fields locked, so there is one layout to
 * recognise rather than two.
 */

const LOOKUP_DEBOUNCE_MS = 400;

/** `PROJECT_SLUG_RE` in `backend/src/lifecycle.ts`, which the create route validates against. */
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,19}$/;
const SLUG_MAX = 20;

/**
 * The backend derives the same slug in `deriveProjectSlug`, and this is deliberately a second
 * copy rather than a shared one: the dialog has to show you the slug — and let you edit it —
 * before any request exists to ask for it. `SLUG_RE` is what reconciles them, since a
 * disagreement is a rejected create rather than a silent difference.
 *
 * Truncating mid-word gives `hearth-home-automati`, which reads like a typo and which you would
 * then fix by hand every single time, so whole trailing words are dropped instead:
 * `hearth-home`. Only a name with no dash left to cut at falls back to a hard slice.
 */
function normalizeSlug(repoName: string): string {
  return repoName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
}

function deriveProjectSlug(repoName: string): string {
  const full = normalizeSlug(repoName);
  if (full.length <= SLUG_MAX) return full;

  const [first = "", ...rest] = full.split("-");
  let kept = first;
  for (const word of rest) {
    if (`${kept}-${word}`.length > SLUG_MAX) break;
    kept = `${kept}-${word}`;
  }
  return kept.length <= SLUG_MAX ? kept : full.slice(0, SLUG_MAX).replace(/-+$/, "");
}

/**
 * Refusing a non-GitHub host is not a limitation we picked for fun, so the message says why:
 * the board's finish line is a pull request, and a repo it cannot open one against would leave
 * every ticket stuck in In Review forever.
 */
const OTHER_HOST_RE = /gitlab|bitbucket|codeberg|git\.sr\.ht/i;
const NOT_GITHUB =
  "10x can only take GitHub repos. Finishing a ticket pushes a branch and opens a pull request, so a repo it cannot open a PR against would be a dead end.";
const NOT_A_LINK =
  "That is not a GitHub repo link. Expected something like https://github.com/you/your-repo.";

/**
 * The lookup's failures have to stay distinguishable, because each one is a different thing for
 * you to go and do — fix the URL, fix the spelling, widen the token, set a token, wait.
 */
function lookupFailure(error: unknown, target: { owner: string; repo: string }): string {
  const code = error instanceof RequestError ? error.code : null;
  switch (code) {
    case "invalid_remote":
      return NOT_A_LINK;
    case "repo_not_found":
      return `No repo at ${target.owner}/${target.repo}. Check the spelling, or the owner.`;
    case "repo_not_accessible":
      return `${target.owner}/${target.repo} exists but your GitHub token cannot see it. If it belongs to an org, the token needs access to that org.`;
    case "github_token_missing":
      return "10x has no GitHub token, so it cannot check this repo. Set GITHUB_TOKEN and restart the board.";
    case "github_unavailable":
      return "GitHub could not be reached, so this repo could not be checked. Try again in a moment.";
    default:
      return error instanceof Error ? error.message : String(error);
  }
}

type Lookup =
  | { phase: "idle" }
  | { phase: "looking"; owner: string; repo: string }
  | { phase: "error"; message: string }
  | { phase: "resolved"; found: RepoLookup };

function FieldLabel({ htmlFor, hint, children }: { htmlFor: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <label htmlFor={htmlFor} className="text-xs text-muted-foreground">
        {children}
      </label>
      {hint !== undefined && <span className="text-[11px] text-muted-foreground">{hint}</span>}
    </div>
  );
}

export function ProjectDialog({
  open,
  onOpenChange,
  projects,
  editing,
  onSaved,
  onRequestDelete,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Every project, for the slug-collision check: a slug is the project's id. */
  projects: Project[];
  /** The project being edited, or null for create mode. */
  editing: Project | null;
  /** The created or saved project, so the caller can select it. */
  onSaved: (project: Project) => void;
  /**
   * Hands the destructive step back to the caller, which owns `DeleteProjectDialog`. Edit mode
   * only — there is nothing to delete before a project exists.
   */
  onRequestDelete?: () => void;
}) {
  const isEdit = editing !== null;

  const [link, setLink] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [slug, setSlug] = useState("");
  const [baseBranch, setBaseBranch] = useState("");
  const [devCommand, setDevCommand] = useState("");
  const [seedCommit, setSeedCommit] = useState(true);
  const [lookup, setLookup] = useState<Lookup>({ phase: "idle" });
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  // A ref, not state: once you have edited the slug the lookup must stop overwriting it, and
  // that is all this is read for — as state it would re-run the lookup effect and cost a
  // request every keystroke in the slug field.
  const slugEdited = useRef(false);

  useEffect(() => {
    if (!open) return;
    setPending(false);
    setFailure(null);
    slugEdited.current = false;
    if (editing !== null) {
      // Only when the identity is actually there. A project whose migration could not resolve a
      // GitHub remote has empty owner/repo, and a backend that predates those columns sends
      // neither — interpolating regardless produced `https://github.com/undefined/undefined`,
      // which reads as a real link to a repo that does not exist.
      setLink(editing.owner && editing.repo ? `https://github.com/${editing.owner}/${editing.repo}` : "");
      setName(editing.name);
      setDescription(editing.description ?? "");
      setSlug(editing.id);
      setBaseBranch(editing.baseBranch);
      setDevCommand(editing.devCommand ?? "");
      setLookup({ phase: "idle" });
      return;
    }
    setLink("");
    setName("");
    setDescription("");
    setSlug("");
    setBaseBranch("");
    setDevCommand("");
    setSeedCommit(true);
    setLookup({ phase: "idle" });
  }, [open, editing]);

  // The admission test, debounced: it proves the URL parses, the repo exists and the token can
  // see it, and hands back the name, description and default branch so none of the three is a
  // field you have to fill. Parsing first means a half-typed URL costs no request, and a
  // non-GitHub host gets its own sentence instead of a generic refusal.
  useEffect(() => {
    if (!open || isEdit) return;
    if (link.trim() === "") {
      setLookup({ phase: "idle" });
      return;
    }
    const parsed = parseGithubRemote(link);
    if (parsed === null) {
      setLookup({ phase: "error", message: OTHER_HOST_RE.test(link) ? NOT_GITHUB : NOT_A_LINK });
      return;
    }

    setLookup({ phase: "looking", owner: parsed.owner, repo: parsed.repo });
    // Guards both resolutions: a slower answer for a URL you have since edited must not
    // overwrite the newer one.
    let live = true;
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const found = await lookupRepo(link.trim());
          if (!live) return;
          setLookup({ phase: "resolved", found });
          setBaseBranch(found.defaultBranch);
          // Prefill only what you have not written yourself: the repo's own name and
          // description are a starting point, never an overwrite.
          setName((current) => (current.trim() === "" ? found.name : current));
          setDescription((current) => (current.trim() === "" ? found.description : current));
          if (!slugEdited.current) setSlug(deriveProjectSlug(found.repo));
        } catch (error) {
          if (!live) return;
          setLookup({ phase: "error", message: lookupFailure(error, parsed) });
        }
      })();
    }, LOOKUP_DEBOUNCE_MS);

    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [open, isEdit, link]);

  const found = lookup.phase === "resolved" ? lookup.found : null;
  const slugCollides = !isEdit && projects.some((project) => project.id === slug);
  const slugOk = SLUG_RE.test(slug) && !slugCollides;
  // "Shortened" means whole words were dropped, not that the cap was hit exactly.
  const slugShortened = found !== null && deriveProjectSlug(found.repo) !== normalizeSlug(found.repo);
  const mustSeed = found !== null && found.empty && !seedCommit;

  const canSubmit =
    !pending &&
    name.trim() !== "" &&
    (isEdit ? baseBranch.trim() !== "" : found !== null && slugOk && !mustSeed);

  async function submit() {
    setPending(true);
    setFailure(null);
    try {
      let saved =
        editing !== null
          ? await updateProject(editing.id, {
              name: name.trim(),
              description: description.trim(),
              baseBranch: baseBranch.trim(),
              devCommand: devCommand.trim(),
            })
          : await createProject({
              remote: link.trim(),
              name: name.trim(),
              description: description.trim(),
              id: slug,
              seedInitialCommit: found !== null && found.empty && seedCommit,
            });
      // `POST /projects` does not take a dev command, so a new project gets it through the
      // same PATCH an edit uses. Not atomic with the create: if this fails the project exists
      // without one, and the message stays up in the still-open dialog.
      if (editing === null && devCommand.trim() !== "") {
        saved = await updateProject(saved.id, { devCommand: devCommand.trim() });
      }
      onSaved(saved);
      onOpenChange(false);
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error));
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* The empty-repo panel and the derived panel both appear late, so the content has to be
          able to scroll rather than grow past the viewport. */}
      <DialogContent className="max-h-[85vh] max-w-xl gap-0 overflow-y-auto p-6">
        <DialogTitle className="pr-8 tracking-tight">
          {editing !== null ? `Edit ${editing.name}` : "Add a project"}
        </DialogTitle>
        <p className="mt-2 text-sm text-muted-foreground">
          {isEdit
            ? "The short name and the repo are fixed — every branch this project has ever created is built from them."
            : "Paste a GitHub repo. 10x works out the rest and downloads its own copy."}
        </p>

        <div className="mt-5 grid gap-4">
          <div className="grid gap-1.5">
            <FieldLabel htmlFor="p-link" hint={isEdit ? "cannot be changed" : "required"}>
              GitHub repo
            </FieldLabel>
            <div className="relative">
              <IconBrandGithub
                aria-hidden
                className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
              />
              <Input
                id="p-link"
                value={link}
                disabled={isEdit}
                onChange={(e) => setLink(e.target.value)}
                placeholder="https://github.com/you/your-new-repo"
                aria-invalid={lookup.phase === "error"}
                className="pr-9 pl-8"
              />
              {lookup.phase === "looking" && (
                <Spinner className="absolute top-1/2 right-3 size-3.5 -translate-y-1/2 text-muted-foreground" />
              )}
              {found !== null && (
                <Check aria-hidden className="absolute top-1/2 right-3 size-4 -translate-y-1/2 text-emerald-500" />
              )}
            </div>
            {lookup.phase === "looking" && (
              <p className="text-[11px] text-muted-foreground">
                Checking {lookup.owner}/{lookup.repo} on GitHub…
              </p>
            )}
            {lookup.phase === "error" && (
              <p className="flex gap-1.5 text-[11px] text-destructive">
                <TriangleAlert aria-hidden className="mt-px size-3.5 shrink-0" />
                <span>{lookup.message}</span>
              </p>
            )}
          </div>

          <div className="grid gap-1.5">
            <FieldLabel htmlFor="p-name" hint="required">
              Name
            </FieldLabel>
            <Input
              id="p-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="What you want to call it"
            />
          </div>

          <div className="grid gap-1.5">
            <FieldLabel htmlFor="p-desc" hint="optional">
              Description
            </FieldLabel>
            <textarea
              id="p-desc"
              rows={2}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="One or two lines about what this project is."
              className="min-h-16 resize-y rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
            />
            <p className="text-[11px] text-muted-foreground">
              Your own note about what this project is. Not sent to agents.
            </p>
          </div>

          <div className="grid gap-1.5">
            <FieldLabel htmlFor="p-dev" hint="optional">
              Dev command
            </FieldLabel>
            <Input
              id="p-dev"
              value={devCommand}
              onChange={(e) => setDevCommand(e.target.value)}
              placeholder="pnpm dev --port $PORT"
              className="font-mono text-xs"
            />
            <p className="text-[11px] text-muted-foreground">
              Runs in the ticket's preview checkout with $PORT set. Leave empty and Preview only checks the
              branch out.
            </p>
          </div>

          {/* Derived, shown rather than asked for. In edit mode the repo and the slug are
              already frozen, so the same panel renders read-only around the one field that is
              still yours to change. */}
          {(found !== null || editing !== null) && (
            <div className="rounded-lg border bg-muted/40 p-3.5">
              <div className="mb-3 flex items-center gap-2 text-xs font-medium text-muted-foreground">
                <GitBranch aria-hidden className="size-3.5" />
                Worked out from the repo
              </div>

              <dl className="grid grid-cols-[9rem_1fr] items-baseline gap-x-3 gap-y-2 text-xs">
                <dt className="text-muted-foreground">Repo</dt>
                <dd className="font-mono">
                  {found?.owner ?? editing?.owner}/{found?.repo ?? editing?.repo}
                  {/* Visibility comes from the lookup, so it is shown only when one ran: an
                      already-stored project has no visibility on its row to report. */}
                  {found !== null && (
                    <span className="ml-2 rounded border px-1 py-px font-sans text-[10px] text-muted-foreground">
                      {found.private ? "private" : "public"}
                    </span>
                  )}
                </dd>

                <dt className="text-muted-foreground">Main branch</dt>
                {isEdit ? (
                  <dd>
                    <Input
                      id="p-base"
                      aria-label="Main branch"
                      value={baseBranch}
                      onChange={(e) => setBaseBranch(e.target.value)}
                      className="h-8 font-mono text-xs"
                      aria-invalid={baseBranch.trim() === ""}
                    />
                  </dd>
                ) : (
                  <dd className="font-mono">{baseBranch}</dd>
                )}

                <dt className="text-muted-foreground">10x's copy</dt>
                <dd className="truncate font-mono text-muted-foreground">
                  {editing?.repoPath ?? `~/.10x/repos/${slug === "" ? "…" : slug}`}
                </dd>
              </dl>

              <div className="mt-3.5 grid gap-1.5 border-t pt-3.5">
                <FieldLabel htmlFor="p-slug" hint={isEdit ? "cannot be changed" : "fixed once created"}>
                  Short name
                </FieldLabel>
                <Input
                  id="p-slug"
                  value={slug}
                  disabled={isEdit}
                  onChange={(e) => {
                    slugEdited.current = true;
                    setSlug(e.target.value);
                  }}
                  className="h-8 font-mono text-xs"
                  aria-invalid={slug !== "" && !slugOk}
                />
                <p className="text-[11px] text-muted-foreground">
                  Used in every branch and agent name — <span className="font-mono">ticket/{slug === "" ? "…" : slug}/1</span>. It
                  can never be changed afterwards, so it is worth a look now.
                </p>
                {slug !== "" && !SLUG_RE.test(slug) && (
                  <p className="text-[11px] text-destructive">
                    Lowercase letters, digits and dashes only, 20 characters max, and it cannot start with a dash.
                  </p>
                )}
                {slugCollides && (
                  <p className="text-[11px] text-destructive">
                    You already have a project called <span className="font-mono">{slug}</span>. Pick another.
                  </p>
                )}
                {slugShortened && slugOk && (
                  <p className="text-[11px] text-amber-500">
                    Shortened to fit the 20-character limit. Edit it if that reads badly.
                  </p>
                )}
              </div>
            </div>
          )}

          {/* The case a brand-new GitHub repo actually hits: no commits, so `main` is a setting
              rather than a branch, and the first ticket started would die at worktree creation
              (memory/gotchas.md G8). */}
          {found !== null && found.empty && (
            <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3.5">
              <div className="flex gap-2">
                <TriangleAlert aria-hidden className="mt-px size-4 shrink-0 text-amber-500" />
                <div className="min-w-0 text-xs">
                  <p className="font-medium text-amber-500">This repo is empty — it has no commits yet.</p>
                  <p className="mt-1.5 text-muted-foreground">
                    Agents branch off <span className="font-mono">{baseBranch}</span>, and on an empty repo that
                    branch does not exist yet, so the first ticket you started would fail. 10x can make the first
                    commit for you.
                  </p>
                  <label className="mt-2.5 flex cursor-pointer items-start gap-2">
                    <Checkbox
                      checked={seedCommit}
                      onCheckedChange={(checked) => setSeedCommit(checked === true)}
                      className="mt-px size-3.5"
                    />
                    <span>
                      Create an initial commit on <span className="font-mono">{baseBranch}</span> with a README
                      from the name and description above.
                      <span className="mt-1 block text-[11px] text-muted-foreground">
                        This is the only time 10x writes to the repo itself outside of a ticket.
                      </span>
                    </span>
                  </label>
                  {mustSeed && (
                    <p className="mt-2 text-[11px] text-destructive">
                      Without a first commit there is nothing to branch from, so the project cannot be added.
                      Either tick this, or push a commit to {baseBranch} yourself and come back.
                    </p>
                  )}
                </div>
              </div>
            </div>
          )}

          {failure !== null && (
            <p role="status" className="rounded-md bg-destructive/10 p-2 text-xs break-words text-destructive">
              {failure}
            </p>
          )}
        </div>

        <div className="mt-6 flex items-center justify-end gap-2 border-t pt-4">
          {isEdit && (
            <>
              {/*
                Delete lives here rather than in the nav bar, where it used to sit one click from
                the project picker and the theme toggle. It stops agents, destroys worktrees and
                unmerged branches and removes the clone, so reaching it should cost a deliberate
                step. Left-aligned and text-only: present, findable, and not competing with Save.
              */}
              <Button
                variant="ghost"
                size="sm"
                disabled={pending}
                onClick={() => onRequestDelete?.()}
                className="mr-auto text-destructive hover:bg-destructive/10 hover:text-destructive"
              >
                <Trash2 aria-hidden className="size-3.5" />
                Delete project
              </Button>
            </>
          )}
          <Button variant="outline" size="lg" disabled={pending} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button size="lg" disabled={!canSubmit} onClick={() => void submit()}>
            {pending && <Spinner aria-hidden />}
            {isEdit ? "Save" : "Add project"}
            {!isEdit && !pending && <ArrowRight aria-hidden className="size-3.5" />}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Deleting a project is total cleanup — agents stopped, working copies and their unmerged
 * branches removed, 10x's own copy of the repo deleted — so the dialog says what will be
 * destroyed before it destroys it. What it lists is deliberately categories rather than counts:
 * the nav bar holds the project list, not the tickets, and a count this dialog cannot verify
 * would be worse than an honest category.
 *
 * The one refusal is `pr_open`, and it is answered by the server rather than predicted here: it
 * asks GitHub live, every time, because nothing keeps the stored PR state fresh. So the blocking
 * list can only appear after you click, and each PR is linked — the fix is on GitHub, so the
 * dialog takes you there instead of making you find it.
 */
export function DeleteProjectDialog({
  project,
  open,
  onOpenChange,
  onDeleted,
}: {
  project: Project;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDeleted: () => void;
}) {
  const [pending, setPending] = useState(false);
  const [blocking, setBlocking] = useState<OpenPullRequest[] | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setPending(false);
    setBlocking(null);
    setFailure(null);
  }, [open]);

  async function confirm() {
    setPending(true);
    setFailure(null);
    setBlocking(null);
    try {
      await deleteProject(project.id);
      onDeleted();
      onOpenChange(false);
    } catch (error) {
      const refused = openPullRequests(error);
      if (refused !== null) setBlocking(refused);
      else setFailure(error instanceof Error ? error.message : String(error));
    } finally {
      setPending(false);
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {project.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            Total cleanup — the project leaves this machine entirely. Nothing is left running or lying around, and
            this cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>

        <ul className="grid gap-1.5 text-sm">
          <li className="flex gap-2">
            <span aria-hidden className="text-muted-foreground">
              •
            </span>
            <span>Every ticket in this project, removed from the board</span>
          </li>
          <li className="flex gap-2">
            <span aria-hidden className="text-muted-foreground">
              •
            </span>
            {/* There is no CLI to stop or archive a cloud session (docs/prototype-cloud.md), so
                the dialog says so rather than implying they end with the project. */}
            <span>Cloud sessions are not touched — archive them on claude.ai if you want them gone</span>
          </li>
          {/*
            Only claimed when the server will actually do it. `ownsClone` is false for a project
            that predates this feature, whose folder is wherever the user pointed 10x — often
            their own working checkout. The delete route refuses to touch it, so promising to
            delete it here would be a lie about an irreversible act.
          */}
          <li className="flex gap-2">
            <span aria-hidden className="text-muted-foreground">
              •
            </span>
            {project.ownsClone ? (
              <span>
                10x's downloaded copy of the repo, deleted from{" "}
                <span className="font-mono text-xs">{project.repoPath}</span>
                <span className="ml-1.5 text-xs text-muted-foreground">(re-adding downloads it again)</span>
              </span>
            ) : (
              <span className="text-muted-foreground">
                <span className="font-mono text-xs">{project.repoPath}</span> is <strong>left alone</strong> — 10x
                did not create that folder, so it is yours to keep or remove.
              </span>
            )}
          </li>
          <li className="flex gap-2">
            <span aria-hidden className="text-muted-foreground">
              •
            </span>
            <span className="text-muted-foreground">
              Your repo on GitHub is untouched — anything pushed or merged is safe.
            </span>
          </li>
        </ul>

        {blocking !== null && (
          <div className="flex gap-2 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-xs">
            <TriangleAlert aria-hidden className="mt-px size-4 shrink-0 text-destructive" />
            <span>
              <span className="font-medium text-destructive">
                {blocking.length === 1 ? "A pull request is" : `${blocking.length} pull requests are`} still open.
              </span>{" "}
              <span className="text-muted-foreground">
                Deleting now would throw away the branch someone is reviewing — the same rule that already guards
                deleting a single ticket. Merge or close{" "}
                {blocking.map((pr, index) => (
                  <span key={pr.prUrl}>
                    {index > 0 && ", "}
                    <a
                      href={pr.prUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-mono text-foreground underline underline-offset-2"
                    >
                      #{pr.prNumber}
                    </a>{" "}
                    ({pr.ticketId})
                  </span>
                ))}{" "}
                on GitHub first.
              </span>
            </span>
          </div>
        )}

        {failure !== null && (
          <p role="status" className="rounded-md bg-destructive/10 p-2 text-xs break-words text-destructive">
            {failure}
          </p>
        )}

        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          {/* `AlertDialogAction` is Radix's `Close` underneath, so it closes on click unless the
              handler preventDefaults first — that is what keeps the refusal above on screen
              instead of the dialog vanishing before you can read it. */}
          <AlertDialogAction
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            disabled={pending || blocking !== null}
            onClick={(e) => {
              e.preventDefault();
              void confirm();
            }}
          >
            {pending ? <Spinner aria-hidden /> : <Trash2 aria-hidden className="size-3.5" />}
            {pending ? "Deleting..." : "Delete project"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
