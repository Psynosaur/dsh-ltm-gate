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
 *           prompt, project, storeOnCompact }
 */
import { createUserMessage } from "@deepseek-ai/dsh-llm";

export const name = "ltm-gate";
export const inject = ["tools", "systemPrompt", "sessions"];

const PLUGIN = "ltm-gate";

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

function resolveConfig(config = {}) {
  const known = ["serverName", "recallTools", "allowTools", "openAfterFailedRecalls", "prompt", "project", "storeOnCompact", "recallArgs", "compactMaxChars", "projectRecall", "maxRecallChars", "storeGate", "writeTools"];
  const unknown = Object.keys(config).filter((key) => !known.includes(key));
  if (unknown.length > 0) {
    throw new Error(`${PLUGIN}: unknown config key(s) ${unknown.join(", ")}; config is { serverName, recallTools, allowTools, openAfterFailedRecalls, prompt, project, storeOnCompact }`);
  }
  const out = {
    serverName: config.serverName ?? "ltm",
    recallTools: config.recallTools ?? ["get_recent_memories"],
    allowTools: config.allowTools ?? [],
    openAfterFailedRecalls: config.openAfterFailedRecalls ?? 3,
    prompt: config.prompt ?? "full",
    project: config.project,
    storeOnCompact: config.storeOnCompact ?? true,
    // Compaction summaries are stored as memory_type="summary". They can be
    // huge (the harness emits whole recaps), so cap the stored copy: the full
    // text stays in the session transcript, the memory keeps the head + a
    // pointer. Sessions also get their own tag so a recap can be found again.
    compactMaxChars: config.compactMaxChars ?? 4000,
    // Injection projection: trim oversized LTM payloads before the model sees
    // them (drop preferences that cannot apply here, then enforce a character
    // budget). The payload stays valid JSON; a "projected" note records what
    // was removed so the model can ask for the full slice on purpose.
    projectRecall: config.projectRecall ?? true,
    maxRecallChars: config.maxRecallChars ?? 8000,
    // Store gate (parity with the opencode plugin): "remind" nudges on the turn
    // after a file-changing turn that stored nothing, "block" denies non-memory
    // tools until something is stored, "off" disables it.
    storeGate: config.storeGate ?? "remind",
    writeTools: config.writeTools ?? ["write", "edit"],
    // Args merged into the mandatory session-start recall. The defaults keep
    // the bootstrap cheap: relevant scope, an index instead of bodies, and a
    // short preview per hit. Expand on demand with detail="full".
    recallArgs: config.recallArgs ?? { limit: 5, scope: "project", detail: "digest", snippet_chars: 200, include_summaries: true },
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
  if (!["full", "slim", "gate", "off"].includes(out.prompt)) {
    throw new Error(`${PLUGIN}: prompt must be one of: full, slim, gate, off`);
  }
  if (typeof out.recallArgs !== "object" || out.recallArgs === null || Array.isArray(out.recallArgs)) {
    throw new Error(`${PLUGIN}: recallArgs must be an object merged into the mandatory recall call`);
  }
  if (out.project !== undefined && (typeof out.project !== "string" || out.project.trim() === "")) {
    throw new Error(`${PLUGIN}: project must be a non-empty string`);
  }
  if (typeof out.storeOnCompact !== "boolean") {
    throw new Error(`${PLUGIN}: storeOnCompact must be a boolean`);
  }
  if (!Number.isInteger(out.compactMaxChars) || out.compactMaxChars < 500) {
    throw new Error(`${PLUGIN}: compactMaxChars must be an integer >= 500`);
  }
  if (typeof out.projectRecall !== "boolean") {
    throw new Error(`${PLUGIN}: projectRecall must be a boolean`);
  }
  if (!Number.isInteger(out.maxRecallChars) || out.maxRecallChars < 500) {
    throw new Error(`${PLUGIN}: maxRecallChars must be an integer >= 500`);
  }
  if (!["off", "remind", "block"].includes(out.storeGate)) {
    throw new Error(`${PLUGIN}: storeGate must be one of: off, remind, block`);
  }
  if (!Array.isArray(out.writeTools) || out.writeTools.some((tool) => typeof tool !== "string")) {
    throw new Error(`${PLUGIN}: writeTools must be a list of tool names`);
  }
  return out;
}

export function apply(ctx, config = {}) {
  const cfg = resolveConfig(config);
  const ns = (raw) => `mcp__${cfg.serverName}__${raw}`;
  const recallSet = new Set(cfg.recallTools.map(ns));
  const allowSet = new Set(cfg.allowTools);
  const storeTools = new Set([ns("remember"), ns("update_memory")]);
  const recallSatisfied = new WeakMap(); // Agent -> true after first successful recall
  const failedRecalls = new WeakMap();  // Agent -> consecutive failed recall calls
  const failOpen = new WeakMap();       // Agent -> true once fail-open fired
  const dirtyAgents = new WeakMap();    // Agent -> true when a write landed with no store since

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

  const recallArgsFor = (agent) => {
    const args = { ...cfg.recallArgs, current_project: projectOf(agent) };
    return JSON.stringify(args);
  };

  const storeInstruction = (agent) =>
    "LTM store gate: the previous turn changed files but nothing was stored. Call " +
    ns("remember") +
    "({ title, content, tags: \"project," +
    projectOf(agent) +
    ",<topic>\", importance: 7, file_paths: \"<abs paths>\" }) or " +
    ns("update_memory") +
    "(...) to record the outcome, then continue.";

  const recallInstruction = (agent) =>
    `LTM recall gate: this tool call was blocked because memory has not been recalled in this session yet. ` +
    `Your very next call must be ${ns("get_recent_memories")}(${recallArgsFor(agent)}). ` +
    `The gate stays open for the rest of the session once a recall succeeds.`;

  // 1. Hard gate
  ctx.on("tools/pre-execute", (exec, next) => {
    if (exec.name.startsWith(`mcp__${cfg.serverName}__`)) return next();
    if (allowSet.has(exec.name)) return next();
    if (exec.agent === undefined) return next();
    // Code Mode: the model can only call run_code directly; LTM tools are
    // sub-dispatches (exec.parent set). Keep the transport callable so the
    // recall and storing stay reachable (no deadlock); non-LTM sub-dispatches
    // pass this listener like any tool call and are checked below.
    if (exec.name === "run_code" && exec.parent === undefined) return next();
    // The store gate outranks an open recall gate: a file-changing turn with
    // nothing stored is the stronger signal.
    if (cfg.storeGate === "block" && dirtyAgents.get(exec.agent) === true) {
      return { kind: "deny", reason: storeInstruction(exec.agent) };
    }
    if (satisfied(exec.agent)) return next();
    return { kind: "deny", reason: recallInstruction(exec.agent) };
  });

  // 2a. Quality gate: a recall only satisfies the session-start requirement when
  // it names this project (or deliberately asks for a shaped slice). Otherwise
  // the gate would enforce the ritual instead of the information.
  const recallArgsAcceptable = (exec, agent) => {
    const args = exec.arguments;
    if (args === undefined || args === null || typeof args !== "object") return true;
    const wanted = projectOf(agent).toLowerCase();
    const rawProject = typeof args.current_project === "string" ? args.current_project : "";
    const projectTag = rawProject
      ? rawProject.split(/[\\/]/).filter(Boolean).pop().toLowerCase()
      : "";
    if (projectTag && projectTag === wanted) return true;
    const tags = Array.isArray(args.tags)
      ? args.tags.map((tag) => String(tag).toLowerCase())
      : typeof args.tags === "string"
        ? args.tags.split(",").map((tag) => tag.trim().toLowerCase())
        : [];
    if (tags.includes(wanted)) return true;
    if (typeof args.scope === "string" || typeof args.detail === "string") return true;
    return false;
  };

  const BROAD_TAGS = new Set(["global", "all-projects", "all_projects", "core", "critical", "always"]);
  const PREFERENCE_MIN_IMPORTANCE = 9;
  const PREFERENCE_MAX_AGE_DAYS = 30;
  const ageDays = (timestamp) => {
    const parsed = Date.parse(timestamp);
    return Number.isFinite(parsed) ? (Date.now() - parsed) / 86400000 : Infinity;
  };

  // 2b. Injection projection: drop preferences that cannot apply here, then hold
  // the payload to a character budget. Returns null when nothing changed.
  const projectPayload = (text, agent) => {
    let parsed;
    try { parsed = JSON.parse(text); } catch { return null; }
    const items = parsed && Array.isArray(parsed.data) ? parsed.data : null;
    if (!items || items.length === 0) return null;
    if (!items.some((item) => item && typeof item === "object" && "memory_type" in item)) return null;
    const wanted = projectOf(agent).toLowerCase();
    let droppedPreferences = 0;
    const relevant = items.filter((item) => {
      if (!item || item.memory_type !== "preference") return true;
      const tags = (item.tags || []).map((tag) => String(tag).toLowerCase());
      if (tags.includes(wanted)) return true;
      if (tags.some((tag) => BROAD_TAGS.has(tag))) return true;
      if (
        (item.importance || 0) >= PREFERENCE_MIN_IMPORTANCE &&
        ageDays(item.timestamp) <= PREFERENCE_MAX_AGE_DAYS
      ) {
        return true;
      }
      droppedPreferences += 1;
      return false;
    });
    let used = 0;
    let droppedOverBudget = 0;
    const kept = [];
    for (const item of relevant) {
      const size = JSON.stringify(item).length;
      if (kept.length > 0 && used + size > cfg.maxRecallChars) { droppedOverBudget += 1; continue; }
      kept.push(item);
      used += size;
    }
    if (droppedPreferences === 0 && droppedOverBudget === 0) return null;
    return JSON.stringify({
      ...parsed,
      data: kept,
      projected: {
        dropped_preferences: droppedPreferences,
        dropped_over_budget: droppedOverBudget,
        max_chars: cfg.maxRecallChars,
        note: "trimmed by dsh-ltm-gate; re-call with detail=\"full\" for bodies or raise maxRecallChars",
      },
    });
  };

  const projectRecallResult = (exec, decision) => {
    if (!cfg.projectRecall) return decision;
    if (!exec.name.startsWith("mcp__" + cfg.serverName + "__")) return decision;
    if (decision.kind !== "accept" || !Array.isArray(decision.content)) return decision;
    let changed = false;
    const content = decision.content.map((block) => {
      if (!block || block.type !== "text" || typeof block.text !== "string") return block;
      const projected = projectPayload(block.text, exec.agent);
      if (projected === null) return block;
      changed = true;
      return { ...block, text: projected };
    });
    return changed ? { ...decision, content } : decision;
  };

  // 2c. Track recalls in memory; fail-open after repeated failures
  ctx.on("tools/post-execute", async (exec, result, next) => {
    const decision = await next();
    if (exec.agent !== undefined && recallSet.has(exec.name)) {
      if (!result.isError) {
        if (recallArgsAcceptable(exec, exec.agent)) {
          failedRecalls.delete(exec.agent);
          recallSatisfied.set(exec.agent, true);
        } else {
          warn(
            PLUGIN + ": recall ignored - arguments do not carry project " +
              projectOf(exec.agent) + "; the gate stays closed",
          );
        }
      } else {
        const count = (failedRecalls.get(exec.agent) ?? 0) + 1;
        failedRecalls.set(exec.agent, count);
        if (count >= cfg.openAfterFailedRecalls && failOpen.get(exec.agent) !== true) {
          failOpen.set(exec.agent, true);
          warn(PLUGIN + ": " + count + " consecutive failed recall calls; opening gate for this session (is the memory server running?)");
        }
      }
    }
    if (exec.agent !== undefined && !result.isError) {
      if (cfg.writeTools.includes(exec.name)) dirtyAgents.set(exec.agent, true);
      if (storeTools.has(exec.name)) dirtyAgents.delete(exec.agent);
    }
    return projectRecallResult(exec, decision);
  });

  const projectOfSession = (session) => {
    if (cfg.project) return sanitizeProject(cfg.project);
    const cwd = session && session.header && session.header.cwd;
    const base = cwd ? cwd.split(/[\\/]/).filter(Boolean).pop() : undefined;
    return sanitizeProject(base);
  };

  /**
   * Call the MCP server directly via fetch, bypassing ToolRuntime entirely.
   *
   * ctx.tools.execute() collapses any call whose name is not "run_code" when
   * the session is in Code Mode (tools presentation mode === "code"), the default
   * for the DeepSeek web profile.  A plugin-originated call has no parent token
   * so it is treated as model-direct and collapsed to UNKNOWN_TOOL.
   *
   * The MCP streamable-HTTP server is stateful: a bare tools/call without a
   * prior initialize is rejected (307 redirect on /mcp without trailing slash,
   * then 4xx on missing session).  We do a minimal initialize -> tools/call
   * sequence per compact event, opening a short-lived session just long enough
   * to store one memory.
   *
   * Server URL: trailing slash required; falls back to http://127.0.0.1:8000/mcp/
   */
  const mcpUrl = (() => {
    const base = "http://127.0.0.1:8000/mcp/";
    return base;
  })();

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

    // Extract rich metadata from the compaction/summary event
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
    const cap = cfg.compactMaxChars;
    const clipped = summaryText.length > cap
      ? summaryText.slice(0, cap) +
        `\n\n[... ${summaryText.length - cap} chars clipped; the full recap stays in the session transcript]`
      : summaryText;
    const content = metaHeader + "\n\n" + clipped;

    // Scale importance by tokens freed: 6 baseline, +1 per 20k tokens, capped at 9
    const importance = Math.min(9, 6 + Math.floor(tokensFreed / 20_000));

    // Enrich tags with model provenance
    const modelSlug = modelTag.replace(/[^A-Za-z0-9._-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
    const sessionId =
      (session &&
        ((session.header && (session.header.sessionId || session.header.id)) || session.id)) ||
      "";
    const tags = ["project", project, "session", sessionId ? "session:" + sessionId : "", modelSlug]
      .filter(Boolean)
      .join(",");

    const args = {
      title,
      content,
      tags,
      importance,
      memory_type: "summary",
    };
    try {
      // Step 1: initialize to get a session ID
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
      // Step 2: call remember with the session
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
        // Success — append a visible notice to the session so the user sees it.
        try {
          const noticeMsg = createUserMessage({
            content: [{ type: "text", text: "[ltm] compact memory stored for " + project }],
            source: {
              // Session format v4 requires a producer-owned source kind. The
              // retired v3 wrapper ({ kind: "plugin", plugin }) is rejected at
              // admission with "format v4 message requires a producer-owned
              // source kind"; `plugin:<name>` is the shape the harness's own
              // v3->v4 migration emits for an out-of-repo plugin.
              kind: `plugin:${PLUGIN}`,
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

  // 3a. Working rules (short, always on)
  const coreRules = (agent) => {
    const project = projectOf(agent);
    return [
      "## Long-Term Memory — WORKING RULES",
      `Memory tools: ${ns("get_recent_memories")}, ${ns("search_memories")}, ${ns("search_by_tags")}, ${ns("search_by_type")}, ${ns("search_by_date_range")}, ${ns("remember")}, ${ns("update_memory")}, ${ns("delete_memory")}.`,
      "",
      "### Recall is pull-based and budgeted",
      "- Recall only when the request needs something you do not already have in context. One targeted search beats a broad dump.",
      `- Cheap first: ${ns("search_memories")}({ query: "<topic>", limit: 3, detail: "digest", snippet_chars: 200 }) returns id/title/tags plus a preview.`,
      `- Expand only the hits you need: ${ns("search_memories")}({ query: "<topic>", limit: 2, detail: "full" }) or ${ns("get_recent_memories")}({ limit: 3, detail: "full" }).`,
      "- NEVER print or return a raw recall payload. Inside run_code, select the fields you need (titles, the one or two bodies that matter) and print only those: a full dump costs thousands of tokens and buries the answer.",
      "",
      "### Storing (write-side discipline)",
      "- After a turn that changed files or settled a durable decision, store the conclusion — not the transcript.",
      "- A fact memory about code MUST pass file_paths=\"<abs/path>,...\": the server embeds signature/file-hash/git-commit anchors so the memory can later be flagged stale. Without it there is no code anchor at all.",
      "- Search before storing; if a memory already covers it, call update_memory instead of adding a near-duplicate.",
      `- Tags: "project,${project},<topic>"; importance 7-9 for durable facts, 5-6 for context.`,
      "",
      "### ABSOLUTE RULES",
      "- NEVER create .md files for summaries — use the memory tools instead.",
      "- NEVER mention memory operations to the user — work silently.",
      "- When launching sub-agents, include memory recall instructions in their prompts.",
    ].join("\n");
  };

  // 3b. Bootstrap block — only while the gate is closed (session start/resume)
  const bootstrapRules = (agent) =>
    [
      "## Long-Term Memory — SESSION START",
      "Call this exactly once, before any other tool — NO EXCEPTIONS:",
      `  ${ns("get_recent_memories")}(${recallArgsFor(agent)})`,
      "Non-memory tools are blocked until it succeeds; the gate then stays open for the session.",
    ].join("\n");

  // full = bootstrap + working rules (legacy layout)
  const rules = (agent) => [bootstrapRules(agent), "", coreRules(agent)].join("\n");
  ctx.systemPrompt.section({
    name: "ltm:policy",
    order: 45,
    text: (context) => {
      if (context.agent === undefined || cfg.prompt === "off") return "";
      if (cfg.prompt === "gate" && satisfied(context.agent)) return "";
      if (cfg.prompt === "slim") {
        // Working rules always; the bootstrap only until the gate opens.
        return satisfied(context.agent) ? coreRules(context.agent) : rules(context.agent);
      }
      return rules(context.agent);
    },
  });

  // 4. Per-step reminder: the recall gate while closed, the store gate once open
  ctx.on("agent/pre-step", async ({ agent, signal }, next) => {
    const decision = await next();
    if (decision.kind !== "enter" || signal.aborted) return decision;
    const messages = [...decision.messages];
    if (!satisfied(agent)) {
      const reminderText =
        cfg.prompt === "slim"
          ? "[ltm] Recall gate closed: your first tool call must be " + ns("get_recent_memories") + "(" + recallArgsFor(agent) + ")."
          : "[ltm] " + recallInstruction(agent);
      messages.push(
        createUserMessage({
          content: [{ type: "text", text: reminderText }],
          source: { kind: "plugin:" + PLUGIN, form: "notice", summary: "LTM recall gate active" },
        }),
      );
    } else if (cfg.storeGate !== "off" && dirtyAgents.get(agent) === true) {
      const text =
        cfg.storeGate === "block"
          ? "[ltm] " + storeInstruction(agent)
          : "[ltm] Reminder: the previous turn changed files - store the conclusion (" + ns("remember") + " or " + ns("update_memory") + ") before moving on.";
      messages.push(
        createUserMessage({
          content: [{ type: "text", text }],
          source: { kind: "plugin:" + PLUGIN, form: "notice", summary: "LTM store reminder" },
        }),
      );
    }
    return messages.length === decision.messages.length ? decision : { kind: "enter", messages };
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
