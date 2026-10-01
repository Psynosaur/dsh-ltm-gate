# Changelog

All notable changes to **dsh-ltm-gate** are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the plugin uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Budgeted recall.** `prompt: "slim"` renders the short working rules always and the SESSION START
  bootstrap only while the gate is closed (`full` keeps the bootstrap in every prompt, `gate` hides the
  rules once satisfied, `off` disables the section). A `promptTemplate` still replaces the policy
  wholesale and now wins in every mode.
- **`recallArgs`** (default `{limit:5, scope:"project", detail:"digest", snippet_chars:200,
  include_summaries:true}`) is merged into the mandatory bootstrap recall and rendered as JSON in the
  deny message, the per-step reminder and the bootstrap block - an index instead of every body.
- **`compactMaxChars`** (default 4000) clips the verbatim recap stored from a `compaction/summary`,
  keeps a pointer to the transcript, and tags the memory `session:<id>`.
- **`projectRecall` / `maxRecallChars`** (true / 8000): post-execute projection drops preferences that
  cannot apply here (not project-tagged, not broad-tagged, not importance >= 9 within 30 days) and holds
  the payload to a character budget, keeping the JSON valid with a `projected` note.
- **`storeGate` / `writeTools`** (`remind` / `["write","edit"]`): a file-changing turn that stored
  nothing produces a reminder, or in `block` mode denies non-memory tools until a store lands.
- **Quality-aware gate**: a successful recall only opens the gate when its arguments name the current
  project or deliberately ask for a shaped slice.

### Changed

- The rules text teaches what the budget assumes: cheap digest first, expand only what you need, never
  print a raw recall payload, `file_paths` required for code facts, search before storing.
- `cordis.patch.yml` ships `prompt: slim`, `recallArgs`, `compactMaxChars` and `storeOnCompact`.
- All six new keys are in `settingsSchema` and validated in `resolveConfig`; the Settings card still
  renders upstream's row set, so they are set through the cordis config or `settings.yaml` today.

### Files

- `lib/index.js` - prompt modes, `recallArgsFor`, projection, quality gate, store gate, clipped
  compaction storage, on top of the 0.2.0 settings/MCP namespaces.
- `cordis.patch.yml`, `README.md` (config table), `_smoke.mjs` (86 assertions: S1/S2/S3 plus new S5
  projection/gate-quality and S6 store-gate blocks).

## [0.2.0] - 2026-09-13

### Added

- **LTM MCP server card.** Settings > Plugins > Plugin configuration now shows a
  second card (`mcp-ltm` namespace) that configures the `mcp-ltm` MCP client
  entry the gate's memory tools come from. It is served only while that loader
  entry exists, and the entry's own config is the composition base; each save is
  projected onto the live entry through `ctx.loader.update` - a fiber update,
  not a YAML rewrite - so `settings.yaml` stays the durable override and the
  YAML row keeps the deployment default. A value that did not change is never
  pushed, so an untouched namespace cannot restart the memory connection.
- The card exposes every option `@deepseek-ai/dsh-mcp-client` accepts for that
  entry: `transport`, `serverName`, `url`, `headers`, `command`, `args`,
  `env`, `cwd`, `toolCallTimeoutMs`, `failOnStartupError` and the four
  `reconnect*` fields. Rows are transport-scoped, `headers`/`env` take one
  `Name: value` per line, and `reconnect.*` is flattened in the panel and
  nested again on the entry.
- **`rememberTool` gate setting** (default `remember`) for the raw MCP tool
  name the direct compaction call uses. Every key is now editable from the panel
  and mirrored in `cordis.patch.yml`.
- Browser-half and schema test suites: `_client.test.mjs` drives both card
  forms, and `_schema.test.mjs` exercises the schemas against the real
  schemastery. It also pins **card/schema field parity**, so a card row with no
  matching schema entry fails in the suite instead of at Save time.

### Changed

- The compaction path now posts to the **configured** endpoint with the
  configured headers and tool name instead of a hardcoded
  `http://127.0.0.1:8000/mcp/`. Under the `stdio` transport that direct call is
  skipped with a single log line, because it speaks streamable HTTP only.
- The per-step reminder and the SESSION START rule now name `recallTools[0]`, so
  the mandated call is one that actually satisfies the gate rather than a
  hardcoded `get_recent_memories`.
- `/ltm` reports the endpoint and tool the direct call targets.
- `cordis.patch.yml` mirrors the full gate config (`storeOnCompact` plus the
  optional keys, commented), and the README documents both cards and the
  `mcp-ltm` row as the MCP card's base.
- `@deepseek-ai/dsh-settings` bumped from `^0.1.1-rc.2` to `^0.1.5-rc.2` to match
  the peer range of `@deepseek-ai/dsh-llm@^0.1.5-rc.2`; the dependency tree now
  installs without `--legacy-peer-deps`.

### Fixed

- The browser half is the two-card implementation again: the MCP connection card
  and the card chrome (shared stylesheet, no inline styles) had been replaced by
  an earlier single-card revision, which left the panel serving a namespace no
  card claimed and thirty browser-half assertions failing.
- The host half's `mcp-ltm` registration is no longer inert. It previously
  registered the namespace with a hardcoded base, never watched its scope and
  never injected the loader, so saving the card changed nothing.

[0.2.0]: https://github.com/Psynosaur/dsh-ltm-gate/releases/tag/v0.2.0
