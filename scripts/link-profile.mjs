#!/usr/bin/env node
/**
 * link-profile.mjs — link THIS plugin checkout into a dsh profile.
 *
 * Cross-platform (Windows / Linux / macOS): pure Node, no shell builtins, no
 * `cp`, no hardcoded drive letters or `~` expansion. Run it from the repo root:
 *
 *   npm run deploy                    # link into ~/.dsh/profiles/web
 *   npm run deploy -- --profile <dir> # link into another profile
 *   npm run deploy -- --check         # report only, change nothing
 *   npm run deploy -- --no-install    # edit the manifest, skip pnpm install
 *
 * What it does:
 *   1. adds/updates "<this package>": "link:<this checkout>" in
 *      <profile>/package.json dependencies, replacing any github:/file: spec
 *   2. runs `pnpm install` in the profile so the link is materialized and
 *      stale copies of this plugin are pruned
 *   3. prints where the profile now resolves this plugin from
 *
 * Why link: instead of copying build output: the profile then always runs the
 * code in this checkout (rebuild + host restart is the whole deploy), on every
 * machine, and there is no copy step to drift or forget.
 *
 * Keeping the versions aligned after a dsh harness update is the same on all
 * three OSes: run `npm run deploy` in each local plugin repo. The profile must
 * NOT pin @deepseek-ai/* packages — the harness installation supplies them
 * (see this repo's peerDependencies), so a harness update can never skew them.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repoDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = join(repoDir, "package.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const name = manifest.name;

// ---- arguments -------------------------------------------------------------
const argv = process.argv.slice(2);
const flag = (long) => argv.includes(long);
const value = (long) => {
  const i = argv.indexOf(long);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : undefined;
};

const check = flag("--check");
const noInstall = flag("--no-install");
const profileDir = resolve(value("--profile") ?? process.env.DSH_PROFILE ?? join(homedir(), ".dsh", "profiles", "web"));
const profileManifestPath = join(profileDir, "package.json");

if (!existsSync(profileManifestPath)) {
  console.error(`link-profile: no dsh profile manifest at ${profileManifestPath}`);
  console.error("            (pass --profile <dir> or set DSH_PROFILE)");
  process.exit(1);
}

// ---- 1. point the profile at this checkout ---------------------------------
const profile = JSON.parse(readFileSync(profileManifestPath, "utf8"));
profile.dependencies ??= {};
const previous = profile.dependencies[name];
// pnpm wants forward slashes in link: specs on Windows too.
const spec = "link:" + repoDir.split(sep).join("/");
profile.dependencies[name] = spec;

// Diagnostic: the classic post-update breakage is a profile pinning
// @deepseek-ai/* below the harness version, which shadows the harness copy.
const skew = Object.keys(profile.dependencies).filter((dep) => dep.startsWith("@deepseek-ai/"));

console.log(`link-profile: plugin   ${name} @ ${repoDir}`);
console.log(`link-profile: profile  ${profileDir}`);
console.log(`link-profile: spec     ${spec}${previous && previous !== spec ? `   (was: ${previous})` : ""}`);
if (skew.length > 0) {
  console.warn(`link-profile: WARNING — profile pins ${skew.join(", ")}`);
  console.warn("             these shadow the harness's own copies and break after every harness update;");
  console.warn("             remove them (the harness installation supplies @deepseek-ai/* for plugins).");
}

if (check) {
  console.log("link-profile: --check, nothing written");
  process.exit(0);
}

if (previous === spec) {
  console.log("link-profile: manifest already points here");
} else {
  writeFileSync(profileManifestPath, JSON.stringify(profile, undefined, 2) + "\n");
  console.log(`link-profile: wrote ${profileManifestPath}`);
}

// ---- 2. materialize the link (and prune stale copies) ----------------------
if (noInstall) {
  console.log("link-profile: --no-install, run `pnpm install` in " + profileDir + " to materialize the link");
  process.exit(0);
}
const run = (cmd, args) => spawnSync(cmd, args, { cwd: profileDir, stdio: "inherit", shell: process.platform === "win32" });
let install = run("pnpm", ["install"]);
if (install.error) {
  console.warn("link-profile: pnpm not on PATH, falling back to npx pnpm");
  install = run("npx", ["--yes", "pnpm", "install"]);
}
if (install.status !== 0) {
  console.error("link-profile: pnpm install failed — run it manually in " + profileDir);
  process.exit(install.status ?? 1);
}

// ---- 3. verify -------------------------------------------------------------
const linkedPath = join(profileDir, "node_modules", ...name.split("/"));
if (!existsSync(linkedPath)) {
  console.error(`link-profile: ${linkedPath} does not exist after install`);
  process.exit(1);
}
console.log(`link-profile: OK — ${name} resolves from ${linkedPath} -> ${repoDir}`);
