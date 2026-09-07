/**
 * Materialises a project's own clone at `$PROJECTS_ROOT/<id>` and, if the repo has no commits
 * yet, seeds the one commit a branch needs to exist (memory/gotchas.md G8).
 *
 * Nothing here reads or writes the database: the caller owns `provision_state`. That split is
 * what makes provisioning restartable — a process killed mid-clone leaves a row stuck at
 * `cloning` and a half-written directory, and the next attempt adopts or clears it rather than
 * needing to know how the last one died.
 *
 * Expected failures come back as `{ ok: false, message }` instead of throwing, because that
 * message is stored in `provision_error` and shown to the user. Every path it can take runs
 * through `redact` first.
 */
import { execFile } from "node:child_process";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { PROJECTS_ROOT } from "./db.ts";
import { parseRemote, redact } from "./github.ts";
import type { Project } from "./types.ts";

const run = promisify(execFile);

export const projectRepoPath = (projectId: string): string => join(PROJECTS_ROOT, projectId);

/**
 * The remote as it is safe to persist: no credentials, ever. A path-shaped owner passes through
 * as a plain filesystem remote, which is what lets the tests drive the real clone, seed and push
 * code against a `git init --bare` fixture instead of the network.
 */
const remoteUrl = (owner: string, repo: string): string =>
  owner.startsWith("/") ? join(owner, repo) : `https://github.com/${owner}/${repo}.git`;

/** The same remote for the commands that actually talk to GitHub, and only those. */
const authUrl = (owner: string, repo: string, token: string): string => {
  const url = remoteUrl(owner, repo);
  return url.startsWith("https://") ? url.replace("https://", `https://x-access-token:${token}@`) : url;
};

/**
 * `redact` splits the message on the token, so an empty token would explode every character into
 * `***`. A sentinel that cannot occur in git output keeps the credentials-in-URL half working.
 */
const scrub = (value: unknown, token: string): string => redact(String(value), token || "\0");

/**
 * git puts the useful line on stderr while Node prepends the whole command line — including the
 * authenticated URL — to `error.message`. Prefer stderr, and redact either way.
 */
const gitMessage = (error: unknown, token: string): string => {
  const stderr = typeof error === "object" && error !== null && "stderr" in error ? error.stderr : undefined;
  return scrub(typeof stderr === "string" && stderr.trim() ? stderr.trim() : error, token);
};

/**
 * Identity is `owner/repo`, not the URL spelling: an adopted clone may say `git@github.com:…`,
 * omit the `.git`, or still carry the credentials of a clone that died before `set-url` ran.
 * A filesystem remote has no owner/repo to parse, so it falls back to a literal comparison.
 */
const sameRemote = (a: string, b: string): boolean => {
  const credentials = /^https:\/\/[^/@]+@/;
  try {
    const left = parseRemote(a.replace(credentials, "https://"));
    const right = parseRemote(b.replace(credentials, "https://"));
    return left.owner === right.owner && left.repo === right.repo;
  } catch {
    return a === b;
  }
};

/**
 * Zero ref lines means the repo has no commits; a non-zero exit means it could not be reached.
 * Both verified, and both are why the emptiness question needs no GitHub API call — the API
 * reports `default_branch` as a *setting*, which a commitless repo does not actually have
 * (memory/gotchas.md G8).
 */
export const remoteHasCommits = async (owner: string, repo: string, token: string): Promise<boolean> => {
  try {
    const { stdout } = await run("git", ["ls-remote", "--heads", authUrl(owner, repo, token)]);
    return stdout.trim().length > 0;
  } catch (error) {
    throw new Error(gitMessage(error, token));
  }
};

/**
 * `clone` is a readable git repository; `wreckage` is a directory 10x can only have produced
 * itself by dying mid-clone — empty, or holding a `.git` git refuses to read. Anything else with
 * files in it is `occupied` and off limits: this module never deletes a directory it did not
 * create, and it cannot prove it created one that has unrelated files in it.
 */
type Occupancy = { kind: "absent" } | { kind: "clone"; origin: string } | { kind: "wreckage" } | { kind: "occupied" };

async function occupancy(dest: string): Promise<Occupancy> {
  let entries: string[];
  try {
    entries = await readdir(dest);
  } catch (error) {
    // ENOTDIR (a file sits where the clone should go) is not absence, and clobbering it would
    // lose whatever it is.
    const missing = typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
    return missing ? { kind: "absent" } : { kind: "occupied" };
  }
  if (!entries.includes(".git")) return entries.length === 0 ? { kind: "wreckage" } : { kind: "occupied" };
  try {
    const { stdout } = await run("git", ["-C", dest, "remote", "get-url", "origin"]);
    return { kind: "clone", origin: stdout.trim() };
  } catch {
    return { kind: "wreckage" };
  }
}

