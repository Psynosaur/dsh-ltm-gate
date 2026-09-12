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
 *           prompt, project, storeOnCompact, promptTemplate }
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
  promptTemplate: z.string()
    .required(false)
    .description("Custom memory-rules text; replaces the built-in policy. Supports {project}, {server} and {tools} placeholders"),
});

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

  const known = ["serverName", "recallTools", "allowTools", "openAfterFailedRecalls", "prompt", "project", "storeOnCompact", "promptTemplate"];
  const unknown = Object.keys(merged).filter((key) => !known.includes(key));
  if (unknown.length > 0) {
    throw new Error(`${PLUGIN}: unknown config key(s) ${unknown.join(", ")}; config is { serverName, recallTools, allowTools, openAfterFailedRecalls, prompt, project, storeOnCompact, promptTemplate }`);
  }

  const out = {
    serverName: merged.serverName ?? "ltm",
    recallTools: merged.recallTools ?? ["get_recent_memories"],
    allowTools: merged.allowTools ?? [],
    openAfterFailedRecalls: merged.openAfterFailedRecalls ?? 3,
    prompt: merged.prompt ?? "full",
    project: merged.project,
    storeOnCompact: merged.storeOnCompact ?? true,
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

  return out;
}

export function apply(ctx, config = {}) {
  let cfg;
  let recallSet = new Set();
  let allowSet = new Set();

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
    `Your very next call must be ${ns("get_recent_memories")}({ limit: 5, current_project: "${projectOf(agent)}" }). ` +
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
   */
  const mcpUrl = "http://127.0.0.1:8000/mcp/";

  const mcpPost = async (sessionId, payload) => {
    const headers = {
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
    };
    if (sessionId) headers["mcp-session-id"] = sessionId;
    const resp = await fetch(mcpUrl, {
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
        warn(PLUGIN + ": compaction remember skipped — no mcp-session-id from initialize for " + project);
        return;
      }
      const callId = String(Date.now()) + "-compact-" + Math.random().toString(36).slice(2);
      const { parsed: callResp } = await mcpPost(newSessionId, {
        jsonrpc: "2.0",
        id: callId,
        method: "tools/call",
        params: { name: "remember", arguments: args },
      });
      if (callResp && callResp.result && callResp.result.isError) {
        warn(PLUGIN + ": compaction remember returned isError for " + project);
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
      `  ${ns("get_recent_memories")}({ limit: 5, current_project: "${project}" })`,
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
            `recall tools: ${cfg.recallTools.join(", ")} | failed recall calls: ${failed}`,
        };
      },
    });
  });
}
