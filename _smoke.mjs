import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { fileURLToPath, pathToFileURL } from "url";

// The repo's own plugin entry — the same file the profile deploys.
const SRC = fileURLToPath(new URL("./lib/index.js", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "ltm-gate-smoke-"));
mkdirSync(join(dir, "node_modules", "@deepseek-ai", "dsh-llm"), { recursive: true });
writeFileSync(join(dir, "node_modules", "@deepseek-ai", "dsh-llm", "package.json"),
  JSON.stringify({ name: "@deepseek-ai/dsh-llm", type: "module", main: "index.js" }));
writeFileSync(join(dir, "node_modules", "@deepseek-ai", "dsh-llm", "index.js"),
  "export function createUserMessage(input){ return Object.freeze({ id:'smoke-id', role:'user', ...input }); }\n");
mkdirSync(join(dir, "node_modules", "@deepseek-ai", "schemastery"), { recursive: true });
writeFileSync(join(dir, "node_modules", "@deepseek-ai", "schemastery", "package.json"),
  JSON.stringify({ name: "@deepseek-ai/schemastery", type: "module", main: "index.js" }));
writeFileSync(join(dir, "node_modules", "@deepseek-ai", "schemastery", "index.js"),
  `function chain(obj) {
    obj.min = () => obj;
    obj.max = () => obj;
    obj.default = () => obj;
    obj.optional = () => obj;
    obj.description = () => obj;
    obj.validate = () => obj;
    obj.refine = () => obj;
    obj.transform = () => obj;
    obj.catch = () => obj;
    obj.nullable = () => obj;
    obj.required = () => obj;
    return obj;
  }
  const mock = {
    object: (shape) => chain({
      parse: (v) => v,
      safeParse: (v) => ({ success: true, data: v }),
      _shape: shape
    }),
    string: () => chain({ parse: (v) => v }),
    array: (item) => chain({ parse: (v) => v }),
    natural: () => chain({ parse: (v) => v }),
    union: (options) => chain({ parse: (v) => v }),
    const: (val) => chain({ parse: (v) => v }),
    boolean: () => chain({ parse: (v) => v }),
    dict: (valueSchema) => chain({ parse: (v) => v })
  };
  export default mock;
`);
writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "module" }));
copyFileSync(SRC, join(dir, "index.js"));

const mod = await import(pathToFileURL(join(dir, "index.js")).href);
const { apply, sanitizeProject, verbatimSummary, compactMemoryTitle } = mod;

