/**
 * dsh-ltm-gate — hard LTM recall gate for DeepSeek Harness.
 *
 * Blocks every non-LTM tool call until a configured memory-recall tool has
 * succeeded once in the calling agent's session. Ported and hardened from the
 * pi extension ~/.pi/agent/extensions/ltm-mcp.ts, whose gate was prompt-soft;
 * here the gate is a tools/pre-execute denial, so a non-recalled call cannot
 * execute at all.
 *
 * Layers:
 *   1. tools/pre-execute  — hard deny of every non-LTM tool call while the
 *      gate is unsatisfied. Code Mode: the run_code transport stays callable
 *      so recall remains reachable (no deadlock); its non-LTM sub-dispatches
 *      (exec.parent set) are gated like any other tool call.
 *   2. tools/post-execute — tracks the first successful recall in process
 *      memory, per agent: the gate stays open for the rest of that agent's
 *      lifetime. Satisfaction is deliberately NOT durable: v1 session
 *      persistence has no catalog entry for plugin event types and
 *      Session.append cannot mark events ignorable, so a durable plugin
 *      event would make the session unloadable on stock harnesses. A resume
 *      or fork therefore starts with the gate CLOSED and the agent recalls
 *      once — exactly what the mandatory SESSION START rule asks for.
 *      Fail-opens the gate after N consecutive failed recalls (memory server
 *      down) so the agent is never bricked.
 *   3. systemPrompt section — the mandatory memory rules (ltm:policy).
 *   4. agent/pre-step     — per-step reminder message while unsatisfied.
 *   5. session/event      — on compaction/summary, call the MCP server directly
 *      via fetch (bypasses ToolRuntime Code Mode collapse) and store the summary
 *      verbatim as a session summary for the project.
 *
 * Config: { serverName, recallTools, allowTools, openAfterFailedRecalls,
 *           prompt, project, storeOnCompact, promptTemplate, rememberTool }
 *
 * The same keys ride the `ltm-gate` settings namespace when the deployment
 * mounts a settings provider, so the browser Settings > Plugins > Plugin
 * configuration card edits exactly what the composition can: entry config is
 * the `base` layer, the user document section overrides it, and each change
 * re-resolves the live config through the namespace watch.
 */
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import z from "@deepseek-ai/schemastery";

export const name = "ltm-gate";
export const inject = ["tools", "systemPrompt", "sessions"];

const PLUGIN = "ltm-gate";
const SETTINGS_NS = "ltm-gate";

// The MCP server this gate guards is a separate loader entry (`mcp-ltm` in the
// profile's cordis.patch.yml). It gets its own settings namespace so the panel
// can configure the connection itself - transport, endpoint, headers, timeouts,
// reconnect policy - instead of leaving the operator to hand-edit YAML for the
// half of the picture this plugin depends on.
const MCP_SETTINGS_NS = "mcp-ltm";
const MCP_ENTRY_ID = "mcp-ltm";
/** Fallbacks for the direct calls when no mcp-ltm entry/namespace is available. */
const DEFAULT_MCP_URL = "http://127.0.0.1:8000/mcp/";
const DEFAULT_REMEMBER_TOOL = "remember";

/** Join compaction summary text blocks without rewriting them. */
export function verbatimSummary(blocks) {
  if (!Array.isArray(blocks)) return "";
  let out = "";
  for (const block of blocks) {
    if (block && block.type === "text" && typeof block.text === "string") out += block.text;
  }
  return out;
}

/** Title that marks the memory as a compact for the project tag. */
export function compactMemoryTitle(project) {
  return `fact: compact ${project}`;
}

