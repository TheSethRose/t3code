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

export class DownstreamCommandError extends Error {}

export class DownstreamMergeConflictError extends Error {
  readonly branch: string;
  readonly tag: string;

  constructor(branch: string, tag: string) {
    super(`Nightly ${tag} conflicts with downstream changes on ${branch}.`);
    this.branch = branch;
    this.tag = tag;
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
  readonly tag: string;
  readonly branch: string;
  readonly changeRecords: ReadonlyArray<string>;
  readonly overlayChanged: boolean;
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

  return NodeFS.readdirSync(changesDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => NodePath.join("downstream", "changes", entry.name))
    .toSorted();
}

function requireDownstreamAgents(rootDir: string): void {
  const sourcePath = NodePath.join(rootDir, "downstream", "t3code", "AGENTS.md");
  if (!NodeFS.existsSync(sourcePath)) {
    throw new DownstreamCommandError(`Downstream instructions are missing: ${sourcePath}`);
  }
}

function overlayFiles(rootDir: string): ReadonlyArray<string> {
  const overlayRoot = NodePath.join(rootDir, "downstream", "t3code");
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
  visit(overlayRoot);
  return files.toSorted();
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

export function initDownstream(rootDir: string): boolean {
  requireDownstreamAgents(rootDir);
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
  if (changed) NodeFS.writeFileSync(rootAgentsPath, updated);

  const overlayRoot = NodePath.join(rootDir, "downstream", "t3code");
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
  return changed;
}

export function verifyDownstream(rootDir: string): void {
  requireDownstreamAgents(rootDir);
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

function resolveNightlyTag(rootDir: string, requestedTag?: string): string {
  if (requestedTag) {
    parseNightlyTag(requestedTag);
    if (!gitSucceeds(rootDir, ["show-ref", "--verify", "--quiet", `refs/tags/${requestedTag}`])) {
      throw new DownstreamCommandError(`Nightly tag '${requestedTag}' was not found after fetch.`);
    }
    return requestedTag;
  }

  const tag = git(rootDir, ["tag", "--list", "v*-nightly.*", "--sort=-version:refname"])
    .split("\n")
    .find(Boolean);
  if (!tag) throw new DownstreamCommandError("No published nightly tags were found after fetch.");
  parseNightlyTag(tag);
  return tag;
}

export function rollDownstream(
  options: {
    readonly rootDir?: string;
    readonly tag?: string;
    readonly quiet?: boolean;
  } = {},
): DownstreamRollResult {
  const rootDir = resolveRepoRoot(options.rootDir ?? process.cwd());
  const quiet = options.quiet ?? false;
  requireCleanWorktree(rootDir);

  const branch = git(rootDir, ["branch", "--show-current"]);
  if (branch !== "main") {
    throw new DownstreamCommandError(
      `Run the nightly roll from main, not '${branch || "detached HEAD"}'.`,
    );
  }

  requireRemote(rootDir, "origin");
  requireRemote(rootDir, "upstream");
  gitInherit(rootDir, ["fetch", "origin", "--prune"], quiet);
  gitInherit(rootDir, ["fetch", "upstream", "--tags", "--prune"], quiet);
  gitInherit(rootDir, ["merge", "--ff-only", "origin/main"], quiet);

  const tag = resolveNightlyTag(rootDir, options.tag);
  const nightly = parseNightlyTag(tag);
  const syncBranch = `sync/nightly-${nightly.date}.${nightly.run}`;
  const changeRecords = activeChangeRecords(rootDir);

  if (gitSucceeds(rootDir, ["merge-base", "--is-ancestor", tag, "HEAD"])) {
    return {
      kind: "current",
      tag,
      branch,
      changeRecords,
      overlayChanged: initDownstream(rootDir),
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
  const merge = NodeChildProcess.spawnSync("git", ["merge", "--no-ff", tag], {
    cwd: rootDir,
    encoding: "utf8",
    stdio: quiet ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (merge.error) {
    throw new DownstreamCommandError(`Could not run git merge: ${merge.error.message}`);
  }
  if (merge.status !== 0) {
    if (gitSucceeds(rootDir, ["rev-parse", "--verify", "--quiet", "MERGE_HEAD"])) {
      throw new DownstreamMergeConflictError(syncBranch, tag);
    }
    throw new DownstreamCommandError(
      `git merge exited with code ${merge.status ?? "unknown"}${quiet && merge.stderr.trim() ? `: ${merge.stderr.trim()}` : ""}.`,
    );
  }

  return {
    kind: "merged",
    tag,
    branch: syncBranch,
    changeRecords,
    overlayChanged: initDownstream(rootDir),
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
    console.log(`Downstream main already contains ${result.tag}.`);
    printChangeRecords(result.changeRecords);
    if (result.overlayChanged) {
      console.log("Applied the downstream overlay; review and commit the resulting files.");
    }
    return;
  }

  console.log(`Merged ${result.tag} into ${result.branch}.`);
  printChangeRecords(result.changeRecords);
  if (result.overlayChanged) {
    console.log("Applied the downstream overlay; review and commit the resulting files.");
  }
  console.log("Next: review active changes, run their validation, then run:");
  console.log("  vp run build:desktop");
  console.log("  vp node downstream/tools/downstream.ts build");
  console.log(`  git push -u origin ${result.branch}`);
}

function main(): void {
  const { values, positionals } = NodeUtil.parseArgs({
    allowPositionals: true,
    options: {
      tag: { type: "string" },
    },
    strict: true,
  });
  const [command, ...extra] = positionals;
  if (
    extra.length > 0 ||
    (command !== "roll" && command !== "build" && command !== "init" && command !== "verify")
  ) {
    throw new DownstreamCommandError(
      "Usage: downstream <init | roll [--tag TAG] | build | verify>",
    );
  }
  const rootDir = resolveRepoRoot(process.cwd());
  if (command === "init") {
    if (values.tag) throw new DownstreamCommandError("--tag is only valid with roll.");
    console.log(
      initDownstream(rootDir)
        ? "Applied the downstream overlay."
        : "Downstream overlay is already applied.",
    );
    return;
  }
  if (command === "verify") {
    if (values.tag) throw new DownstreamCommandError("--tag is only valid with roll.");
    verifyDownstream(rootDir);
    console.log("Downstream overlay is applied, including the final root AGENTS.md pointer.");
    return;
  }
  if (command === "build") {
    if (values.tag) throw new DownstreamCommandError("--tag is only valid with roll.");
    const result = buildDownstream();
    console.log(`Built downstream ${result.version} in ${result.outputDir}.`);
    return;
  }

  printRollResult(rollDownstream(values.tag ? { tag: values.tag } : {}));
}

if (import.meta.main) {
  try {
    main();
  } catch (error) {
    if (error instanceof DownstreamMergeConflictError) {
      console.error(error.message);
      console.error("Resolve the conflicts, review downstream/changes, then run:");
      console.error("  vp node downstream/tools/downstream.ts init");
      console.error("Review and add every resolved and applied file before committing the merge.");
      console.error("Use 'git merge --abort' to return to downstream main.");
    } else {
      console.error(error instanceof Error ? error.message : String(error));
    }
    process.exitCode = 1;
  }
}