function makeAgent() {
  const events = [];
  return {
    meta: { cwd: "D:/models/llama.cpp-public" },
    session: {
      get events() { return events; },
      append(type, data) { events.push({ type, data }); return { type, data }; },
    },
  };
}
function makeCtx(options = {}) {
  const listeners = {};
  const sections = [];
  const commands = [];
  const remembered = [];
  const calls = [];
  // storeCompactMemory does initialize -> tools/call via fetch (bypasses
  // ToolRuntime Code Mode collapse). Stub fetch to handle both calls, and
  // record the endpoint/headers/tool so the MCP wiring can be asserted.
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    let body;
    try { body = JSON.parse(init && init.body ? init.body : "{}"); } catch { body = {}; }
    if (body.method === "initialize") {
      calls.push({ url, method: "initialize", headers: (init && init.headers) || {} });
      return {
        ok: true,
        headers: { get: (h) => h === "mcp-session-id" ? "smoke-session-123" : "application/json" },
        text: async () => JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2024-11-05" } }),
      };
    }
    if (body.method === "tools/call") {
      calls.push({ url, name: body.params && body.params.name, arguments: body.params && body.params.arguments, headers: (init && init.headers) || {} });
      if (body.params && body.params.name === "remember") remembered.push(body.params.arguments);
      return {
        ok: true,
        headers: { get: (h) => h === "mcp-session-id" ? "smoke-session-123" : "application/json" },
        text: async () => JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { content: [], isError: false } }),
      };
    }
    return { ok: false, status: 400, headers: { get: () => null }, text: async () => "unexpected" };
  };
  const toolsStub = options.tools ?? {
    get(name) { return undefined; },
  };
  // Settings service stub: one registration record per namespace plus a
  // per-namespace watch that a test drives through _pushSettings /
  // _pushMcpSettings. An unset value falls back to that namespace's base,
  // which is what a real override-free document resolves to.
  const registrations = [];
  const settingsListeners = {};
  let gateSettingsValue = options.settingsValue;
  let mcpSettingsValue = options.mcpSettings;
  const settingsService = {
    register(ns, schema, opts) {
      registrations.push({ ns, schema, opts });
      return {
        get: () => {
          const override = ns === "mcp-ltm" ? mcpSettingsValue : gateSettingsValue;
          return override !== undefined ? override : (opts && opts.base);
        },
        watch(fn) { (settingsListeners[ns] ??= []).push(fn); },
      };
    },
  };
  return {
    logger: { warn: () => {} },
    tools: toolsStub,
    settings: options.settings ?? settingsService,
    on(name, fn) { (listeners[name] ??= []).push(fn); },
    systemPrompt: { section(s) { sections.push(s); } },
    inject(keys, fn) {
      // Cordis waits for a missing service instead of calling the callback:
      // noSettings models a deployment without a settings provider, and no
      // loader option models one with no mcp-ltm entry to configure.
      if (keys.includes("settings") && options.noSettings) return;
      const provided = {};
      if (keys.includes("commands")) provided.commands = { register(c) { commands.push(c); } };
      if (keys.includes("settings")) provided.settings = options.settings ?? settingsService;
      if (keys.includes("loader") && options.loader) provided.loader = options.loader;
      fn(provided);
    },
    async fire(name, ...args) {
      const fns = listeners[name] ?? [];
      let decision;
      const next = async () => (decision ??= { kind: "allow" });
      for (const fn of fns) { decision = await fn(...args, next); }
      return decision;
    },
    _sections: sections,
    _commands: commands,
    _remembered: remembered,
    _calls: calls,
    _registrations: registrations,
    _registrationsFor(ns) { return registrations.filter((r) => r.ns === ns); },
    _pushSettings(next) {
      gateSettingsValue = next;
      for (const fn of settingsListeners["ltm-gate"] ?? []) fn(next, undefined);
    },
    _pushMcpSettings(next) {
      mcpSettingsValue = next;
      for (const fn of settingsListeners["mcp-ltm"] ?? []) fn(next, undefined);
    },
    _restoreFetch: () => { globalThis.fetch = origFetch; },
  };
}

/**
 * Stub loader service around one mcp-ltm entry. `visible: false` models the
 * window in which the include tree has not created the sibling entry yet, so
 * the entry-init attach path can be exercised.
 */
function makeLoader(config, options = {}) {
  const updates = [];
  const entry = { id: "include:mcp-ltm", options: { id: "mcp-ltm", config } };
  return {
    _entry: entry,
    _updates: updates,
    entries() { return options.visible === false ? [] : [entry]; },
    update(id, next) {
      if (options.failUpdate) return Promise.reject(new Error("loader refused the update"));
      updates.push({ id, config: next.config });
      entry.options = { ...entry.options, config: next.config };
      return Promise.resolve();
    },
    show() { options.visible = true; },
  };
}

let pass = 0, fail = 0;
const ok = (cond, label) => { if (cond) { pass++; console.log("PASS", label); } else { fail++; console.log("FAIL", label); } };

ok(sanitizeProject("llama.cpp-public") === "llama.cpp-public", "sanitizeProject keeps safe slug chars");
ok(sanitizeProject("xy${z}\u0000q") === "xyz-q", "sanitizeProject strips template pair + control chars");
ok(sanitizeProject("") === "unknown", "sanitizeProject empty -> unknown");