export type ProvisionOutcome = { ok: true } | { ok: false; message: string };

/** Clone, adopt or refuse — idempotent, so a crashed provision costs nothing to retry. */
async function placeClone(project: Project, dest: string, token: string): Promise<ProvisionOutcome> {
  const clean = remoteUrl(project.owner, project.repo);
  const found = await occupancy(dest);

  if (found.kind === "clone") {
    if (!sameRemote(found.origin, clean)) {
      return {
        ok: false,
        message: `${dest} already holds a clone of ${scrub(found.origin, token)}, not ${clean}. Move it aside and provision again — 10x will not overwrite a repository it did not put there.`,
      };
    }
    // A clone killed between `clone` and `set-url` still has the token in .git/config, so rewrite
    // on adoption too rather than only on the path that created it.
    await run("git", ["-C", dest, "remote", "set-url", "origin", clean]);
    return { ok: true };
  }

  if (found.kind === "occupied") {
    return {
      ok: false,
      message: `${dest} already exists and is not a 10x clone. Empty or move that directory and provision again — 10x will not delete files it did not create.`,
    };
  }

  if (found.kind === "wreckage") {
    // The one destructive act in this module. The guard is cheap and keeps it inside
    // $PROJECTS_ROOT even if a project id ever reaches here with a path separator in it.
    if (dirname(resolve(dest)) !== resolve(PROJECTS_ROOT)) {
      throw new Error(`refusing to remove ${dest}: not directly under ${PROJECTS_ROOT}`);
    }
    await rm(dest, { recursive: true, force: true });
  }

  await mkdir(dirname(dest), { recursive: true });
  await run("git", ["clone", authUrl(project.owner, project.repo, token), dest]);
  // Immediately, not once provisioning finishes: `git clone` persists the URL it was handed, so
  // until this runs the token is sitting on disk in .git/config.
  await run("git", ["-C", dest, "remote", "set-url", "origin", clean]);
  return { ok: true };
}

async function seedFirstCommit(
  project: Project,
  dest: string,
  opts: { token: string; authorName: string; authorEmail: string },
): Promise<void> {
  // A clone of an empty repo leaves HEAD on the local `init.defaultBranch` — often `master` —
  // which need not be the branch GitHub reports as its default (memory/gotchas.md G8). Committing
  // first would create the wrong branch, and it is the only branch every ticket will base off.
  await run("git", ["-C", dest, "symbolic-ref", "HEAD", `refs/heads/${project.baseBranch}`]);
  const readme = project.description ? `# ${project.name}\n\n${project.description}\n` : `# ${project.name}\n`;
  await writeFile(join(dest, "README.md"), readme);
  await run("git", ["-C", dest, "add", "README.md"]);
  // Identity and signing come from flags so the seed never depends on the machine's git config:
  // the backend may run as a user with no `user.email`, or with `commit.gpgsign` on and no key
  // reachable from a non-interactive process.
  await run("git", [
    "-C",
    dest,
    "-c",
    `user.name=${opts.authorName}`,
    "-c",
    `user.email=${opts.authorEmail}`,
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    "chore: initial commit",
  ]);
  await run("git", [
    "-C",
    dest,
    "push",
    authUrl(project.owner, project.repo, opts.token),
    `${project.baseBranch}:${project.baseBranch}`,
  ]);
}

export const provisionProject = async (
  project: Project,
  opts: { token: string; seedInitialCommit: boolean; authorName: string; authorEmail: string },
): Promise<ProvisionOutcome> => {
  const dest = projectRepoPath(project.id);
  try {
    const placed = await placeClone(project, dest, opts.token);
    if (!placed.ok) return placed;

    // Asked of the remote, not the clone: a seed that pushed and then crashed leaves the remote
    // with commits and this is what makes the retry a no-op.
    if (await remoteHasCommits(project.owner, project.repo, opts.token)) return { ok: true };

    if (!opts.seedInitialCommit) {
      return {
        ok: false,
        message: `${project.owner}/${project.repo} has no commits, so there is no ${project.baseBranch} branch for a ticket to branch from. Push a first commit yourself, or provision again and let 10x create one.`,
      };
    }

    await seedFirstCommit(project, dest, opts);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: gitMessage(error, opts.token) };
  }
};