/** Sanitize a value destined for prompt/tag interpolation (pi-compatible). */
export function sanitizeProject(raw) {
  const s = String(raw ?? "").trim();
  const cleaned = s
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/["'`\\]/g, "")
    .replace(/[$][{]/g, "");
  const slug = cleaned.replace(/[^A-Za-z0-9._\-+@]/g, "-").replace(/-+/g, "-");
  return slug.replace(/^[-.]+|[-.]+$/g, "") || "unknown";
}

// Settings schema for the LTM gate configuration
// The settings namespace schema. schemastery, not zod: enums are unions of
// consts, integrality is `natural()`, optionality is `required(false)`, and the
// doc hook is `description()`.
export const settingsSchema = z.object({
  serverName: z.string()
    .min(1)
    .max(32)
    .description("MCP server name; tools are addressed as mcp__<serverName>__<tool>"),
  recallTools: z.array(z.string())
    .min(1)
    .description("Raw MCP tool names (no prefix) whose success satisfies the gate"),
  allowTools: z.array(z.string())
    .description("Extra tool names allowed while the gate is closed"),
  openAfterFailedRecalls: z.natural()
    .min(1)
    .description("Consecutive failed recalls before fail-open"),
  prompt: z.union([z.const("full"), z.const("gate"), z.const("off")])
    .description("Prompt mode: full (all rules), gate (hide rules once satisfied), off"),
  project: z.string()
    .required(false)
    .description("Tag/project string passed to recall tools (derived from cwd if omitted)"),
  storeOnCompact: z.boolean()
    .description("Store compaction summaries as session memories"),
  rememberTool: z.string()
    .required(false)
    .description("Raw MCP tool name the direct compaction call uses (default remember)"),
  promptTemplate: z.string()
    .required(false)
    .description("Custom memory-rules text; replaces the built-in policy. Supports {project}, {server} and {tools} placeholders"),
});

/**
 * The `mcp-ltm` settings scope: the connection options
 * `@deepseek-ai/dsh-mcp-client` accepts for the entry this gate depends on.
 *
 * Every field is optional except `transport`: the composition base is the live
 * entry config, so an absent field means "leave whatever the YAML entry says"
 * (or, when neither says anything, the bridge's own default). No schema default
 * is declared on purpose - a default here would make the resolved value differ
 * from the entry on every boot and force a needless reconnect.
 *
 * `reconnect` is flattened (reconnectEnabled / reconnectInitialDelayMs / ...)
 * because the panel edits one flat row per value; the host nests it again when
 * it projects a value onto the entry.
 */
export const mcpSettingsSchema = z.object({
  transport: z.union([z.const("stdio"), z.const("streamable-http")])
    .required()
    .description("MCP transport; selects whether the url/headers or the command/args/env/cwd fields apply"),
  serverName: z.string()
    .required(false)
    .description("MCP server namespace; must match the LTM gate's MCP server name"),
  url: z.string()
    .required(false)
    .description("Streamable-HTTP endpoint of the MCP server"),
  headers: z.dict(String)
    .required(false)
    .description("Extra HTTP headers sent to a streamable-http server"),
  command: z.string()
    .required(false)
    .description("Executable a stdio server is spawned from"),
  args: z.array(String)
    .required(false)
    .description("Arguments passed to a stdio server"),
  env: z.dict(String)
    .required(false)
    .description("Extra environment entries for a stdio server"),
  cwd: z.string()
    .required(false)
    .description("Working directory for a stdio server"),
  toolCallTimeoutMs: z.natural()
    .required(false)
    .description("Per-call timeout in milliseconds (bridge default 60000)"),
  failOnStartupError: z.boolean()
    .required(false)
    .description("Fail host boot when the first connection or tool sync fails"),
  reconnectEnabled: z.boolean()
    .required(false)
    .description("Reconnect after a lost connection"),
  reconnectInitialDelayMs: z.natural()
    .required(false)
    .description("First reconnect delay in milliseconds"),
  reconnectMaxDelayMs: z.natural()
    .required(false)
    .description("Max reconnect delay in milliseconds"),
  reconnectMaxAttempts: z.natural()
    .required(false)
    .description("Consecutive reconnect attempts before giving up"),
});

/** True for a plain object whose every value is a string (an MCP header/env map). */
export function isStringDict(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return Object.values(value).every((entry) => typeof entry === "string");
}

/**
 * Project an mcp-client entry config into the flat scope shape.
 *
 * The result is used twice: as the namespace composition base, and as the
 * comparison target that decides whether a settings commit actually differs
 * from what the entry already runs (an unchanged value must not restart the
 * connection). Only keys this scope models survive, so the projection is
 * idempotent and never invents a key the entry did not have. The container
 * keys are always materialized because schemastery resolves `dict`/`array`
 * fields to `{}`/`[]` even when absent - without them the base would differ
 * from its own resolution on every boot.
 * @param raw - the entry's current config object.
 * @returns The flat scope value (no transport key when the entry has none).
 */
export function mcpSettingsBase(raw) {
  const config = raw && typeof raw === "object" ? raw : {};
  const base = {};
  if (config.transport === "stdio" || config.transport === "streamable-http") base.transport = config.transport;
  for (const key of ["serverName", "url", "command", "cwd"]) {
    if (typeof config[key] === "string") base[key] = config[key];
  }
  base.args = Array.isArray(config.args) && config.args.every((entry) => typeof entry === "string") ? [...config.args] : [];
  base.env = isStringDict(config.env) ? { ...config.env } : {};
  base.headers = isStringDict(config.headers) ? { ...config.headers } : {};
  if (Number.isInteger(config.toolCallTimeoutMs)) base.toolCallTimeoutMs = config.toolCallTimeoutMs;
  if (typeof config.failOnStartupError === "boolean") base.failOnStartupError = config.failOnStartupError;
  const reconnect = config.reconnect && typeof config.reconnect === "object" ? config.reconnect : {};
  if (typeof reconnect.enabled === "boolean") base.reconnectEnabled = reconnect.enabled;
  if (Number.isInteger(reconnect.initialDelayMs)) base.reconnectInitialDelayMs = reconnect.initialDelayMs;
  if (Number.isInteger(reconnect.maxDelayMs)) base.reconnectMaxDelayMs = reconnect.maxDelayMs;
  if (Number.isInteger(reconnect.maxAttempts)) base.reconnectMaxAttempts = reconnect.maxAttempts;
  return base;
}

/**
 * Build the mcp-client entry config for one resolved scope value.
 *
 * Returns undefined when the value cannot describe a viable entry - an unknown
 * transport, or the one field that transport requires (url for streamable-http,
 * command for stdio). The caller then warns instead of pushing a config the
 * bridge's own union schema would reject at runtime.
 * @param value - flat scope value.
 * @param fallbackServerName - the entry's current serverName, kept when unset.
 * @returns The wire config, or undefined when it would be invalid.
 */
export function mcpEntryConfig(value, fallbackServerName) {
  const v = value && typeof value === "object" ? value : {};
  if (v.transport !== "stdio" && v.transport !== "streamable-http") return undefined;
  const serverName = typeof v.serverName === "string" && v.serverName !== "" ? v.serverName : fallbackServerName;
  if (typeof serverName !== "string" || serverName === "") return undefined;
  const config = { transport: v.transport, serverName };
  if (v.transport === "stdio") {
    if (typeof v.command !== "string" || v.command === "") return undefined;
    config.command = v.command;
    config.args = Array.isArray(v.args) ? [...v.args] : [];
    config.env = isStringDict(v.env) ? { ...v.env } : {};
    config.cwd = typeof v.cwd === "string" ? v.cwd : "";
  } else {
    if (typeof v.url !== "string" || v.url === "") return undefined;
    config.url = v.url;
    config.headers = isStringDict(v.headers) ? { ...v.headers } : {};
  }
  if (Number.isInteger(v.toolCallTimeoutMs)) config.toolCallTimeoutMs = v.toolCallTimeoutMs;
  if (typeof v.failOnStartupError === "boolean") config.failOnStartupError = v.failOnStartupError;
  const reconnect = {};
  if (typeof v.reconnectEnabled === "boolean") reconnect.enabled = v.reconnectEnabled;
  if (Number.isInteger(v.reconnectInitialDelayMs)) reconnect.initialDelayMs = v.reconnectInitialDelayMs;
  if (Number.isInteger(v.reconnectMaxDelayMs)) reconnect.maxDelayMs = v.reconnectMaxDelayMs;
  if (Number.isInteger(v.reconnectMaxAttempts)) reconnect.maxAttempts = v.reconnectMaxAttempts;
  if (Object.keys(reconnect).length > 0) config.reconnect = reconnect;
  return config;
}

/**
 * Structural equality over JSON-shaped values, insensitive to key order.
 *
 * Both sides of the comparison are flat projections of the same field set, so
 * a missing key is a real difference (a cleared field must reach the entry, not
 * be mistaken for "unchanged").
 */
export function sameSettingsValue(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((entry, index) => sameSettingsValue(entry, b[index]));
  }
  if (a && b && typeof a === "object") {
    const left = Object.keys(a).sort();
    const right = Object.keys(b).sort();
    if (left.length !== right.length) return false;
    return left.every((key, index) => key === right[index] && sameSettingsValue(a[key], b[key]));
  }
  return false;
}

function resolveConfig(config = {}, settings = null) {
  // Merge config: settings override config
  const merged = { ...config };
  if (settings) {
    for (const key of Object.keys(settings)) {
      if (settings[key] !== undefined) {
        merged[key] = settings[key];
      }
    }
  }

  const known = ["serverName", "recallTools", "allowTools", "openAfterFailedRecalls", "prompt", "project", "storeOnCompact", "promptTemplate", "rememberTool"];
  const unknown = Object.keys(merged).filter((key) => !known.includes(key));
  if (unknown.length > 0) {
    throw new Error(`${PLUGIN}: unknown config key(s) ${unknown.join(", ")}; config is { serverName, recallTools, allowTools, openAfterFailedRecalls, prompt, project, storeOnCompact, promptTemplate, rememberTool }`);
  }

  const out = {
    serverName: merged.serverName ?? "ltm",
    recallTools: merged.recallTools ?? ["get_recent_memories"],
    allowTools: merged.allowTools ?? [],
    openAfterFailedRecalls: merged.openAfterFailedRecalls ?? 3,
    prompt: merged.prompt ?? "full",
    project: merged.project,
    storeOnCompact: merged.storeOnCompact ?? true,
    rememberTool: typeof merged.rememberTool === "string" && merged.rememberTool.trim() !== ""
      ? merged.rememberTool
      : undefined,
    promptTemplate: typeof merged.promptTemplate === "string" && merged.promptTemplate.trim() !== ""
      ? merged.promptTemplate
      : undefined,
  };

  // Validate
  if (typeof out.serverName !== "string" || !/^[A-Za-z0-9_-]{1,32}$/.test(out.serverName)) {
    throw new Error(`${PLUGIN}: serverName must be a string matching [A-Za-z0-9_-]{1,32}`);
  }
  if (!Array.isArray(out.recallTools) || out.recallTools.length === 0 || out.recallTools.some((t) => typeof t !== "string")) {
    throw new Error(`${PLUGIN}: recallTools must be a non-empty list of raw MCP tool names (without the mcp__ prefix)`);
  }
  if (!Array.isArray(out.allowTools) || out.allowTools.some((t) => typeof t !== "string")) {
    throw new Error(`${PLUGIN}: allowTools must be a list of tool names`);
  }
  if (!Number.isInteger(out.openAfterFailedRecalls) || out.openAfterFailedRecalls < 1) {
    throw new Error(`${PLUGIN}: openAfterFailedRecalls must be a positive integer`);
  }
  if (!["full", "gate", "off"].includes(out.prompt)) {
    throw new Error(`${PLUGIN}: prompt must be one of: full, gate, off`);
  }
  if (out.project !== undefined && (typeof out.project !== "string" || out.project.trim() === "")) {
    throw new Error(`${PLUGIN}: project must be a non-empty string`);
  }
  if (typeof out.storeOnCompact !== "boolean") {
    throw new Error(`${PLUGIN}: storeOnCompact must be a boolean`);
  }
  if (out.promptTemplate !== undefined && typeof out.promptTemplate !== "string") {
    throw new Error(`${PLUGIN}: promptTemplate must be a string`);
  }
  if (out.rememberTool !== undefined && typeof out.rememberTool !== "string") {
    throw new Error(`${PLUGIN}: rememberTool must be a string`);
  }

  return out;
}

export function apply(ctx, config = {}) {
  let cfg;
  let recallSet = new Set();
  let allowSet = new Set();

  // Last adopted `mcp-ltm` settings value, and the connection the direct
  // (non-ToolRuntime) calls use. Kept in one place so the compaction path
  // follows exactly what the MCP card shows instead of a hardcoded localhost
  // endpoint that silently drifts from the entry the tools really come from.
  let mcpValue = null;
  let warnedStdioCompact = false;
  let direct = { url: DEFAULT_MCP_URL, headers: {}, tool: DEFAULT_REMEMBER_TOOL };

  const refreshDirect = () => {
    const tool = typeof cfg.rememberTool === "string" && cfg.rememberTool.trim() !== ""
      ? cfg.rememberTool.trim()
      : DEFAULT_REMEMBER_TOOL;
    const overHttp = mcpValue !== null
      && mcpValue.transport === "streamable-http"
      && typeof mcpValue.url === "string"
      && mcpValue.url.trim() !== "";
    direct = {
      url: overHttp ? mcpValue.url.trim() : DEFAULT_MCP_URL,
      headers: overHttp && isStringDict(mcpValue.headers) ? { ...mcpValue.headers } : {},
      tool,
    };
  };

  const warn = (message, ...args) => {
    try {
      if (ctx.logger && typeof ctx.logger.warn === "function") ctx.logger.warn(message, ...args);
    } catch {
      /* logging must never throw */
    }
  };

  /** Re-resolve config and rebuild the derived lookups from one settings view. */
  const derive = (settings) => {
    cfg = resolveConfig(config, settings);
    recallSet = new Set(cfg.recallTools.map((raw) => `mcp__${cfg.serverName}__${raw}`));
    allowSet = new Set(cfg.allowTools);
    refreshDirect();
  };

  derive(null);
  const entry = cfg;

  // The namespace exists only when the deployment mounts a settings provider.
  // Registration is therefore an optional injection: without one the gate keeps
  // running on entry config alone, exactly as it did before settings existed. A
  // duplicate registration (a preset realm mounting this plugin twice) would fail
  // loud, so the registration rides the plugin fiber and disposes with it.
  ctx.inject(["settings"], (settingsCtx) => {
    const scope = settingsCtx.settings.register(SETTINGS_NS, settingsSchema, {
      base: {
        serverName: entry.serverName,
        recallTools: entry.recallTools,
        allowTools: entry.allowTools,
        openAfterFailedRecalls: entry.openAfterFailedRecalls,
        prompt: entry.prompt,
        project: entry.project,
        storeOnCompact: entry.storeOnCompact,
        rememberTool: entry.rememberTool,
      },
    });
    const adopt = (next) => {
      try {
        derive(next);
      } catch (err) {
        warn(`${PLUGIN}: ignoring a settings view that failed to resolve: ${String(err)}`);
      }
    };
    adopt(scope.get());
    scope.watch((next) => adopt(next));
  });

  // The MCP connection card. Its namespace is served only when both halves
  // exist: a settings provider AND the `mcp-ltm` loader entry it configures.
  // The entry config is the composition base, the user document is the durable
  // override, and every commit is projected onto the live entry through the
  // loader service. `Entry.update` passes `noSave`, so this reconfigures the
  // running bridge and leaves the YAML file alone: the file stays the default
  // the panel falls back to, not a second owner of the same value.
  ctx.inject(["settings", "loader"], (mcpCtx) => {
    const loader = mcpCtx.loader;
    if (!loader || typeof loader.entries !== "function") return;
    const findEntry = () => {
      for (const candidate of loader.entries()) {
        if (candidate && candidate.options && candidate.options.id === MCP_ENTRY_ID) return candidate;
      }
      return undefined;
    };
    const attach = (target) => {
      const base = mcpSettingsBase(target.options.config);
      if (base.transport === undefined) {
        warn(`${PLUGIN}: ${MCP_ENTRY_ID} declares no transport; the MCP connection card stays unavailable`);
        return;
      }
      let scope;
      try {
        scope = mcpCtx.settings.register(MCP_SETTINGS_NS, mcpSettingsSchema, { base });
      } catch (err) {
        warn(`${PLUGIN}: could not serve the ${MCP_ENTRY_ID} settings namespace from its entry config: ${String(err)}`);
        return;
      }
      const applyToEntry = (next) => {
        mcpValue = next;
        refreshDirect();
        const current = findEntry();
        if (current === undefined) return Promise.resolve();
        const currentBase = mcpSettingsBase(current.options.config);
        // Unchanged values must not restart the bridge: the initial adopt is a
        // no-op whenever the document carries no override for this namespace.
        if (sameSettingsValue(currentBase, next)) return Promise.resolve();
        const nextConfig = mcpEntryConfig(next, currentBase.serverName);
        if (nextConfig === undefined) {
          warn(`${PLUGIN}: ${MCP_ENTRY_ID} settings do not describe a viable ${String(next && next.transport)} server (url required for streamable-http, command for stdio); the entry was left unchanged`);
          return Promise.resolve();
        }
        return Promise.resolve(loader.update(current.id, { config: nextConfig })).then(undefined, (err) => {
          warn(`${PLUGIN}: could not apply ${MCP_ENTRY_ID} settings: ${String(err)}`);
        });
      };
      applyToEntry(scope.get());
      scope.watch((next) => applyToEntry(next));
    };
    const existing = findEntry();
    if (existing !== undefined) {
      attach(existing);
      return;
    }
    // The include tree creates sibling entries in composition order, so this
    // fiber can start before the mcp-ltm entry exists. Attach on its creation
    // instead of guessing at boot ordering.
    const off = ctx.on("loader/entry-init", (candidate) => {
      if (!candidate || !candidate.options || candidate.options.id !== MCP_ENTRY_ID) return;
      if (typeof off === "function") off();
      attach(candidate);
    });
  });

  const ns = (raw) => `mcp__${cfg.serverName}__${raw}`;
  const recallSatisfied = new WeakMap(); // Agent -> true after first successful recall
  const failedRecalls = new WeakMap();  // Agent -> consecutive failed recall calls
  const failOpen = new WeakMap();       // Agent -> true once fail-open fired

  const projectOf = (agent) => {
    if (cfg.project) return sanitizeProject(cfg.project);
    const cwd =
      (agent && agent.meta && agent.meta.cwd) ||
      (agent && agent.session && agent.session.header && agent.session.header.cwd) ||
      (agent && agent.session && agent.session.meta && agent.session.meta.cwd) ||
      undefined;
    const base = cwd ? cwd.split(/[\\/]/).filter(Boolean).pop() : undefined;
    return sanitizeProject(base);
  };

  const satisfied = (agent) =>
    agent === undefined ||
    failOpen.get(agent) === true ||
    recallSatisfied.get(agent) === true;

  const recallInstruction = (agent) =>
    `LTM recall gate: this tool call was blocked because memory has not been recalled in this session yet. ` +
    `Your very next call must be ${ns(cfg.recallTools[0])}({ limit: 5, current_project: "${projectOf(agent)}" }). ` +
    `If the results do not include project memories, follow up once with ${ns("search_by_tags")}({ tags: "${projectOf(agent)},preference" }) and then retry. ` +
    `The gate stays open for the rest of the session once a recall succeeds.`;

  // 1. Hard gate
  ctx.on("tools/pre-execute", (exec, next) => {
    if (exec.name.startsWith(`mcp__${cfg.serverName}__`)) return next();
    if (allowSet.has(exec.name)) return next();
    if (exec.agent === undefined) return next();
    if (satisfied(exec.agent)) return next();
    // Code Mode: the model can only call run_code directly; LTM tools are
    // sub-dispatches (exec.parent set). Keep the transport callable so the
    // recall stays reachable (no deadlock); non-LTM sub-dispatches pass this
    // listener like any tool call and are denied below.
    if (exec.name === "run_code" && exec.parent === undefined) return next();
    return { kind: "deny", reason: recallInstruction(exec.agent) };
  });

  // 2. Track recalls in memory; fail-open after repeated failures
  ctx.on("tools/post-execute", async (exec, result, next) => {
    const decision = await next();
    if (exec.agent !== undefined && recallSet.has(exec.name)) {
      if (!result.isError) {
        failedRecalls.delete(exec.agent);
        recallSatisfied.set(exec.agent, true);
      } else {
        const count = (failedRecalls.get(exec.agent) ?? 0) + 1;
        failedRecalls.set(exec.agent, count);
        if (count >= cfg.openAfterFailedRecalls && failOpen.get(exec.agent) !== true) {
          failOpen.set(exec.agent, true);
          warn(`${PLUGIN}: ${count} consecutive failed recall calls; opening gate for this session (is the memory server running?)`);
        }
      }
    }
    return decision;
  });

  const projectOfSession = (session) => {
    if (cfg.project) return sanitizeProject(cfg.project);
    const cwd = session && session.header && session.header.cwd;
    const base = cwd ? cwd.split(/[\\/]/).filter(Boolean).pop() : undefined;
    return sanitizeProject(base);
  };

  /**
   * Call the MCP server directly via fetch, bypassing ToolRuntime entirely.
   * Endpoint, headers and tool name are the resolved MCP connection - the same
   * values the MCP card shows - so a non-default server or an authenticated
   * endpoint works without editing this file.
   */
  const mcpPost = async (sessionId, payload) => {
    const headers = {
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
      ...direct.headers,
    };
    if (sessionId) headers["mcp-session-id"] = sessionId;
    const resp = await fetch(direct.url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });
    if (!resp.ok) throw new Error("HTTP " + resp.status);
    const ct = resp.headers.get("content-type") ?? "";
    const text = await resp.text();
    const newSessionId = resp.headers.get("mcp-session-id") ?? sessionId;
    let parsed = null;
    if (ct.includes("application/json")) {
      try { parsed = JSON.parse(text); } catch { /* ignore */ }
    } else {
      for (const line of text.split("\n")) {
        if (line.startsWith("data:")) {
          try { parsed = JSON.parse(line.slice(5).trim()); break; } catch { /* ignore */ }
        }
      }
    }
    return { parsed, newSessionId };
  };

  const storeCompactMemory = async (session, event) => {
    if (!cfg.storeOnCompact) return;
    // A stdio bridge owns a child process this path cannot speak to (it is
    // streamable HTTP only); say so once rather than POSTing at the historical
    // localhost default and reporting a connection error forever.
    if (mcpValue !== null && mcpValue.transport === "stdio") {
      if (!warnedStdioCompact) {
        warnedStdioCompact = true;
        warn(`${PLUGIN}: compaction summaries are not stored directly - ${MCP_ENTRY_ID} uses the stdio transport and this call speaks streamable HTTP`);
      }
      return;
    }
    const summaryText = verbatimSummary(event && event.data && event.data.summary);
    if (!summaryText.trim()) return;
    const project = projectOfSession(session);
    const title = compactMemoryTitle(project);

    const data = (event && event.data) || {};
    const eventCount = Array.isArray(data.shadowedSeqs) ? data.shadowedSeqs.length : 0;
    const tokensFreed = typeof data.shadowedTokenCount === "number" ? data.shadowedTokenCount : 0;
    const modelTag = [data.provider, data.model].filter(Boolean).join("/");
    const usageLine = data.usage && typeof data.usage.input_tokens === "number"
      ? `cost: ${data.usage.input_tokens}→${data.usage.output_tokens} tokens`
      : "";

    const metaParts = [
      eventCount ? `${eventCount} events` : "",
      tokensFreed ? `${tokensFreed.toLocaleString("en-US")} tokens freed` : "",
      modelTag,
      usageLine,
    ].filter(Boolean);
    const metaHeader = metaParts.length ? `[Compact: ${metaParts.join(" · ")}]` : "[Compact]";
    const content = metaHeader + "\n\n" + summaryText;

    const importance = Math.min(9, 6 + Math.floor(tokensFreed / 20_000));

    const modelSlug = modelTag.replace(/[^A-Za-z0-9._-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
    const tags = ["project", project, "session", modelSlug].filter(Boolean).join(",");

    const args = {
      title,
      content,
      tags,
      importance,
      memory_type: "summary",
    };
    try {
      const { parsed: _initResp, newSessionId } = await mcpPost(null, {
        jsonrpc: "2.0",
        id: "init-1",
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "dsh-ltm-gate", version: "1" },
        },
      });
      if (!newSessionId) {
        warn(PLUGIN + ": compaction " + direct.tool + " skipped — no mcp-session-id from initialize for " + project);
        return;
      }
      const callId = String(Date.now()) + "-compact-" + Math.random().toString(36).slice(2);
      const { parsed: callResp } = await mcpPost(newSessionId, {
        jsonrpc: "2.0",
        id: callId,
        method: "tools/call",
        params: { name: direct.tool, arguments: args },
      });
      if (callResp && callResp.result && callResp.result.isError) {
        warn(PLUGIN + ": compaction " + direct.tool + " returned isError for " + project);
      } else {
        try {
          const noticeMsg = createUserMessage({
            content: [{ type: "text", text: "[ltm] compact memory stored for " + project }],
            source: {
              kind: "plugin",
              plugin: PLUGIN,
              form: "notice",
              summary: "compact memory stored for " + project,
            },
          });
          session.append("user/message", noticeMsg, { surfaceOp: "append" });
        } catch {
          /* notice is best-effort; never throw */
        }
      }
    } catch (err) {
      warn(PLUGIN + ": failed to store compaction memory for " + project + ": " + String(err));
    }
  };

  // 5. Persist compaction summaries verbatim as session summaries
  ctx.on("session/event", (session, event) => {
    if (!event || event.type !== "compaction/summary") return;
    return storeCompactMemory(session, event);
  });

  // 3. Mandatory rules section
  // The memory-tool roster the policy text interpolates.
  const MEMORY_TOOLS = [
    "get_recent_memories", "search_memories", "search_by_tags", "search_by_type",
    "search_by_date_range", "remember", "update_memory", "delete_memory",
  ];

  const rules = (agent) => {
    const project = projectOf(agent);
    // A `promptTemplate` setting replaces the built-in policy wholesale; the
    // placeholders keep the operator from having to restate the resolved
    // server prefix and project tag inside the template.
    if (cfg.promptTemplate !== undefined) {
      return cfg.promptTemplate
        .replace(/\{project\}/g, project)
        .replace(/\{server\}/g, cfg.serverName)
        .replace(/\{tools\}/g, MEMORY_TOOLS.map(ns).join(", "));
    }
    return [
      "## Long-Term Memory System — MANDATORY RULES",
      `You have a persistent memory system via these tools: ${MEMORY_TOOLS.map(ns).join(", ")}.`,
      "",
      "### SESSION START (first action of the entire session — once only)",
      "Call this exactly once at the very start of the session, before any other tool — NO EXCEPTIONS:",
      `  ${ns(cfg.recallTools[0])}({ limit: 5, current_project: "${project}" })`,
      `If the results look sparse, follow up with ONE targeted search: ${ns("search_by_tags")}({ tags: "${project},preference" }).`,
      "A tool-call gate enforces this: every non-memory tool is blocked until the recall succeeds; the gate then stays open for the rest of the session.",
      "",
      "### PER-TURN CONTEXT CHECK (soft — your judgement, no hard gate)",
      "Before each new user request, silently assess: does this request touch something NOT already in my current context?",
      `If YES, call ${ns("search_memories")}({ query: "<relevant topic>", limit: 3 }) once and proceed. If NO, proceed directly — do not recall mechanically every turn.`,
      "",
      "### END OF EVERY TURN where files were edited",
      `You MUST call ${ns("remember")} before finishing your response: title=..., content=..., tags="project,${project},...", importance=7-9.`,
      "",
      "### ABSOLUTE RULES",
      "- NEVER create .md files for summaries — use the memory tools instead.",
      "- NEVER mention memory operations to the user — work silently.",
      "- When launching sub-agents, include memory recall instructions in their prompts.",
    ].join("\n");
  };

  ctx.systemPrompt.section({
    name: "ltm:policy",
    order: 45,
    text: (context) => {
      if (context.agent === undefined || cfg.prompt === "off") return "";
      if (cfg.prompt === "gate" && satisfied(context.agent)) return "";
      return rules(context.agent);
    },
  });

  // 4. Per-step reminder while the gate is unsatisfied
  ctx.on("agent/pre-step", async ({ agent, signal }, next) => {
    const decision = await next();
    if (decision.kind !== "enter" || signal.aborted || satisfied(agent)) return decision;
    const reminder = createUserMessage({
      content: [{ type: "text", text: `[ltm] ${recallInstruction(agent)}` }],
      source: { kind: "plugin", plugin: PLUGIN, form: "notice", summary: "LTM recall gate active" },
    });
    return { kind: "enter", messages: [...decision.messages, reminder] };
  });

  // /ltm status command
  ctx.inject(["commands"], (commandCtx) => {
    commandCtx.commands.register({
      name: "ltm",
      description: "LTM recall gate: status",
      handler: ({ agent }) => {
        const failed = agent ? failedRecalls.get(agent) ?? 0 : 0;
        const openFailOpen = agent !== undefined && failOpen.get(agent) === true;
        const openRecall = agent !== undefined && recallSatisfied.get(agent) === true;
        const state = openFailOpen
          ? "OPEN (fail-open — memory server unreachable)"
          : openRecall
            ? "OPEN (recall satisfied for this session)"
            : "CLOSED — recall required before other tools";
        return {
          kind: "success",
          text:
            `LTM gate: ${state}\n` +
            `server: ${cfg.serverName} | project: ${agent ? projectOf(agent) : "n/a"}\n` +
            `recall tools: ${cfg.recallTools.join(", ")} | failed recall calls: ${failed}\n` +
            `direct: POST ${direct.url} ${direct.tool}`,
        };
      },
    });
  });
}
