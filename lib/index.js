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
 *
 * Config: { serverName, recallTools, allowTools, openAfterFailedRecalls,
 *           prompt, project }
 */
import { createUserMessage } from "@deepseek-ai/dsh-llm";

export const name = "ltm-gate";
export const inject = ["tools", "systemPrompt"];

const PLUGIN = "ltm-gate";

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

function resolveConfig(config = {}) {
  const known = ["serverName", "recallTools", "allowTools", "openAfterFailedRecalls", "prompt", "project"];
  const unknown = Object.keys(config).filter((key) => !known.includes(key));
  if (unknown.length > 0) {
    throw new Error(`${PLUGIN}: unknown config key(s) ${unknown.join(", ")}; config is { serverName, recallTools, allowTools, openAfterFailedRecalls, prompt, project }`);
  }
  const out = {
    serverName: config.serverName ?? "ltm",
    recallTools: config.recallTools ?? ["get_recent_memories"],
    allowTools: config.allowTools ?? [],
    openAfterFailedRecalls: config.openAfterFailedRecalls ?? 3,
    prompt: config.prompt ?? "full",
    project: config.project,
  };
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
  return out;
}

export function apply(ctx, config = {}) {
  const cfg = resolveConfig(config);
  const ns = (raw) => `mcp__${cfg.serverName}__${raw}`;
  const recallSet = new Set(cfg.recallTools.map(ns));
  const allowSet = new Set(cfg.allowTools);
  const recallSatisfied = new WeakMap(); // Agent -> true after first successful recall
  const failedRecalls = new WeakMap();  // Agent -> consecutive failed recall calls
  const failOpen = new WeakMap();       // Agent -> true once fail-open fired

  const warn = (message, ...args) => {
    try {
      if (ctx.logger && typeof ctx.logger.warn === "function") ctx.logger.warn(message, ...args);
    } catch {
      /* logging must never throw */
    }
  };

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

  // 3. Mandatory rules section
  const rules = (agent) => {
    const project = projectOf(agent);
    return [
      "## Long-Term Memory System — MANDATORY RULES",
      `You have a persistent memory system via these tools: ${ns("get_recent_memories")}, ${ns("search_memories")}, ${ns("search_by_tags")}, ${ns("search_by_type")}, ${ns("search_by_date_range")}, ${ns("remember")}, ${ns("update_memory")}, ${ns("delete_memory")}.`,
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
