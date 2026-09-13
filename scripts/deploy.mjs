#!/usr/bin/env node
// Sync this checkout over the copy a dsh profile actually loads.
//
// Why this exists: `dsh plugin ... add <spec>` installs the package INTO the
// profile (a copy in the profile's node_modules), so editing this checkout does
// not change what a running host loads. This script pushes the plugin files
// over that installed copy so a restart picks them up.
//
// Two things it handles that a plain `cp` does not:
//   * pnpm hardlinks an installed file to its content-addressable store, so
//     rewriting it in place would corrupt the store's own copy. Every
//     destination is therefore UNLINKED before it is written.
//   * a profile that installed this checkout as a link already runs this code,
//     so deploy reports that and copies nothing rather than duplicating it.
//
// Usage:
//   npm run deploy                        # profile "web", $DSH_HOME or ~/.dsh
//   npm run deploy -- --profile dev       # another profile
//   npm run deploy -- --dry-run           # report what would change
//   DSH_HOME=/path/to/home npm run deploy
//
// Restart the dsh host afterwards: the host registration and the browser bundle
// graph are both built at boot, and a client bundle's revision is hashed into
// the boot manifest.

import { copyFileSync, existsSync, lstatSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Package root of this checkout (the script lives in scripts/). */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const NAME = MANIFEST.name;

/** Everything the installed package needs at runtime; dev tests stay behind. */
const FILES = [
  "package.json",
  "cordis.patch.yml",
  "README.md",
  "lib/index.js",
  "lib/client.js"
];

function flagValue(flag) {
  const at = process.argv.indexOf(flag);
  if (at === -1) return undefined;
  const next = process.argv[at + 1];
  return next === undefined || next.startsWith("--") ? undefined : next;
}

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log("usage: npm run deploy -- [--profile <name>] [--dry-run]");
  process.exit(0);
}

const dryRun = process.argv.includes("--dry-run");
const profile = flagValue("--profile") || process.env.DSH_PROFILE || "web";
const dshHome = process.env.DSH_HOME || join(homedir(), ".dsh");
const target = join(dshHome, "profiles", profile, "node_modules", NAME);

function fail(lines) {
  for (const line of lines) console.error(line);
  process.exit(1);
}

if (!existsSync(target)) {
  fail([
    "deploy: nothing installed at " + target,
    "",
    "Install the plugin into that profile first, then deploy to sync this checkout over it:",
    "  dsh plugin --profile " + profile + " add " + ROOT,
    "",
    "If that install links this checkout instead of copying it, deploy becomes a no-op by design."
  ]);
}

if (lstatSync(target).isSymbolicLink()) {
  console.log("deploy: " + target + " is a link to this checkout; nothing to copy.");
  console.log("deploy: restart the dsh host to load host-side and bundle changes.");
  process.exit(0);
}

let written = 0;
let current = 0;
let missing = 0;

for (const rel of FILES) {
  const from = join(ROOT, rel);
  const to = join(target, rel);

  if (!existsSync(from)) {
    fail(["deploy: " + rel + " is missing from this checkout; refusing to deploy a partial package."]);
  }

  if (!existsSync(to)) missing++;

  const next = readFileSync(from);
  if (existsSync(to) && readFileSync(to).equals(next)) {
    current++;
    continue;
  }

  written++;
  if (dryRun) {
    console.log("deploy: would write " + rel);
    continue;
  }

  // Unlink first: pnpm hardlinks installed files to its store, and truncating
  // the shared inode in place would rewrite the store's copy too.
  rmSync(to, { force: true });
  copyFileSync(from, to);
  console.log("deploy: wrote " + rel);
}

// The installed manifest is what the loader and the client-modules scanner read,
// so a deploy that loses the browser half would silently drop the settings card.
if (!dryRun) {
  const deployed = JSON.parse(readFileSync(join(target, "package.json"), "utf8"));
  const client = deployed.dsh && deployed.dsh.client;
  const clientExport = deployed.exports && deployed.exports["./client"];
  if (!clientExport || !client || client.platform !== "web") {
    fail([
      "deploy: the installed manifest lost the browser half",
      "deploy: it needs exports['./client'] and dsh.client.platform === 'web', or the",
      "deploy: settings card never enters the client module graph."
    ]);
  }
}

const summary = dryRun ? " (dry run, nothing written)" : "";
console.log("deploy: " + written + " written, " + current + " already current, " + missing + " newly created" + summary);
console.log("deploy: restart the dsh host to load the change - the host registration and");
console.log("deploy: the browser bundle graph are both built at boot.");
