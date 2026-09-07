/**
 * Tests for provisioning, against real git repositories in a temp directory: a `git init --bare`
 * fixture stands in for GitHub, so every clone, probe, commit and push here is the production
 * code path with no network and no token. That is what the path-shaped-remote passthrough in
 * `provision.ts` buys — there is no mock, no injected runner, and nothing stubbed.
 */
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Project } from "./types.ts";
import type { ProvisionOutcome } from "./provision.ts";

const dir = mkdtempSync(join(tmpdir(), "10x-provision-test-"));
process.env.STATE_DIR = dir;
process.env.DB_PATH = join(dir, "10x.db");
process.env.PROJECTS_ROOT = join(dir, "repos");

// A local default branch deliberately not `main`: the seed has to land on the project's
// `baseBranch` whatever this machine would have named a fresh branch (memory/gotchas.md G8).
process.env.GIT_CONFIG_COUNT = "1";
process.env.GIT_CONFIG_KEY_0 = "init.defaultBranch";
process.env.GIT_CONFIG_VALUE_0 = "trunk";

// provision.ts reads PROJECTS_ROOT from db.ts, which resolves it — and opens the database — at
// module load, so the assignments above must already have happened. Same reason db.test.ts
// imports dynamically: a static import hoists above them.
const { projectRepoPath, provisionProject, remoteHasCommits } = await import("./provision.ts");
const { db } = await import("./db.ts");