{
  const ctx = makeCtx();
  apply(ctx, { serverName: "ltm" });
  const agent = makeAgent();

  const deny1 = await ctx.fire("tools/pre-execute", { name: "read", agent, parent: undefined }, async () => ({ kind: "allow" }));
  ok(deny1.kind === "deny" && /get_recent_memories/.test(deny1.reason), "S1 non-LTM call denied before recall");
  ok(/current_project: "llama\.cpp-public"/.test(deny1.reason), "S1 deny message carries project tag from agent cwd");

  const allow1 = await ctx.fire("tools/pre-execute", { name: "mcp__ltm__get_recent_memories", agent }, async () => ({ kind: "allow" }));
  ok(allow1.kind === "allow", "S1 LTM recall tool allowed while gate closed");

  await ctx.fire("tools/post-execute", { name: "mcp__ltm__get_recent_memories", agent }, { isError: false }, async () => ({ kind: "accept" }));
  ok(!agent.session.events.some(e => e.type === "ltm/recall"), "S1 successful recall writes no durable event (stock sessions stay loadable)");

  const allow2 = await ctx.fire("tools/pre-execute", { name: "read", agent }, async () => ({ kind: "allow" }));
  ok(allow2.kind === "allow", "S1 gate open after recall");

  // A fresh agent object models resume/fork: new session, gate must re-close.
  const agentResume = makeAgent();
  const reDeny = await ctx.fire("tools/pre-execute", { name: "read", agent: agentResume }, async () => ({ kind: "allow" }));
  ok(reDeny.kind === "deny", "S1 gate re-closes for a resumed/forked agent until it recalls");

  const agent2 = makeAgent();
  const d2 = await ctx.fire("agent/pre-step", { agent: agent2, signal: new AbortController().signal }, async () => ({ kind: "enter", messages: [{ id: "m1" }] }));
  ok(d2.kind === "enter" && d2.messages.length === 2 && /LTM recall gate/.test(d2.messages[1].content[0].text), "S1 pre-step injects reminder while unsatisfied");
  const d3 = await ctx.fire("agent/pre-step", { agent, signal: new AbortController().signal }, async () => ({ kind: "enter", messages: [{ id: "m1" }] }));
  ok(d3.messages.length === 1, "S1 no reminder once satisfied");

  const sec = ctx._sections.find(s => s.name === "ltm:policy");
  ok(!!sec && sec.text({ agent }).includes("MANDATORY RULES"), "S1 ltm:policy section renders rules");
  const ltmCmd = ctx._commands.find(c => c.name === "ltm");
  ok(!!ltmCmd, "S1 /ltm command registered");
  ok(!ltmCmd.input || (typeof ltmCmd.input.hint === "string" && ltmCmd.input.hint.trim().length > 0), "S1 /ltm command input passes dsh-commands validation (hint non-empty or absent)");

  const agent3 = makeAgent();
  for (let i = 0; i < 3; i++) {
    await ctx.fire("tools/post-execute", { name: "mcp__ltm__get_recent_memories", agent: agent3 }, { isError: true }, async () => ({ kind: "accept" }));
  }
  const fo = await ctx.fire("tools/pre-execute", { name: "read", agent: agent3 }, async () => ({ kind: "allow" }));
  ok(fo.kind === "allow", "S1 gate fail-open after 3 failed recalls");
}

{
  const ctx = makeCtx();
  apply(ctx, { serverName: "ltm" });
  const agent = makeAgent();

  const runCode = await ctx.fire("tools/pre-execute", { name: "run_code", agent, parent: undefined }, async () => ({ kind: "allow" }));
  ok(runCode.kind === "allow", "S2 run_code transport allowed while gate closed (no deadlock)");

  const subDeny = await ctx.fire("tools/pre-execute", { name: "read", agent, parent: Symbol("parent-token") }, async () => ({ kind: "allow" }));
  ok(subDeny.kind === "deny", "S2 non-LTM sub-dispatch denied while gate closed");

  const subAllow = await ctx.fire("tools/pre-execute", { name: "mcp__ltm__search_memories", agent, parent: Symbol("parent-token") }, async () => ({ kind: "allow" }));
  ok(subAllow.kind === "allow", "S2 LTM sub-dispatch allowed while gate closed");

  await ctx.fire("tools/post-execute", { name: "mcp__ltm__get_recent_memories", agent, parent: Symbol("parent-token") }, { isError: false }, async () => ({ kind: "accept" }));
  const subAfter = await ctx.fire("tools/pre-execute", { name: "read", agent, parent: Symbol("parent-token") }, async () => ({ kind: "allow" }));
  ok(subAfter.kind === "allow", "S2 sub-dispatches unblocked after recall");

  const noAgent = await ctx.fire("tools/pre-execute", { name: "read", agent: undefined }, async () => ({ kind: "allow" }));
  ok(noAgent.kind === "allow", "S2 agent-less execution not gated");
}

{
  const ctx = makeCtx();
  apply(ctx, { serverName: "ltm", recallTools: ["get_recent_memories"], allowTools: ["todo_write"] });
  const agent = makeAgent();
  const t = await ctx.fire("tools/pre-execute", { name: "todo_write", agent }, async () => ({ kind: "allow" }));
  ok(t.kind === "allow", "S3 allowTools tool passes while gate closed");
  let threw = false;
  try { apply(makeCtx(), { bogusKey: 1 }); } catch { threw = true; }
  ok(threw, "S3 unknown config key rejected at load");
  let threw2 = false;
  try { apply(makeCtx(), { openAfterFailedRecalls: 0 }); } catch { threw2 = true; }
  ok(threw2, "S3 openAfterFailedRecalls < 1 rejected");
}

