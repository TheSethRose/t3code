#!/usr/bin/env node

// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - Downstream maintenance orchestrates Git and isolated builds before an Effect runtime exists.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

const NIGHTLY_TAG_PATTERN = /^v(\d+)\.(\d+)\.(\d+)-nightly\.(\d{8})\.(\d+)$/;
const ROOT_AGENTS_START = "<!-- downstream-agents:start -->";
const ROOT_AGENTS_END = "<!-- downstream-agents:end -->";
const ROOT_AGENTS_POINTER =
  "This is a maintained downstream build. Before doing any work, read and follow `downstream/t3code/AGENTS.md`.";
const LEGACY_DOWNSTREAM_SKILLS = [
  "build-t3code-downstream",
  "merge-t3code-downstream",
  "reconcile-t3code-downstream-records",
] as const;

export class DownstreamCommandError extends Error {}

export class DownstreamMergeConflictError extends Error {
  readonly branch: string;
  readonly target: string;

  constructor(branch: string, target: string) {
    super(`${target} conflicts with downstream changes on ${branch}.`);
    this.branch = branch;
    this.target = target;
  }
}

interface ParsedNightlyTag {
  readonly version: string;
  readonly date: string;
  readonly run: string;
}

interface RunOptions {
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly quiet?: boolean;
}

export interface DownstreamRollResult {
  readonly kind: "current" | "merged";
  readonly target: "upstream/main";
  readonly upstreamCommit: string;
  readonly branch: string;
  readonly changeRecords: ReadonlyArray<string>;
}

export interface DownstreamInspection {
  readonly target: "upstream/main";
  readonly upstreamCommit: string;
  readonly priorRef: string;
  readonly previousUpstream: string;
  readonly changedPaths: ReadonlyArray<string>;
  readonly intersections: ReadonlyArray<{
    readonly path: string;
    readonly records: ReadonlyArray<string>;
    readonly overlayMatches: boolean;
  }>;
}

interface InitDownstreamOptions {
  readonly agentsSkillsDir?: string;
}

