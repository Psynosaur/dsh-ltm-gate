# Changelog

All notable changes to **dsh-ltm-gate** are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the plugin uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