ok(verbatimSummary([{ type: "text", text: "hello" }, { type: "reasoning", text: "skip" }, { type: "text", text: " world" }]) === "hello world", "S4 verbatimSummary concatenates text blocks only");
ok(compactMemoryTitle("dsh-ltm-gate") === "fact: compact dsh-ltm-gate", "S4 compact title marks fact + project tag");

{
  const ctx = makeCtx();
  apply(ctx, { serverName: "ltm" });
  const sessionEvts = [];
  const session = {
    header: { cwd: "/Users/OhanSmit/git/dsh-ltm-gate" },
    _events: sessionEvts,
    append(type, data, opts) { sessionEvts.push({ type, data, opts }); },
  };
  const summaryText = "Exact compaction body\nkeep paths /tmp/foo and errors verbatim.";
  await ctx.fire("session/event", session, {
    type: "compaction/summary",
    data: {
      compactionId: "c1",
      summary: [{ type: "text", text: summaryText }],
      shadowedSeqs: [1, 2, 3, 4, 5],
      shadowedTokenCount: 45_000,
      provider: "deepseek",
      model: "deepseek-r1",
      usage: { input_tokens: 8200, output_tokens: 720 },
    },
  });
  ok(ctx._remembered.length === 1, "S4 compaction/summary stores one memory");
  ok(ctx._remembered[0].title === "fact: compact dsh-ltm-gate", "S4 stored title is fact compact for project");
  // Content must now start with a metadata header then the verbatim summary
  const stored = ctx._remembered[0];
  ok(stored.content.startsWith("[Compact:"), "S4 content starts with metadata header");
  ok(stored.content.includes("5 events"), "S4 metadata header includes event count");
  ok(stored.content.includes("tokens freed"), "S4 metadata header includes tokens freed");
  ok(stored.content.includes("deepseek/deepseek-r1"), "S4 metadata header includes provider/model");
  ok(stored.content.includes("8200\u2192720 tokens"), "S4 metadata header includes usage cost");
  ok(stored.content.endsWith(summaryText), "S4 content ends with verbatim summary text");
  ok(stored.memory_type === "summary", "S4 stored memory_type is summary");
  // Tags must include model slug
  ok(stored.tags.includes("project") && stored.tags.includes("dsh-ltm-gate") && stored.tags.includes("session"), "S4 tags include project,name,session");
  ok(stored.tags.includes("deepseek"), "S4 tags include model provenance slug");
  // Importance: 6 + floor(45000/20000) = 6+2 = 8
  ok(stored.importance === 8, "S4 importance scaled by tokens freed (45k -> 8)");
  // Session notice
  const sessionEvents = session._events ?? [];
  ok(sessionEvents.length === 1 && sessionEvents[0].type === "user/message", "S4 notice appended to session after compact store");
  ok(sessionEvents[0].data?.source?.form === "notice", "S4 notice has form=notice source");
  ok(typeof sessionEvents[0].data?.source?.summary === "string" && sessionEvents[0].data.source.summary.includes("dsh-ltm-gate"), "S4 notice summary includes project name");
  await ctx.fire("session/event", session, { type: "user/message", data: {} });
  ok(ctx._remembered.length === 1, "S4 non-compaction events do not store memories");
  // Fallback: no metadata fields -> baseline importance=6
  const ctx2 = makeCtx();
  apply(ctx2, { serverName: "ltm" });
  const sess2 = { header: { cwd: "/Users/OhanSmit/git/dsh-ltm-gate" }, append() {} };
  await ctx2.fire("session/event", sess2, {
    type: "compaction/summary",
    data: { compactionId: "c2", summary: [{ type: "text", text: "bare summary" }] },
  });
  ok(ctx2._remembered[0].importance === 6, "S4 baseline importance=6 when no tokensFreed");
  ok(ctx2._remembered[0].content.startsWith("[Compact]") || ctx2._remembered[0].content.startsWith("[Compact:"), "S4 fallback still gets a Compact header");
}

{
  const ctx = makeCtx();
  apply(ctx, { serverName: "ltm", storeOnCompact: false });
  await ctx.fire("session/event", { header: { cwd: "/tmp/proj" } }, {
    type: "compaction/summary",
    data: { summary: [{ type: "text", text: "should not store" }] },
  });
  ok(ctx._remembered.length === 0, "S4 storeOnCompact false skips remember");
}