function run(command: string, args: ReadonlyArray<string>, options: RunOptions): string {
  const result = NodeChildProcess.spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    env: options.env,
    stdio: options.quiet ? ["ignore", "pipe", "pipe"] : "inherit",
  });

  if (result.error) {
    throw new DownstreamCommandError(`Could not run ${command}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = options.quiet ? result.stderr.trim() : "";
    throw new DownstreamCommandError(
      `${command} ${args[0] ?? ""} exited with code ${result.status ?? "unknown"}${detail ? `: ${detail}` : ""}.`,
    );
  }

  return options.quiet ? result.stdout.trim() : "";
}

function git(rootDir: string, args: ReadonlyArray<string>): string {
  return run("git", args, { cwd: rootDir, quiet: true });
}

function gitInherit(rootDir: string, args: ReadonlyArray<string>, quiet: boolean): void {
  run("git", args, { cwd: rootDir, quiet });
}

function gitSucceeds(rootDir: string, args: ReadonlyArray<string>): boolean {
  const result = NodeChildProcess.spawnSync("git", args, {
    cwd: rootDir,
    stdio: "ignore",
  });
  if (result.error) {
    throw new DownstreamCommandError(`Could not run git: ${result.error.message}`);
  }
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  throw new DownstreamCommandError(
    `git ${args[0] ?? ""} exited with code ${result.status ?? "unknown"}.`,
  );
}

function resolveRepoRoot(cwd: string): string {
  return git(cwd, ["rev-parse", "--show-toplevel"]);
}

function requireCleanWorktree(rootDir: string): void {
  if (git(rootDir, ["status", "--porcelain"])) {
    throw new DownstreamCommandError("The worktree must be clean before downstream maintenance.");
  }
}

function requireRemote(rootDir: string, name: "origin" | "upstream"): void {
  if (!git(rootDir, ["remote"]).split("\n").includes(name)) {
    throw new DownstreamCommandError(`Required Git remote '${name}' is missing.`);
  }
}

function activeChangeRecords(rootDir: string): ReadonlyArray<string> {
  const changesDir = NodePath.join(rootDir, "downstream", "changes");
  if (!NodeFS.existsSync(changesDir)) return [];

  return filesUnder(changesDir)
    .filter((relativePath) => relativePath.endsWith(".md"))
    .map((relativePath) => NodePath.join("downstream", "changes", relativePath))
    .toSorted();
}

function canonicalOverlayPath(relativePath: string): string {
  return relativePath.split(NodePath.sep).join("/");
}

function changeRecordOverlayFiles(rootDir: string, recordPath: string): ReadonlyArray<string> {
  const lines = NodeFS.readFileSync(NodePath.join(rootDir, recordPath), "utf8").split("\n");
  const headingIndex = lines.findIndex((line) => line.trim() === "## Overlay Files");
  if (headingIndex === -1) {
    throw new DownstreamCommandError(
      `${recordPath} is missing an exact '## Overlay Files' section.`,
    );
  }

  const files: Array<string> = [];
  for (const line of lines.slice(headingIndex + 1)) {
    if (line.startsWith("## ")) break;
    if (!line.trim()) continue;
    const match = /^- `([^`]+)`$/.exec(line.trim());
    if (!match?.[1]) {
      throw new DownstreamCommandError(
        `${recordPath} has an invalid Overlay Files entry: ${line.trim()}`,
      );
    }
    const relativePath = match[1];
    if (
      relativePath.includes("\\") ||
      NodePath.posix.isAbsolute(relativePath) ||
      NodePath.posix.normalize(relativePath) !== relativePath ||
      relativePath === "AGENTS.md" ||
      relativePath.startsWith("downstream/")
    ) {
      throw new DownstreamCommandError(
        `${recordPath} has an invalid repository-relative overlay path: ${relativePath}`,
      );
    }
    files.push(relativePath);
  }
  if (files.length === 0) {
    throw new DownstreamCommandError(`${recordPath} does not list any overlay files.`);
  }
  return files.toSorted();
}

function verifyOverlayOwnership(rootDir: string): void {
  const actualFiles = overlayFiles(rootDir)
    .filter((relativePath) => relativePath !== "AGENTS.md")
    .map(canonicalOverlayPath);
  const owners = new Map<string, string>();

  for (const recordPath of activeChangeRecords(rootDir)) {
    for (const relativePath of changeRecordOverlayFiles(rootDir, recordPath)) {
      const existingOwner = owners.get(relativePath);
      if (existingOwner) {
        throw new DownstreamCommandError(
          `Overlay ${relativePath} is owned by both ${existingOwner} and ${recordPath}.`,
        );
      }
      owners.set(relativePath, recordPath);
    }
  }

  for (const relativePath of actualFiles) {
    if (!owners.has(relativePath)) {
      throw new DownstreamCommandError(
        `Downstream overlay ${relativePath} is not owned by an active change record.`,
      );
    }
  }
  for (const [relativePath, recordPath] of owners) {
    if (!actualFiles.includes(relativePath)) {
      throw new DownstreamCommandError(
        `${recordPath} lists missing downstream overlay ${relativePath}.`,
      );
    }
  }
}

function isGitWorktree(rootDir: string): boolean {
  const result = NodeChildProcess.spawnSync("git", ["rev-parse", "--is-inside-work-tree"], {
    cwd: rootDir,
    stdio: "ignore",
  });
  if (result.error) {
    throw new DownstreamCommandError(`Could not run git: ${result.error.message}`);
  }
  return result.status === 0;
}

function requireSafeOverwrite(rootDir: string, relativePath: string): void {
  if (!isGitWorktree(rootDir)) return;
  if (git(rootDir, ["status", "--porcelain", "--untracked-files=all", "--", relativePath])) {
    throw new DownstreamCommandError(
      `Refusing to overwrite dirty destination ${relativePath}. Reconcile it with its overlay first.`,
    );
  }
}

function requireNoUnsupportedDeletions(rootDir: string): void {
  if (!isGitWorktree(rootDir)) return;
  const tag = git(rootDir, [
    "tag",
    "--merged",
    "HEAD",
    "--list",
    "v*-nightly.*",
    "--sort=-version:refname",
  ])
    .split("\n")
    .find(Boolean);
  if (!tag) return;

  const deleted = git(rootDir, ["diff", "--diff-filter=D", "--name-only", tag, "--"])
    .split("\n")
    .filter((relativePath) => relativePath && !relativePath.startsWith("downstream/"));
  if (deleted.length > 0) {
    throw new DownstreamCommandError(
      `The copy-only downstream overlay cannot preserve deleted upstream files: ${deleted.join(", ")}. Restore them or add a tested tombstone mechanism first.`,
    );
  }
}

function requireOverlayTestsExcluded(rootDir: string): void {
  const hasMirroredTests = overlayFiles(rootDir).some((relativePath) =>
    /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(relativePath),
  );
  if (!hasMirroredTests) return;

  const configPath = NodePath.join(rootDir, "vite.config.ts");
  const config = NodeFS.existsSync(configPath) ? NodeFS.readFileSync(configPath, "utf8") : "";
  if (!/["']\*\*\/downstream\/t3code\/\*\*["']/.test(config)) {
    throw new DownstreamCommandError(
      "Mirrored tests are executable because vite.config.ts does not exclude **/downstream/t3code/**.",
    );
  }
}

function requireDownstreamAgents(rootDir: string): void {
  const sourcePath = NodePath.join(rootDir, "downstream", "t3code", "AGENTS.md");
  if (!NodeFS.existsSync(sourcePath)) {
    throw new DownstreamCommandError(`Downstream instructions are missing: ${sourcePath}`);
  }
}

function filesUnder(directory: string): ReadonlyArray<string> {
  const files: Array<string> = [];
  const visit = (directory: string, prefix = ""): void => {
    for (const entry of NodeFS.readdirSync(directory, { withFileTypes: true })) {
      const relativePath = NodePath.join(prefix, entry.name);
      if (entry.isDirectory()) {
        visit(NodePath.join(directory, entry.name), relativePath);
      } else if (entry.isFile()) {
        files.push(relativePath);
      } else {
        throw new DownstreamCommandError(`Unsupported overlay entry: ${relativePath}`);
      }
    }
  };
  visit(directory);
  return files.toSorted();
}

function overlayFiles(rootDir: string): ReadonlyArray<string> {
  return filesUnder(NodePath.join(rootDir, "downstream", "t3code"));
}

function installDownstreamSkills(rootDir: string, agentsSkillsDir: string): boolean {
  const sourceRoot = NodePath.join(rootDir, "downstream", "skills");
  if (!NodeFS.existsSync(sourceRoot)) return false;

  const entries = NodeFS.readdirSync(sourceRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      throw new DownstreamCommandError(`Unsupported downstream skill entry: ${entry.name}`);
    }
    if (!NodeFS.existsSync(NodePath.join(sourceRoot, entry.name, "SKILL.md"))) {
      throw new DownstreamCommandError(`Downstream skill is missing SKILL.md: ${entry.name}`);
    }
  }

  let changed = false;
  const sourceNames = new Set(entries.map((entry) => entry.name));
  for (const name of LEGACY_DOWNSTREAM_SKILLS) {
    const destinationPath = NodePath.join(agentsSkillsDir, name);
    if (sourceNames.has(name) || !NodeFS.existsSync(destinationPath)) continue;
    NodeFS.rmSync(destinationPath, { recursive: true, force: true });
    changed = true;
  }

  for (const entry of entries) {
    const sourcePath = NodePath.join(sourceRoot, entry.name);
    const destinationPath = NodePath.join(agentsSkillsDir, entry.name);
    const sourceFiles = filesUnder(sourcePath);
    const destinationMatches =
      NodeFS.existsSync(destinationPath) &&
      NodeFS.statSync(destinationPath).isDirectory() &&
      sourceFiles.join("\n") === filesUnder(destinationPath).join("\n") &&
      sourceFiles.every((relativePath) =>
        NodeFS.readFileSync(NodePath.join(sourcePath, relativePath)).equals(
          NodeFS.readFileSync(NodePath.join(destinationPath, relativePath)),
        ),
      );
    if (destinationMatches) continue;

    NodeFS.rmSync(destinationPath, { recursive: true, force: true });
    NodeFS.mkdirSync(agentsSkillsDir, { recursive: true });
    NodeFS.cpSync(sourcePath, destinationPath, { recursive: true });
    changed = true;
  }
  return changed;
}

function rootAgentsBlockRange(
  contents: string,
): { readonly start: number; readonly end: number } | undefined {
  const start = contents.indexOf(ROOT_AGENTS_START);
  const endMarker = contents.indexOf(ROOT_AGENTS_END);
  if (start === -1 && endMarker === -1) return undefined;
  if (start === -1 || endMarker === -1 || endMarker < start) {
    throw new DownstreamCommandError(
      "Root AGENTS.md has incomplete downstream instruction markers.",
    );
  }
  const duplicateStart = contents.indexOf(ROOT_AGENTS_START, start + ROOT_AGENTS_START.length);
  const duplicateEnd = contents.indexOf(ROOT_AGENTS_END, endMarker + ROOT_AGENTS_END.length);
  if (duplicateStart !== -1 || duplicateEnd !== -1) {
    throw new DownstreamCommandError(
      "Root AGENTS.md has duplicate downstream instruction markers.",
    );
  }
  return { start, end: endMarker + ROOT_AGENTS_END.length };
}

export function initDownstream(rootDir: string, options: InitDownstreamOptions = {}): boolean {
  requireDownstreamAgents(rootDir);
  verifyOverlayOwnership(rootDir);
  requireNoUnsupportedDeletions(rootDir);
  const files = overlayFiles(rootDir);
  for (const relativePath of files) {
    const [firstSegment] = relativePath.split(NodePath.sep);
    if (firstSegment === ".git" || firstSegment === "downstream") {
      throw new DownstreamCommandError(`Overlay cannot write protected path: ${relativePath}`);
    }
  }
  const rootAgentsPath = NodePath.join(rootDir, "AGENTS.md");
  const current = NodeFS.readFileSync(rootAgentsPath, "utf8");
  const range = rootAgentsBlockRange(current);
  let updated = current;

  if (range) {
    updated = `${current.slice(0, range.start).trimEnd()}\n\n${current.slice(range.end).trimStart()}`;
  }

  updated = updated
    .split("\n")
    .filter((line) => line !== ROOT_AGENTS_POINTER)
    .join("\n");
  updated = `${updated.trimEnd()}\n\n${ROOT_AGENTS_POINTER}\n`;

  let changed = updated !== current;
  if (changed) requireSafeOverwrite(rootDir, "AGENTS.md");

  const overlayRoot = NodePath.join(rootDir, "downstream", "t3code");
  for (const relativePath of files) {
    if (relativePath === "AGENTS.md") continue;
    const sourcePath = NodePath.join(overlayRoot, relativePath);
    const destinationPath = NodePath.join(rootDir, relativePath);
    if (
      NodeFS.existsSync(destinationPath) &&
      !NodeFS.readFileSync(destinationPath).equals(NodeFS.readFileSync(sourcePath))
    ) {
      requireSafeOverwrite(rootDir, relativePath);
    }
  }

  const skillsChanged = installDownstreamSkills(
    rootDir,
    options.agentsSkillsDir ?? NodePath.join(NodeOS.homedir(), ".agents", "skills"),
  );
  if (changed) NodeFS.writeFileSync(rootAgentsPath, updated);

  for (const relativePath of files) {
    if (relativePath === "AGENTS.md") continue;
    const sourcePath = NodePath.join(overlayRoot, relativePath);
    const destinationPath = NodePath.join(rootDir, relativePath);
    const source = NodeFS.readFileSync(sourcePath);
    if (NodeFS.existsSync(destinationPath) && NodeFS.readFileSync(destinationPath).equals(source)) {
      continue;
    }
    NodeFS.mkdirSync(NodePath.dirname(destinationPath), { recursive: true });
    NodeFS.copyFileSync(sourcePath, destinationPath);
    changed = true;
  }
  return changed || skillsChanged;
}

export function verifyDownstream(rootDir: string): void {
  requireDownstreamAgents(rootDir);
  verifyOverlayOwnership(rootDir);
  requireNoUnsupportedDeletions(rootDir);
  requireOverlayTestsExcluded(rootDir);
  const contents = NodeFS.readFileSync(NodePath.join(rootDir, "AGENTS.md"), "utf8");
  const pointers = contents.split("\n").filter((line) => line === ROOT_AGENTS_POINTER);
  if (
    pointers.length !== 1 ||
    !contents.trimEnd().endsWith(ROOT_AGENTS_POINTER) ||
    contents.includes(ROOT_AGENTS_START) ||
    contents.includes(ROOT_AGENTS_END)
  ) {
    throw new DownstreamCommandError(
      "Root AGENTS.md is missing its final downstream pointer. Run the init command.",
    );
  }

  const overlayRoot = NodePath.join(rootDir, "downstream", "t3code");
  for (const relativePath of overlayFiles(rootDir)) {
    if (relativePath === "AGENTS.md") continue;
    const destinationPath = NodePath.join(rootDir, relativePath);
    if (
      !NodeFS.existsSync(destinationPath) ||
      !NodeFS.readFileSync(destinationPath).equals(
        NodeFS.readFileSync(NodePath.join(overlayRoot, relativePath)),
      )
    ) {
      throw new DownstreamCommandError(
        `Downstream overlay drifted at ${relativePath}. Run the init command.`,
      );
    }
  }
}

export function inspectDownstream(rootDir: string): DownstreamInspection {
  const target = "upstream/main" as const;
  const upstreamCommit = git(rootDir, ["rev-parse", target]);
  const mergeHead = gitSucceeds(rootDir, ["rev-parse", "--verify", "--quiet", "MERGE_HEAD"]);
  const secondParent = gitSucceeds(rootDir, ["rev-parse", "--verify", "--quiet", "HEAD^2"])
    ? git(rootDir, ["rev-parse", "HEAD^2"])
    : undefined;
  const priorRef = mergeHead ? "HEAD" : secondParent === upstreamCommit ? "HEAD^1" : "HEAD";
  const previousUpstream = git(rootDir, ["merge-base", priorRef, upstreamCommit]);
  const changedPaths = git(rootDir, [
    "diff",
    "--name-only",
    `${previousUpstream}..${upstreamCommit}`,
  ])
    .split("\n")
    .filter(Boolean)
    .toSorted();
  const owners = new Map<string, Array<string>>();

  for (const recordPath of activeChangeRecords(rootDir)) {
    for (const relativePath of changeRecordOverlayFiles(rootDir, recordPath)) {
      const records = owners.get(relativePath) ?? [];
      records.push(recordPath);
      owners.set(relativePath, records);
    }
  }

  const overlayRoot = NodePath.join(rootDir, "downstream", "t3code");
  const intersections = overlayFiles(rootDir)
    .filter((relativePath) => relativePath !== "AGENTS.md")
    .map(canonicalOverlayPath)
    .filter((relativePath) => changedPaths.includes(relativePath))
    .map((relativePath) => {
      const normalPath = NodePath.join(rootDir, relativePath);
      const overlayPath = NodePath.join(overlayRoot, relativePath);
      return {
        path: relativePath,
        records: owners.get(relativePath)?.toSorted() ?? [],
        overlayMatches:
          NodeFS.existsSync(normalPath) &&
          NodeFS.readFileSync(normalPath).equals(NodeFS.readFileSync(overlayPath)),
      };
    });

  return {
    target,
    upstreamCommit,
    priorRef,
    previousUpstream,
    changedPaths,
    intersections,
  };
}

export function parseNightlyTag(tag: string): ParsedNightlyTag {
  const match = NIGHTLY_TAG_PATTERN.exec(tag);
  if (!match) {
    throw new DownstreamCommandError(
      `Invalid nightly tag '${tag}'. Expected vX.Y.Z-nightly.YYYYMMDD.RUN.`,
    );
  }

  const [, major, minor, patch, date, runNumber] = match;
  if (!major || !minor || !patch || !date || !runNumber) {
    throw new DownstreamCommandError(`Could not parse nightly tag '${tag}'.`);
  }

  return {
    version: `${major}.${minor}.${patch}`,
    date,
    run: runNumber,
  };
}

export function resolveDownstreamBuildVersion(tag: string, commit: string): string {
  const nightly = parseNightlyTag(tag);
  if (!/^[0-9a-f]{7,40}$/i.test(commit)) {
    throw new DownstreamCommandError(`Invalid Git commit '${commit}'.`);
  }
  return `${nightly.version}-downstream.${nightly.date}.${nightly.run}.${commit.toLowerCase()}`;
}

export function rollDownstream(
  options: {
    readonly rootDir?: string;
    readonly quiet?: boolean;
  } = {},
): DownstreamRollResult {
  const rootDir = resolveRepoRoot(options.rootDir ?? process.cwd());
  const quiet = options.quiet ?? false;
  requireCleanWorktree(rootDir);

  const branch = git(rootDir, ["branch", "--show-current"]);
  if (branch !== "main") {
    throw new DownstreamCommandError(
      `Run the upstream sync from main, not '${branch || "detached HEAD"}'.`,
    );
  }

  requireRemote(rootDir, "origin");
  requireRemote(rootDir, "upstream");
  gitInherit(rootDir, ["fetch", "origin", "--prune"], quiet);
  gitInherit(rootDir, ["fetch", "upstream", "--tags", "--prune"], quiet);
  gitInherit(rootDir, ["merge", "--ff-only", "origin/main"], quiet);

  const target = "upstream/main" as const;
  const upstreamCommit = git(rootDir, ["rev-parse", target]);
  const syncBranch = `sync/upstream-${upstreamCommit.slice(0, 12)}`;
  const changeRecords = activeChangeRecords(rootDir);

  if (gitSucceeds(rootDir, ["merge-base", "--is-ancestor", upstreamCommit, "HEAD"])) {
    return {
      kind: "current",
      target,
      upstreamCommit,
      branch,
      changeRecords,
    };
  }

  for (const ref of [`refs/heads/${syncBranch}`, `refs/remotes/origin/${syncBranch}`]) {
    if (gitSucceeds(rootDir, ["show-ref", "--verify", "--quiet", ref])) {
      throw new DownstreamCommandError(
        `Branch '${syncBranch}' already exists. Finish or remove that roll before starting another.`,
      );
    }
  }

  gitInherit(rootDir, ["switch", "-c", syncBranch], quiet);
  const merge = NodeChildProcess.spawnSync("git", ["merge", "--no-ff", upstreamCommit], {
    cwd: rootDir,
    encoding: "utf8",
    stdio: quiet ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (merge.error) {
    throw new DownstreamCommandError(`Could not run git merge: ${merge.error.message}`);
  }
  if (merge.status !== 0) {
    if (gitSucceeds(rootDir, ["rev-parse", "--verify", "--quiet", "MERGE_HEAD"])) {
      throw new DownstreamMergeConflictError(syncBranch, target);
    }
    throw new DownstreamCommandError(
      `git merge exited with code ${merge.status ?? "unknown"}${quiet && merge.stderr.trim() ? `: ${merge.stderr.trim()}` : ""}.`,
    );
  }

  return {
    kind: "merged",
    target,
    upstreamCommit,
    branch: syncBranch,
    changeRecords,
  };
}

function linkWorktreeEnv(sourceRoot: string, worktreeRoot: string): void {
  for (const relativePath of [".env", NodePath.join("infra", "relay", ".env")]) {
    const sourcePath = NodePath.join(sourceRoot, relativePath);
    if (!NodeFS.existsSync(sourcePath)) continue;
    const destinationPath = NodePath.join(worktreeRoot, relativePath);
    NodeFS.mkdirSync(NodePath.dirname(destinationPath), { recursive: true });
    NodeFS.symlinkSync(sourcePath, destinationPath, "file");
  }
}

export function buildDownstream(options: { readonly rootDir?: string } = {}): {
  readonly version: string;
  readonly outputDir: string;
} {
  const rootDir = resolveRepoRoot(options.rootDir ?? process.cwd());
  verifyDownstream(rootDir);
  requireCleanWorktree(rootDir);

  const tag = git(rootDir, ["describe", "--tags", "--match", "v*-nightly.*", "--abbrev=0"]);
  const commit = git(rootDir, ["rev-parse", "--short=12", "HEAD"]);
  const version = resolveDownstreamBuildVersion(tag, commit);
  const outputDir = NodePath.join(rootDir, "release", "downstream");
  const temporaryRoot = NodeFS.mkdtempSync(
    NodePath.join(NodeOS.tmpdir(), "t3code-downstream-build-"),
  );
  const worktreeRoot = NodePath.join(temporaryRoot, "workspace");

  try {
    run("git", ["worktree", "add", "--detach", worktreeRoot, "HEAD"], { cwd: rootDir });
    linkWorktreeEnv(rootDir, worktreeRoot);
    run("vp", ["install", "--frozen-lockfile"], { cwd: worktreeRoot });
    run(process.execPath, ["scripts/update-release-package-versions.ts", version], {
      cwd: worktreeRoot,
    });
    run("vp", ["install", "--lockfile-only"], { cwd: worktreeRoot });

    const buildEnv: NodeJS.ProcessEnv = { ...process.env, APP_VERSION: version };
    delete buildEnv.T3CODE_DESKTOP_UPDATE_REPOSITORY;
    delete buildEnv.GITHUB_REPOSITORY;
    run("vp", ["run", "dist:desktop:artifact", "--output-dir", outputDir], {
      cwd: worktreeRoot,
      env: buildEnv,
    });
  } finally {
    NodeChildProcess.spawnSync("git", ["worktree", "remove", "--force", worktreeRoot], {
      cwd: rootDir,
      stdio: "ignore",
    });
    NodeChildProcess.spawnSync("git", ["worktree", "prune"], {
      cwd: rootDir,
      stdio: "ignore",
    });
    NodeFS.rmSync(temporaryRoot, { recursive: true, force: true });
  }

  return { version, outputDir };
}

function printChangeRecords(records: ReadonlyArray<string>): void {
  if (records.length === 0) {
    console.log("Active downstream changes: none");
    return;
  }
  console.log("Active downstream changes:");
  for (const record of records) console.log(`- ${record}`);
}

function printRollResult(result: DownstreamRollResult): void {
  if (result.kind === "current") {
    console.log(`Downstream main already contains upstream/main at ${result.upstreamCommit}.`);
    printChangeRecords(result.changeRecords);
    return;
  }

  console.log(`Merged upstream/main at ${result.upstreamCommit} into ${result.branch}.`);
  printChangeRecords(result.changeRecords);
  console.log("Next: use $t3-sync to reconcile every overlay before running init.");
  console.log("Then run active change validation followed by:");
  console.log("  vp node downstream/tools/downstream.ts init");
  console.log("  vp node downstream/tools/downstream.ts inspect");
  console.log("Build a DMG separately only when explicitly needed.");
}

function printInspection(result: DownstreamInspection): void {
  console.log(`Target: ${result.target} at ${result.upstreamCommit}`);
  console.log(`Previous upstream: ${result.previousUpstream} via ${result.priorRef}`);
  console.log(`Upstream-changed paths: ${result.changedPaths.length}`);
  if (result.intersections.length === 0) {
    console.log("Overlay intersections: none");
    return;
  }
  console.log("Overlay intersections:");
  for (const intersection of result.intersections) {
    const records =
      intersection.records.length === 0 ? "ownerless" : intersection.records.join(", ");
    console.log(
      `- ${intersection.path} (${records}; ${intersection.overlayMatches ? "matching" : "reconciliation required"})`,
    );
  }
}

function main(): void {
  const { positionals } = NodeUtil.parseArgs({
    allowPositionals: true,
    strict: true,
  });
  const [command, ...extra] = positionals;
  if (
    extra.length > 0 ||
    (command !== "roll" &&
      command !== "build" &&
      command !== "init" &&
      command !== "inspect" &&
      command !== "verify")
  ) {
    throw new DownstreamCommandError("Usage: downstream <init | roll | inspect | build | verify>");
  }
  const rootDir = resolveRepoRoot(process.cwd());
  if (command === "init") {
    console.log(
      initDownstream(rootDir)
        ? "Initialized downstream overlays and skills."
        : "Downstream overlays and skills are already initialized.",
    );
    return;
  }
  if (command === "verify") {
    verifyDownstream(rootDir);
    console.log("Downstream overlay is applied, including the final root AGENTS.md pointer.");
    return;
  }
  if (command === "inspect") {
    printInspection(inspectDownstream(rootDir));
    return;
  }
  if (command === "build") {
    const result = buildDownstream();
    console.log(`Built downstream ${result.version} in ${result.outputDir}.`);
    return;
  }

  printRollResult(rollDownstream());
}

if (import.meta.main) {
  try {
    main();
  } catch (error) {
    if (error instanceof DownstreamMergeConflictError) {
      console.error(error.message);
      console.error("Use $t3-sync to resolve conflicts and reconcile every overlay.");
      console.error("After both copies match, run:");
      console.error("  vp node downstream/tools/downstream.ts init");
      console.error("Review and add every resolved and applied file before committing the merge.");
      console.error("Use 'git merge --abort' to return to downstream main.");
    } else {
      console.error(error instanceof Error ? error.message : String(error));
    }
    process.exitCode = 1;
  }
}
