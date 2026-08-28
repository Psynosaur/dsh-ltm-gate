# dsh-ltm-gate

Hard LTM recall gate for DeepSeek Harness (dsh): blocks every non-LTM tool
call until a memory recall has succeeded once in the session. Ported and
hardened from the pi extension `~/.pi/agent/extensions/ltm-mcp.ts`, whose
gate was prompt-soft; here it is a `tools/pre-execute` denial, so a
non-recalled call cannot execute at all.

Cross-platform (macOS / Linux / Windows). No build step and no scripts in
`package.json` (safe under pnpm >= 10 default build-script blocking).

**What is LTM?** This gate guards a separate memory service, not dsh
itself: the author's
[long-term-memory-mcp](https://github.com/Psynosaur/long-term-memory-mcp)
server — a persistent, project-scoped memory store (SQLite + vector
embeddings) exposed over MCP. It runs on the same machine as dsh and this
plugin only enforces that the agent actually recalls from it before other
tools are allowed.

## How it works

| Layer | Hook | Behaviour |
| --- | --- | --- |
| 1 | `tools/pre-execute` | Hard deny of every non-LTM tool call while the gate is closed. The `run_code` transport (Code Mode) stays callable so recall remains reachable — no deadlock; its non-LTM sub-dispatches are gated like any other call. |
| 2 | `tools/post-execute` | First successful recall opens the gate for that agent, tracked **in process memory** (per agent). After N (default 3) consecutive failed recalls the gate fail-opens so a dead memory server never bricks the agent. |
| 3 | `systemPrompt` | `ltm:policy` section: the mandatory recall/remember rules. |
| 4 | `agent/pre-step` | One reminder message per step while the gate is closed. |
| 5 | `session/event` | On `compaction/summary`, store the summary text **verbatim** via `remember(title, content, memory_type="summary", tags="project,<project>,session", importance=6)`. Title is `fact: compact <project>`. |

`/ltm` reports live gate status in-session.

**Satisfaction is not durable.** Gate state lives in the host process: after
a session resume or fork the gate starts closed and the agent recalls once —
exactly what the injected SESSION START rule mandates. This is deliberate
(see below) and costs one tool call per new session.

### Why no durable recall event

An earlier revision recorded the first recall as a log-only `ltm/recall`
session event via `session.append`, so the open gate would survive resume.
On stock v1 harnesses that made every such session **unloadable**:
`@deepseek-ai/dsh-session-persistence` rejects any event type outside its
generated `KNOWN_SESSION_EVENT_TYPES` catalog unless the envelope carries
`ignorable: true`; plugin event types are deliberately absent from the
catalog; and `Session.append` exposes no way to set the marker.

The market release therefore keeps no persistent trace of the recall. Trade:
one extra recall call after resume/fork. Gain: sessions stay plain stock
JSONL — nothing to patch, repair, or explain on a fresh machine.

## Prerequisites on the target machine

1. **LTM MCP server** reachable at `http://127.0.0.1:8000/mcp` — the
   [long-term-memory-mcp](https://github.com/Psynosaur/long-term-memory-mcp)
   server (adjust `serverName` in the config if yours differs).
2. **An `mcp-ltm` row** in the profile's user-layer `cordis.patch.yml`:

   ```yaml
   - insert:
       - id: mcp-ltm
         name: '@deepseek-ai/dsh-mcp-client'
         config:
           serverName: ltm
           transport: streamable-http
           url: http://127.0.0.1:8000/mcp
   ```

3. **dshmarket** in the profile, for one-click market installs only:

   ```sh
   dsh plugin --profile web add dshmarket
   ```

## Install

### Direct from GitHub (recommended)

`dsh plugin` forwards to pnpm in the profile directory, so any pnpm spec
works. This repo is installed straight from GitHub — it is not published to
npm:

```sh
dsh plugin --profile web add github:Psynosaur/dsh-ltm-gate    # this repo
dsh plugin --profile web add /abs/path/to/dsh-ltm-gate        # local checkout
```

The package declares `dsh.bundle.patch`, so the CLI's reconcile step adds
it to `dsh.profile.bundles` automatically — no manual bundle registration.
The loader entry comes from the package's own `cordis.patch.yml`; never
duplicate the `ltm-gate` insert in the profile user layer (a duplicate
loader id fails boot).

Then **restart the dsh host**.

### From the dsh market (one-click, once listed)

`dshmarket` is a web-GUI plugin: open the market page in the dsh web GUI
and install **dsh-ltm-gate** from its card. Market installs are restricted to
sources listed in the [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)
registry (live at awesome-dsh-plugin.com/plugins.json); the entry points at
this repo's `github:` source — no npm package is involved.

## Listing on the marketplace

PR one entry to <https://github.com/awesome-dsh-plugin/awesome-dsh-plugin>
pointing at this repo — that registry is what dshmarket installs from. The
plugin is not published to npm; the registry entry uses the `github:` source
directly.

## Verify

```sh
node _smoke.mjs   # behavioral smoke test (stub ctx; cross-platform)
```

After install + host restart: the market page shows the plugin **live** (via
its bundle patch), and `/ltm` reports gate status in-session.

## Uninstall

```sh
dsh plugin --profile web remove dsh-ltm-gate
```

Reconcile drops it from `dsh.profile.bundles`; restart the host.

## Layout

| Path | Purpose |
| --- | --- |
| `package.json` | Plugin manifest; declares `dsh.bundle.patch` (bundle-layer activation) |
| `lib/index.js` | The gate itself (host plugin) |
| `cordis.patch.yml` | Bundle patch: one `insert` row mounting the `ltm-gate` loader entry with its config |
| `_smoke.mjs` | Behavioral smoke test (runs the gate against a stub ctx) |

## Config

Keys in the `cordis.patch.yml` insert value:

| Key | Default | Notes |
| --- | --- | --- |
| `serverName` | `ltm` | MCP server name; tools are addressed as `mcp__<serverName>__<tool>` |
| `recallTools` | `["get_recent_memories"]` | Raw MCP tool names (no prefix) whose success satisfies the gate |
| `allowTools` | `[]` | Extra tool names allowed while the gate is closed |
| `openAfterFailedRecalls` | `3` | Consecutive failed recalls before fail-open |
| `prompt` | `full` | `full` (all rules) / `gate` (hide rules once satisfied) / `off` |
| `project` | *(derived from cwd)* | Tag/project string passed to recall tools |
| `storeOnCompact` | `true` | When the harness emits `compaction/summary`, store that summary verbatim as `memory_type="summary"` titled `fact: compact <project>`, tags `project,<project>,session`, importance 6 |