{
  const ctx = makeCtx();
  apply(ctx, { serverName: "ltm" });
  await ctx.fire("session/event", { header: { cwd: "/tmp/proj" } }, {
    type: "compaction/summary",
    data: { summary: [{ type: "text", text: "   " }] },
  });
  ok(ctx._remembered.length === 0, "S4 blank summary is not stored");
}

// ---------------------------------------------------------------------------
// S8 - MCP connection namespace (the yaml entry behind the memory tools)
// ---------------------------------------------------------------------------

const GATE_SETTINGS = { serverName: "ltm", recallTools: ["get_recent_memories"], allowTools: [], openAfterFailedRecalls: 3, prompt: "full", storeOnCompact: true };
const MCP_ENTRY_CONFIG = { serverName: "ltm", transport: "streamable-http", url: "http://127.0.0.1:8000/mcp" };

{
  const loader = makeLoader({ ...MCP_ENTRY_CONFIG });
  const ctx = makeCtx({ loader });
  apply(ctx, { serverName: "ltm" });

  const mcp = ctx._registrationsFor("mcp-ltm");
  ok(mcp.length === 1, "S8 the mcp-ltm namespace is served when the entry exists");
  ok(mcp[0].opts.base.url === "http://127.0.0.1:8000/mcp", "S8 the entry config is the composition base");
  ok(mcp[0].opts.base.serverName === "ltm" && mcp[0].opts.base.transport === "streamable-http", "S8 the base mirrors the entry's identity");
  ok(Array.isArray(mcp[0].opts.base.args) && mcp[0].opts.base.args.length === 0 && typeof mcp[0].opts.base.headers === "object", "S8 container keys are materialized so an unchanged value never looks edited");
  ok(loader._updates.length === 0, "S8 an override-free namespace leaves the running entry alone");

  ctx._pushMcpSettings({
    transport: "streamable-http", serverName: "ltm", url: "http://10.0.0.5:9000/mcp",
    headers: { Authorization: "Bearer token" }, args: [], env: {},
    toolCallTimeoutMs: 15000, failOnStartupError: true,
    reconnectEnabled: true, reconnectInitialDelayMs: 250, reconnectMaxDelayMs: 5000, reconnectMaxAttempts: 4,
  });
  ok(loader._updates.length === 1, "S8 a commit is projected onto the live entry");
  const applied = loader._updates[0].config;
  ok(loader._updates[0].id === "include:mcp-ltm", "S8 the projection targets the entry's own (prefixed) id");
  ok(applied.url === "http://10.0.0.5:9000/mcp" && applied.serverName === "ltm", "S8 the entry takes the new endpoint and keeps its server name");
  ok(applied.headers.Authorization === "Bearer token", "S8 headers ride the projection");
  ok(applied.reconnect.enabled === true && applied.reconnect.initialDelayMs === 250 && applied.reconnect.maxDelayMs === 5000 && applied.reconnect.maxAttempts === 4, "S8 every flat reconnect field is nested again");
  ok(applied.toolCallTimeoutMs === 15000 && applied.failOnStartupError === true, "S8 the timeout and startup policy ride the projection");
  ok(applied.command === undefined && applied.args === undefined, "S8 only the selected transport's fields are written");

  // The same value twice is a no-op: an unchanged commit must not restart the bridge.
  ctx._pushMcpSettings({
    transport: "streamable-http", serverName: "ltm", url: "http://10.0.0.5:9000/mcp",
    headers: { Authorization: "Bearer token" }, args: [], env: {},
    toolCallTimeoutMs: 15000, failOnStartupError: true,
    reconnectEnabled: true, reconnectInitialDelayMs: 250, reconnectMaxDelayMs: 5000, reconnectMaxAttempts: 4,
  });
  ok(loader._updates.length === 1, "S8 re-committing the same value does not restart the bridge");

  // Clearing an override is a real change: the entry must move back.
  ctx._pushMcpSettings({ transport: "streamable-http", serverName: "ltm", url: "http://127.0.0.1:8000/mcp", headers: {}, args: [], env: {} });
  ok(loader._updates.length === 2 && loader._updates[1].config.url === "http://127.0.0.1:8000/mcp", "S8 clearing an override pushes the base value back to the entry");
  ok(loader._updates[1].config.reconnect === undefined, "S8 a cleared reconnect block is dropped, not defaulted");
}

