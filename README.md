# dsh-ltm-gate

Hard LTM recall gate for DeepSeek Harness (dsh): blocks every non-LTM tool
call until a memory recall has succeeded once in the session. Ported and
hardened from the pi extension `~/.pi/agent/extensions/ltm-mcp.ts`, whose
gate was prompt-soft; here it is a `tools/pre-execute` denial, so a
non-recalled call cannot execute at all.

Cross-platform (macOS / Linux / Windows). No build step and no scripts in
`package.json` (safe under pnpm >= 10 default build-script blocking): the
browser half is hand-written in the client module system's lazy-CJS factory
format rather than emitted by a bundler.

**What is LTM?** This gate guards a separate memory service, not dsh
itself: the author's
[long-term-memory-mcp](https://github.com/Psynosaur/long-term-memory-mcp)
server — a persistent, project-scoped memory store (SQLite + vector
embeddings) exposed over MCP. It runs on the same machine as dsh and this
plugin only enforces that the agent actually recalls from it before other
tools are allowed.

## How it works

### On session start scoped to project current working directory
<img width="756" height="268" alt="image" src="https://github.com/user-attachments/assets/785171d0-a619-4dfb-b4bc-b393884268c0" />

### and on compact

<img width="806" height="240" alt="image" src="https://github.com/user-attachments/assets/7a109234-cb63-4c15-b4c8-2a7add0bd9e5" />

### by default summary memories are excluded in `get_recent_memories` calls from the `long-term-memory-mcp`


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
node _smoke.mjs         # host half: gate, reminders, compaction storage, settings wiring
node _schema.test.mjs   # the settings schema against the real schemastery
node _client.test.mjs   # browser half: module registration, card, staged writes
```

After install + host restart: Settings > Plugins > Plugin configuration shows
the **LTM gate** card, the market page shows the plugin **live** (via its
bundle patch), and `/ltm` reports gate status in-session.

## Uninstall

```sh
dsh plugin --profile web remove dsh-ltm-gate
```

Reconcile drops it from `dsh.profile.bundles`; restart the host.

## Layout

| Path | Purpose |
| --- | --- |
| `package.json` | Plugin manifest; declares `dsh.bundle.patch` (bundle-layer activation) |
| `lib/index.js` | The gate itself (host plugin): hooks, the memory rules section, and the `ltm-gate` settings namespace |
| `lib/client.js` | Browser half: the Settings > Plugins card, hand-written in the client module system's lazy-CJS factory format (no bundler) |
| `cordis.patch.yml` | Bundle patch: one `insert` row mounting the `ltm-gate` loader entry with its config, which is also the settings `base` |
| `_smoke.mjs` | Host behavioral test (runs the gate against a stub ctx) |
| `_schema.test.mjs` | Settings-schema test against the real schemastery (catches schema-idiom mistakes at test time, not at boot) |
| `_client.test.mjs` | Browser-half test (registers the bundle against a fake loader, then drives the card form) |

## Settings panel (web GUI)

A panel needs **both halves**, and this plugin ships both:

* the **host half** (`lib/index.js`) registers the `ltm-gate` settings
  namespace. The entry config in `cordis.patch.yml` becomes that namespace's
  composition `base` layer; `$DSH_HOME/settings.yaml` layers the user section
  on top; schema defaults sit underneath.
* the **browser half** (`lib/client.js`, declared as `dsh.client` in
  `package.json`) claims the card slot `settings.plugin.item` under the same
  key.

Settings > Plugins > **Plugin configuration** renders the card because of that
pairing: the tab dispatches one card per namespace the Host serves, and a
served namespace that no browser half claims renders nothing. The **Plugin
list** tab is a separate, read-only view of the Loader tree.

The card stages edits and writes them only on **Save** — each field through
the settings scope, fenced with the namespace revision it read, so a form that
drifted from the document is refused instead of overwriting a concurrent
change. **Discard** drops the drafts. A field present in the user layer is
badged **Overridden** and offers **Reset to default**, which clears the
override so the field re-inherits the composed value.

### Adjustable settings

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `prompt` | `full` / `gate` / `off` | `full` | When the mandatory memory rules reach the system prompt: always, only while the gate is closed, or never |
| `promptTemplate` | string (optional) | *(built-in policy)* | Replaces the built-in memory rules wholesale. Placeholders `{project}`, `{server}` and `{tools}` are expanded on every render |
| `serverName` | string | `ltm` | MCP server name; tools are addressed as `mcp__<serverName>__<tool>` |
| `project` | string (optional) | *(derived from cwd)* | Tag/project string passed to recall tools |
| `recallTools` | string[] | `["get_recent_memories"]` | Raw MCP tool names whose success satisfies the gate |
| `allowTools` | string[] | `[]` | Extra tool names allowed while the gate is closed |
| `openAfterFailedRecalls` | number | `3` | Consecutive failed recalls before fail-open |
| `storeOnCompact` | boolean | `true` | Store compaction summaries as session memories |

Changing a value takes effect on the running gate immediately: the host half
watches the namespace and re-resolves the live config on every commit, so no
restart is needed to *edit*. One restart **is** needed after installing or
updating the plugin, because the host registration and the browser bundle graph
are both built at boot.


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
| `promptTemplate` | *(unset)* | Custom memory-rules text; replaces the built-in policy. Supports `{project}`, `{server}` and `{tools}` placeholders |

Every key is also editable at runtime from the settings panel; these values are
the composition `base` that the user layer overrides.