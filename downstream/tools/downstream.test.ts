// @effect-diagnostics nodeBuiltinImport:off - Tests build isolated Git repositories on disk.
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";

import {
  DownstreamCommandError,
  initDownstream,
  parseNightlyTag,
  resolveDownstreamBuildVersion,
  rollDownstream,
  verifyDownstream,
} from "./downstream.ts";

function git(cwd: string, ...args: ReadonlyArray<string>): string {
  return NodeChildProcess.execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function configureGit(cwd: string): void {
  git(cwd, "config", "user.name", "Downstream Test");
  git(cwd, "config", "user.email", "downstream@example.com");
}

function commitFile(cwd: string, name: string, contents: string, message: string): void {
  NodeFS.writeFileSync(NodePath.join(cwd, name), contents);
  git(cwd, "add", name);
  git(cwd, "commit", "-m", message);
}

NodeTest.test("derives branch and artifact metadata from a published nightly tag", () => {
  NodeAssert.deepStrictEqual(parseNightlyTag("v1.2.3-nightly.20260808.1035"), {
    version: "1.2.3",
    date: "20260808",
    run: "1035",
  });
  NodeAssert.equal(
    resolveDownstreamBuildVersion("v1.2.3-nightly.20260808.1035", "ABCDEF123456"),
    "1.2.3-downstream.20260808.1035.abcdef123456",
  );
});

NodeTest.test("appends the downstream pointer without replacing upstream instructions", () => {
  const temporaryRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "downstream-agents-"));

  try {
    NodeFS.mkdirSync(NodePath.join(temporaryRoot, "downstream", "t3code"), { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(temporaryRoot, "AGENTS.md"),
      "# Upstream instructions\n\nKeep this rule.\n\n## Dev servers\n\nKeep this section.\n",
    );
    NodeFS.writeFileSync(
      NodePath.join(temporaryRoot, "downstream", "t3code", "AGENTS.md"),
      "## Downstream build\n\nThis is the canonical downstream rule.\n",
    );
    NodeFS.mkdirSync(NodePath.join(temporaryRoot, "downstream", "t3code", "apps", "example"), {
      recursive: true,
    });
    NodeFS.writeFileSync(
      NodePath.join(temporaryRoot, "downstream", "t3code", "apps", "example", "custom.txt"),
      "downstream\n",
    );

    NodeAssert.equal(initDownstream(temporaryRoot), true);
    NodeAssert.doesNotThrow(() => verifyDownstream(temporaryRoot));

    const result = NodeFS.readFileSync(NodePath.join(temporaryRoot, "AGENTS.md"), "utf8");
    NodeAssert.match(result, /Keep this rule\./);
    NodeAssert.match(result, /Keep this section\./);
    NodeAssert.match(result, /read and follow `downstream\/t3code\/AGENTS\.md`\.$/m);
    NodeAssert.equal(
      NodeFS.readFileSync(NodePath.join(temporaryRoot, "apps", "example", "custom.txt"), "utf8"),
      "downstream\n",
    );
    NodeAssert.equal(initDownstream(temporaryRoot), false);
  } finally {
    NodeFS.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

NodeTest.test("rolls a newer nightly over downstream commits without rewriting main", () => {
  const temporaryRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "downstream-roll-"));
  const upstreamSource = NodePath.join(temporaryRoot, "upstream-source");
  const upstreamRemote = NodePath.join(temporaryRoot, "upstream.git");
  const originRemote = NodePath.join(temporaryRoot, "origin.git");
  const fork = NodePath.join(temporaryRoot, "fork");

  try {
    NodeFS.mkdirSync(upstreamSource);
    git(upstreamSource, "init", "-b", "main");
    configureGit(upstreamSource);
    commitFile(
      upstreamSource,
      "AGENTS.md",
      "# Upstream instructions\n\nKeep the original rule.\n\n## Dev servers\n\nRun upstream.\n",
      "add upstream instructions",
    );
    commitFile(upstreamSource, "upstream.txt", "first\n", "first nightly");
    git(upstreamSource, "tag", "v1.0.0-nightly.20260801.1");

    git(temporaryRoot, "init", "--bare", "--initial-branch=main", upstreamRemote);
    git(upstreamSource, "remote", "add", "origin", upstreamRemote);
    git(upstreamSource, "push", "origin", "main", "--tags");

    git(temporaryRoot, "clone", upstreamRemote, fork);
    configureGit(fork);
    git(fork, "remote", "rename", "origin", "upstream");
    git(temporaryRoot, "init", "--bare", "--initial-branch=main", originRemote);
    git(fork, "remote", "add", "origin", originRemote);
    commitFile(fork, "downstream.txt", "custom\n", "downstream change");
    NodeFS.mkdirSync(NodePath.join(fork, "downstream", "t3code"), { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(fork, "downstream", "t3code", "AGENTS.md"),
      "## Downstream build\n\nThis checkout is the downstream build.\n",
    );
    initDownstream(fork);
    git(fork, "add", "AGENTS.md", "downstream/t3code/AGENTS.md");
    git(fork, "commit", "-m", "add downstream instructions");
    git(fork, "push", "-u", "origin", "main");
    const originalMain = git(fork, "rev-parse", "main");

    commitFile(
      upstreamSource,
      "AGENTS.md",
      "# Upstream instructions\n\nKeep the original rule.\n\nKeep the new nightly rule.\n\n## Dev servers\n\nRun upstream.\n",
      "update upstream instructions",
    );
    commitFile(upstreamSource, "upstream.txt", "second\n", "second nightly");
    git(upstreamSource, "tag", "v1.0.0-nightly.20260802.2");
    git(upstreamSource, "push", "origin", "main", "--tags");

    const result = rollDownstream({ rootDir: fork, quiet: true });

    NodeAssert.equal(result.kind, "merged");
    NodeAssert.equal(result.tag, "v1.0.0-nightly.20260802.2");
    NodeAssert.equal(result.branch, "sync/nightly-20260802.2");
    NodeAssert.equal(git(fork, "branch", "--show-current"), result.branch);
    NodeAssert.equal(git(fork, "rev-parse", "origin/main"), originalMain);
    NodeAssert.equal(
      NodeFS.readFileSync(NodePath.join(fork, "downstream.txt"), "utf8"),
      "custom\n",
    );
    NodeAssert.match(
      NodeFS.readFileSync(NodePath.join(fork, "AGENTS.md"), "utf8"),
      /Keep the new nightly rule\./,
    );
    NodeAssert.doesNotThrow(() => verifyDownstream(fork));
    NodeAssert.doesNotThrow(() =>
      git(fork, "merge-base", "--is-ancestor", "v1.0.0-nightly.20260802.2", "HEAD"),
    );

    NodeFS.writeFileSync(NodePath.join(fork, "uncommitted.txt"), "dirty\n");
    let dirtyWorktreeError: unknown;
    try {
      rollDownstream({ rootDir: fork, quiet: true });
    } catch (error) {
      dirtyWorktreeError = error;
    }
    NodeAssert.ok(dirtyWorktreeError instanceof DownstreamCommandError);
    NodeAssert.match(dirtyWorktreeError.message, /must be clean/);
  } finally {
    NodeFS.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});
