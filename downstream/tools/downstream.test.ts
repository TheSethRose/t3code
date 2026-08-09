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

function writeChangeRecord(rootDir: string, slug: string, files: ReadonlyArray<string>): void {
  const changesDir = NodePath.join(rootDir, "downstream", "changes");
  NodeFS.mkdirSync(changesDir, { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(changesDir, `${slug}.md`),
    `# ${slug}\n\n## Overlay Files\n\n${files.map((file) => `- \`${file}\``).join("\n")}\n`,
  );
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
  const agentsSkillsDir = NodePath.join(temporaryRoot, ".agents", "skills");

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
    NodeFS.mkdirSync(
      NodePath.join(temporaryRoot, "downstream", "skills", "merge-t3code-downstream"),
      { recursive: true },
    );
    NodeFS.writeFileSync(
      NodePath.join(temporaryRoot, "downstream", "skills", "merge-t3code-downstream", "SKILL.md"),
      "---\nname: merge-t3code-downstream\ndescription: Reconcile downstream.\n---\n",
    );
    NodeFS.mkdirSync(NodePath.join(agentsSkillsDir, "merge-t3code-downstream"), {
      recursive: true,
    });
    NodeFS.writeFileSync(
      NodePath.join(agentsSkillsDir, "merge-t3code-downstream", "stale.txt"),
      "stale\n",
    );
    NodeFS.mkdirSync(NodePath.join(agentsSkillsDir, "unrelated"), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(agentsSkillsDir, "unrelated", "SKILL.md"), "unrelated\n");
    NodeFS.mkdirSync(NodePath.join(temporaryRoot, "downstream", "t3code", "apps", "example"), {
      recursive: true,
    });
    NodeFS.writeFileSync(
      NodePath.join(temporaryRoot, "downstream", "t3code", "apps", "example", "custom.txt"),
      "downstream\n",
    );
    writeChangeRecord(temporaryRoot, "example", ["apps/example/custom.txt"]);

    NodeAssert.equal(initDownstream(temporaryRoot, { agentsSkillsDir }), true);
    NodeAssert.doesNotThrow(() => verifyDownstream(temporaryRoot));

    const result = NodeFS.readFileSync(NodePath.join(temporaryRoot, "AGENTS.md"), "utf8");
    NodeAssert.match(result, /Keep this rule\./);
    NodeAssert.match(result, /Keep this section\./);
    NodeAssert.match(result, /read and follow `downstream\/t3code\/AGENTS\.md`\.$/m);
    NodeAssert.equal(
      NodeFS.readFileSync(NodePath.join(temporaryRoot, "apps", "example", "custom.txt"), "utf8"),
      "downstream\n",
    );
    NodeFS.rmSync(NodePath.join(temporaryRoot, "apps", "example", "custom.txt"));
    NodeAssert.equal(initDownstream(temporaryRoot, { agentsSkillsDir }), true);
    NodeAssert.equal(
      NodeFS.readFileSync(NodePath.join(temporaryRoot, "apps", "example", "custom.txt"), "utf8"),
      "downstream\n",
    );
    NodeAssert.equal(
      NodeFS.readFileSync(
        NodePath.join(agentsSkillsDir, "merge-t3code-downstream", "SKILL.md"),
        "utf8",
      ),
      "---\nname: merge-t3code-downstream\ndescription: Reconcile downstream.\n---\n",
    );
    NodeAssert.equal(
      NodeFS.existsSync(NodePath.join(agentsSkillsDir, "merge-t3code-downstream", "stale.txt")),
      false,
    );
    NodeAssert.equal(
      NodeFS.readFileSync(NodePath.join(agentsSkillsDir, "unrelated", "SKILL.md"), "utf8"),
      "unrelated\n",
    );
    NodeAssert.equal(initDownstream(temporaryRoot, { agentsSkillsDir }), false);
  } finally {
    NodeFS.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

NodeTest.test(
  "rolls upstream main past the latest nightly without rewriting downstream main",
  () => {
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
      commitFile(upstreamSource, "shared.txt", "upstream\nstable\nbase\n", "add shared file");
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
      initDownstream(fork, {
        agentsSkillsDir: NodePath.join(temporaryRoot, ".agents", "skills"),
      });
      NodeFS.writeFileSync(NodePath.join(fork, "shared.txt"), "upstream\nstable\ndownstream\n");
      NodeFS.mkdirSync(NodePath.join(fork, "downstream", "t3code"), { recursive: true });
      NodeFS.writeFileSync(
        NodePath.join(fork, "downstream", "t3code", "shared.txt"),
        "upstream\nstable\ndownstream\n",
      );
      writeChangeRecord(fork, "shared", ["shared.txt"]);
      git(fork, "add", "AGENTS.md", "downstream/t3code/AGENTS.md");
      git(
        fork,
        "add",
        "shared.txt",
        "downstream/t3code/shared.txt",
        "downstream/changes/shared.md",
      );
      git(fork, "commit", "-m", "add downstream instructions and overlay");
      git(fork, "push", "-u", "origin", "main");
      const originalMain = git(fork, "rev-parse", "main");

      commitFile(
        upstreamSource,
        "AGENTS.md",
        "# Upstream instructions\n\nKeep the original rule.\n\nKeep the new nightly rule.\n\n## Dev servers\n\nRun upstream.\n",
        "update upstream instructions",
      );
      commitFile(upstreamSource, "upstream.txt", "second\n", "second nightly");
      commitFile(
        upstreamSource,
        "shared.txt",
        "upstream updated\nstable\nbase\n",
        "update shared file",
      );
      git(upstreamSource, "tag", "v1.0.0-nightly.20260802.2");
      commitFile(upstreamSource, "post-nightly.txt", "tip\n", "advance past nightly");
      git(upstreamSource, "push", "origin", "main", "--tags");

      const result = rollDownstream({ rootDir: fork, quiet: true });
      const upstreamCommit = git(fork, "rev-parse", "upstream/main");

      NodeAssert.equal(result.kind, "merged");
      NodeAssert.equal(result.target, "upstream/main");
      NodeAssert.equal(result.upstreamCommit, upstreamCommit);
      NodeAssert.equal(result.branch, `sync/upstream-${upstreamCommit.slice(0, 12)}`);
      NodeAssert.equal(git(fork, "branch", "--show-current"), result.branch);
      NodeAssert.equal(git(fork, "rev-parse", "origin/main"), originalMain);
      NodeAssert.equal(
        NodeFS.readFileSync(NodePath.join(fork, "downstream.txt"), "utf8"),
        "custom\n",
      );
      NodeAssert.equal(
        NodeFS.readFileSync(NodePath.join(fork, "post-nightly.txt"), "utf8"),
        "tip\n",
      );
      NodeAssert.match(
        NodeFS.readFileSync(NodePath.join(fork, "AGENTS.md"), "utf8"),
        /Keep the new nightly rule\./,
      );
      NodeAssert.equal(
        NodeFS.readFileSync(NodePath.join(fork, "shared.txt"), "utf8"),
        "upstream updated\nstable\ndownstream\n",
      );
      NodeAssert.equal(
        NodeFS.readFileSync(NodePath.join(fork, "downstream", "t3code", "shared.txt"), "utf8"),
        "upstream\nstable\ndownstream\n",
      );
      NodeAssert.throws(() => verifyDownstream(fork), /overlay drifted at shared\.txt/);
      NodeAssert.doesNotThrow(() =>
        git(fork, "merge-base", "--is-ancestor", upstreamCommit, "HEAD"),
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
  },
);

NodeTest.test("rejects orphan, duplicate, and stale overlay ownership", () => {
  const temporaryRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "downstream-owner-"));

  try {
    NodeFS.mkdirSync(NodePath.join(temporaryRoot, "downstream", "t3code"), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(temporaryRoot, "AGENTS.md"), "# Upstream\n");
    NodeFS.writeFileSync(
      NodePath.join(temporaryRoot, "downstream", "t3code", "AGENTS.md"),
      "# Downstream\n",
    );
    NodeFS.writeFileSync(
      NodePath.join(temporaryRoot, "downstream", "t3code", "owned.txt"),
      "owned\n",
    );

    NodeAssert.throws(
      () => initDownstream(temporaryRoot),
      /owned\.txt is not owned by an active change record/,
    );

    writeChangeRecord(temporaryRoot, "one", ["owned.txt"]);
    writeChangeRecord(temporaryRoot, "two", ["owned.txt"]);
    NodeAssert.throws(() => initDownstream(temporaryRoot), /owned by both/);

    NodeFS.rmSync(NodePath.join(temporaryRoot, "downstream", "changes", "two.md"));
    NodeFS.mkdirSync(NodePath.join(temporaryRoot, "downstream", "changes", "Bugs"));
    NodeFS.renameSync(
      NodePath.join(temporaryRoot, "downstream", "changes", "one.md"),
      NodePath.join(temporaryRoot, "downstream", "changes", "Bugs", "one.md"),
    );
    NodeAssert.doesNotThrow(() => initDownstream(temporaryRoot));

    writeChangeRecord(temporaryRoot, "stale", ["missing.txt"]);
    NodeAssert.throws(() => initDownstream(temporaryRoot), /lists missing downstream overlay/);
  } finally {
    NodeFS.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

NodeTest.test("init refuses to overwrite a dirty destination", () => {
  const temporaryRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "downstream-dirty-"));

  try {
    git(temporaryRoot, "init", "-b", "main");
    configureGit(temporaryRoot);
    NodeFS.writeFileSync(NodePath.join(temporaryRoot, "AGENTS.md"), "# Upstream\n");
    NodeFS.writeFileSync(NodePath.join(temporaryRoot, "shared.txt"), "upstream\n");
    git(temporaryRoot, "add", "AGENTS.md", "shared.txt");
    git(temporaryRoot, "commit", "-m", "upstream baseline");
    git(temporaryRoot, "tag", "v1.0.0-nightly.20260808.1");

    NodeFS.mkdirSync(NodePath.join(temporaryRoot, "downstream", "t3code"), { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(temporaryRoot, "downstream", "t3code", "AGENTS.md"),
      "# Downstream\n",
    );
    NodeFS.writeFileSync(
      NodePath.join(temporaryRoot, "downstream", "t3code", "shared.txt"),
      "downstream\n",
    );
    writeChangeRecord(temporaryRoot, "shared", ["shared.txt"]);
    git(temporaryRoot, "add", "downstream");
    git(temporaryRoot, "commit", "-m", "add overlay");

    NodeFS.writeFileSync(NodePath.join(temporaryRoot, "shared.txt"), "unfinished work\n");
    NodeAssert.throws(
      () => initDownstream(temporaryRoot),
      /Refusing to overwrite dirty destination shared\.txt/,
    );
    NodeAssert.equal(
      NodeFS.readFileSync(NodePath.join(temporaryRoot, "AGENTS.md"), "utf8"),
      "# Upstream\n",
    );
    NodeAssert.equal(
      NodeFS.readFileSync(NodePath.join(temporaryRoot, "shared.txt"), "utf8"),
      "unfinished work\n",
    );
  } finally {
    NodeFS.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

NodeTest.test("verify rejects unsupported upstream-file deletion", () => {
  const temporaryRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "downstream-delete-"));

  try {
    git(temporaryRoot, "init", "-b", "main");
    configureGit(temporaryRoot);
    NodeFS.writeFileSync(NodePath.join(temporaryRoot, "AGENTS.md"), "# Upstream\n");
    NodeFS.writeFileSync(NodePath.join(temporaryRoot, "victim.txt"), "keep\n");
    git(temporaryRoot, "add", "AGENTS.md", "victim.txt");
    git(temporaryRoot, "commit", "-m", "upstream baseline");
    git(temporaryRoot, "tag", "v1.0.0-nightly.20260808.1");
    NodeFS.mkdirSync(NodePath.join(temporaryRoot, "downstream", "t3code"), { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(temporaryRoot, "downstream", "t3code", "AGENTS.md"),
      "# Downstream\n",
    );
    initDownstream(temporaryRoot);
    NodeFS.rmSync(NodePath.join(temporaryRoot, "victim.txt"));

    NodeAssert.throws(
      () => verifyDownstream(temporaryRoot),
      /cannot preserve deleted upstream files: victim\.txt/,
    );
  } finally {
    NodeFS.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

NodeTest.test("verify requires mirrored tests to remain excluded", () => {
  const temporaryRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "downstream-tests-"));

  try {
    NodeFS.mkdirSync(NodePath.join(temporaryRoot, "downstream", "t3code"), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(temporaryRoot, "AGENTS.md"), "# Upstream\n");
    NodeFS.writeFileSync(
      NodePath.join(temporaryRoot, "downstream", "t3code", "AGENTS.md"),
      "# Downstream\n",
    );
    NodeFS.writeFileSync(
      NodePath.join(temporaryRoot, "downstream", "t3code", "example.test.ts"),
      "export {}\n",
    );
    writeChangeRecord(temporaryRoot, "test", ["example.test.ts"]);
    initDownstream(temporaryRoot);

    NodeAssert.throws(() => verifyDownstream(temporaryRoot), /Mirrored tests are executable/);
    NodeFS.writeFileSync(
      NodePath.join(temporaryRoot, "vite.config.ts"),
      'export default { test: { exclude: ["**/downstream/t3code/**"] } };\n',
    );
    NodeAssert.doesNotThrow(() => verifyDownstream(temporaryRoot));
  } finally {
    NodeFS.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});