{
  const loader = makeLoader({ ...MCP_ENTRY_CONFIG });
  const ctx = makeCtx({ loader });
  apply(ctx, { serverName: "ltm" });
  ctx._pushMcpSettings({ transport: "stdio", serverName: "ltm", args: [], env: {}, headers: {} });
  ok(loader._updates.length === 0, "S8 a stdio value with no command is refused instead of pushed");
  ctx._pushMcpSettings({ transport: "stdio", serverName: "ltm", command: "python", args: ["-m", "ltm"], env: { LTM_DB: "/data/mem.db" }, headers: {} });
  ok(loader._updates.length === 1 && loader._updates[0].config.command === "python", "S8 a stdio value is projected with its command");
  ok(loader._updates[0].config.cwd === "" && loader._updates[0].config.env.LTM_DB === "/data/mem.db", "S8 stdio args, env and cwd ride the projection");
  ok(loader._updates[0].config.url === undefined, "S8 a stdio projection carries no url");
}

{
  const loader = makeLoader({ ...MCP_ENTRY_CONFIG });
  const ctx = makeCtx({ loader });
  apply(ctx, { serverName: "ltm", rememberTool: "store_memory" });
  ok(ctx._registrationsFor("ltm-gate")[0].opts.base.rememberTool === "store_memory", "S8 the gate namespace carries rememberTool in its base");

  ctx._pushMcpSettings({
    transport: "streamable-http", serverName: "ltm", url: "http://10.0.0.5:9000/mcp",
    headers: { Authorization: "Bearer token" }, args: [], env: {},
  });
  await ctx.fire("session/event", { header: { cwd: "/tmp/proj" } }, {
    type: "compaction/summary",
    data: { summary: [{ type: "text", text: "body" }] },
  });
  const call = ctx._calls.find((c) => c.name === "store_memory");
  ok(!!call, "S8 the compaction call uses the configured tool name");
  ok(call.url === "http://10.0.0.5:9000/mcp", "S8 the compaction call posts to the configured endpoint, not a hardcoded localhost");
  ok(call.headers.Authorization === "Bearer token", "S8 the compaction call sends the configured headers");
}

{
  const loader = makeLoader({ ...MCP_ENTRY_CONFIG });
  const ctx = makeCtx({ loader });
  apply(ctx, { serverName: "ltm" });
  ctx._pushMcpSettings({ transport: "stdio", serverName: "ltm", command: "python", args: [], env: {}, headers: {} });
  await ctx.fire("session/event", { header: { cwd: "/tmp/proj" } }, {
    type: "compaction/summary",
    data: { summary: [{ type: "text", text: "body" }] },
  });
  ok(ctx._calls.length === 0, "S8 a stdio bridge gets no direct HTTP compaction call");
}

{
  const loader = makeLoader({ ...MCP_ENTRY_CONFIG }, { visible: false });
  const ctx = makeCtx({ loader });
  apply(ctx, { serverName: "ltm" });
  ok(ctx._registrationsFor("mcp-ltm").length === 0, "S8 a not-yet-created entry serves no namespace");
  loader.show();
  await ctx.fire("loader/entry-init", loader._entry);
  ok(ctx._registrationsFor("mcp-ltm").length === 1, "S8 the namespace is served once the entry appears");
}

{
  const ctx = makeCtx({ loader: makeLoader({ serverName: "ltm", url: "http://127.0.0.1:8000/mcp" }) });
  apply(ctx, { serverName: "ltm" });
  ok(ctx._registrationsFor("mcp-ltm").length === 0, "S8 an entry without a transport serves no namespace");
}

{
  // No loader service at all: the gate still works and nothing MCP is served.
  const ctx = makeCtx();
  apply(ctx, { serverName: "ltm" });
  ok(ctx._registrationsFor("mcp-ltm").length === 0, "S8 no loader -> no MCP namespace");
  ok(ctx._registrationsFor("ltm-gate").length === 1, "S8 no loader -> the gate namespace is still served");
}

{
  const loader = makeLoader({ ...MCP_ENTRY_CONFIG }, { failUpdate: true });
  const ctx = makeCtx({ loader });
  apply(ctx, { serverName: "ltm" });
  ctx._pushMcpSettings({ transport: "streamable-http", serverName: "ltm", url: "http://elsewhere/mcp", args: [], env: {}, headers: {} });
  await new Promise((resolve) => setTimeout(resolve, 0));
  ok(loader._updates.length === 0, "S8 a refused entry update is swallowed instead of breaking activation");
}

console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);