after(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** stderr is captured rather than inherited so a fixture's git chatter stays out of the report. */
const git = (args: string[]): string =>
  execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

let fixtures = 0;

/** A bare repo with no commits: what a freshly created GitHub repo looks like over the wire. */
function bareRemote(): { owner: string; repo: string } {
  const owner = join(dir, "remotes");
  const repo = `fixture-${++fixtures}.git`;
  mkdirSync(owner, { recursive: true });
  git(["init", "-q", "--bare", join(owner, repo)]);
  return { owner, repo };
}

/** The same, with one commit on `main`, so provisioning has something to clone. */
function populatedRemote(): { owner: string; repo: string } {
  const remote = bareRemote();
  const work = join(dir, `fixture-work-${fixtures}`);
  git(["clone", "-q", join(remote.owner, remote.repo), work]);
  git(["-C", work, "checkout", "-q", "-b", "main"]);
  writeFileSync(join(work, "file.txt"), "fixture\n");
  git(["-C", work, "add", "file.txt"]);
  git([
    "-C",
    work,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.com",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-qm",
    "fixture",
  ]);
  git(["-C", work, "push", "-q", "origin", "main"]);
  // GitHub's HEAD tracks the default branch; a bare fixture's does not, and a clone whose remote
  // HEAD names a missing ref checks nothing out at all.
  git(["-C", join(remote.owner, remote.repo), "symbolic-ref", "HEAD", "refs/heads/main"]);
  return remote;
}

const projectOn = (id: string, remote: { owner: string; repo: string }): Project => ({
  id,
  name: "Hearth",
  description: "A home for the home.",
  owner: remote.owner,
  repo: remote.repo,
  repoPath: projectRepoPath(id),
  baseBranch: "main",
  provisionState: "pending",
  provisionError: "",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

const OPTS = { token: "ghp_secret", seedInitialCommit: false, authorName: "10x", authorEmail: "10x@example.com" };

/** Narrows a refusal to its message, so the assertion needs no cast. */
const messageOf = (outcome: ProvisionOutcome): string => {
  if (outcome.ok) assert.fail("expected provisioning to refuse");
  return outcome.message;
};

/** Clones a repo straight into a project's slot, standing in for an earlier provision run. */
function preClone(id: string, remote: { owner: string; repo: string }): string {
  const dest = projectRepoPath(id);
  mkdirSync(dirname(dest), { recursive: true });
  git(["clone", "-q", join(remote.owner, remote.repo), dest]);
  return dest;
}

test("projectRepoPath puts a project directly under PROJECTS_ROOT", () => {
  assert.equal(projectRepoPath("hearth-home"), join(dir, "repos", "hearth-home"));
});

describe("remoteHasCommits", () => {
  test("a repo with no commits answers with zero refs, not an error", async () => {
    const remote = bareRemote();
    assert.equal(await remoteHasCommits(remote.owner, remote.repo, OPTS.token), false);
  });

  test("a repo with a branch answers true", async () => {
    const remote = populatedRemote();
    assert.equal(await remoteHasCommits(remote.owner, remote.repo, OPTS.token), true);
  });

  test("an unreachable remote throws rather than reading as empty", async () => {
    await assert.rejects(() => remoteHasCommits(join(dir, "remotes"), "no-such-repo.git", OPTS.token));
  });
});

describe("provisionProject placement", () => {
  test("clones into an empty slot and never persists the token", async () => {
    const remote = populatedRemote();
    const result = await provisionProject(projectOn("fresh", remote), OPTS);

    assert.deepEqual(result, { ok: true });
    const dest = projectRepoPath("fresh");
    assert.equal(readFileSync(join(dest, "file.txt"), "utf8"), "fixture\n");

    const config = readFileSync(join(dest, ".git", "config"), "utf8");
    assert.equal(config.includes(OPTS.token), false);
    assert.equal(config.includes("x-access-token"), false);
    assert.equal(git(["-C", dest, "remote", "get-url", "origin"]), join(remote.owner, remote.repo));
  });

  test("adopts a clone of the same repo, leaving its contents alone", async () => {
    const remote = populatedRemote();
    const dest = preClone("adopt", remote);
    writeFileSync(join(dest, "sentinel"), "survived\n");

    assert.deepEqual(await provisionProject(projectOn("adopt", remote), OPTS), { ok: true });
    assert.equal(readFileSync(join(dest, "sentinel"), "utf8"), "survived\n");
  });

  test("refuses a slot holding a clone of a different repo", async () => {
    const mine = populatedRemote();
    const stranger = populatedRemote();
    const dest = preClone("mismatch", stranger);

    const message = messageOf(await provisionProject(projectOn("mismatch", mine), OPTS));
    assert.match(message, /already holds a clone of/);
    assert.equal(git(["-C", dest, "remote", "get-url", "origin"]), join(stranger.owner, stranger.repo));
  });

  test("refuses a non-empty directory that is not a repo, without deleting anything", async () => {
    const remote = populatedRemote();
    const dest = projectRepoPath("occupied");
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(dest, "notes.txt"), "not ours\n");

    const message = messageOf(await provisionProject(projectOn("occupied", remote), OPTS));
    assert.match(message, /not a 10x clone/);
    assert.equal(readFileSync(join(dest, "notes.txt"), "utf8"), "not ours\n");
  });

  test("clears a clone that died before .git appeared and clones again", async () => {
    const remote = populatedRemote();
    const dest = projectRepoPath("partial");
    mkdirSync(dest, { recursive: true });

    assert.deepEqual(await provisionProject(projectOn("partial", remote), OPTS), { ok: true });
    assert.equal(readFileSync(join(dest, "file.txt"), "utf8"), "fixture\n");
  });

  test("clears a .git git cannot read and clones again", async () => {
    const remote = populatedRemote();
    const dest = projectRepoPath("corrupt");
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(dest, ".git"), "gitdir: /nowhere\n");

    assert.deepEqual(await provisionProject(projectOn("corrupt", remote), OPTS), { ok: true });
    assert.equal(readFileSync(join(dest, "file.txt"), "utf8"), "fixture\n");
  });

  test("a failure message never repeats the token", async () => {
    // A filesystem remote carries no credentials, so the token is planted in the repo name to
    // make redaction observable; what is under test is that the failure path redacts at all.
    const token = "ghp_planted";
    const project = projectOn("redacted", { owner: join(dir, "remotes"), repo: `missing-${token}.git` });

    const message = messageOf(await provisionProject(project, { ...OPTS, token }));
    assert.equal(message.includes(token), false);
  });
});

describe("provisionProject seeding", () => {
  test("seeds a README on the project's base branch and pushes it", async () => {
    const remote = bareRemote();
    const project = projectOn("seeded", remote);
    const bare = join(remote.owner, remote.repo);

    assert.deepEqual(await provisionProject(project, { ...OPTS, seedInitialCommit: true }), { ok: true });

    const dest = projectRepoPath("seeded");
    assert.equal(git(["-C", dest, "rev-parse", "--abbrev-ref", "HEAD"]), "main");
    assert.equal(git(["-C", bare, "for-each-ref", "--format=%(refname)", "refs/heads"]), "refs/heads/main");
    assert.equal(git(["-C", bare, "show", "main:README.md"]), "# Hearth\n\nA home for the home.");
    assert.equal(git(["-C", bare, "log", "-1", "--format=%an <%ae>", "main"]), "10x <10x@example.com>");
  });

  test("provisioning a seeded project again adds no second commit", async () => {
    const remote = bareRemote();
    const project = projectOn("seeded-twice", remote);
    const bare = join(remote.owner, remote.repo);
    const seed = { ...OPTS, seedInitialCommit: true };

    assert.deepEqual(await provisionProject(project, seed), { ok: true });
    assert.deepEqual(await provisionProject(project, seed), { ok: true });
    assert.equal(git(["-C", bare, "rev-list", "--count", "main"]), "1");
  });

  test("refuses an empty repo when seeding is declined, and writes nothing to the remote", async () => {
    const remote = bareRemote();

    const message = messageOf(await provisionProject(projectOn("unseeded", remote), OPTS));
    assert.match(message, /no commits/);
    assert.match(message, /main branch/);
    assert.equal(await remoteHasCommits(remote.owner, remote.repo, OPTS.token), false);
  });
});
