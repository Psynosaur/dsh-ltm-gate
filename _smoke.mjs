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
  // storeCompactMemory does initialize -> tools/call via fetch (bypasses
  // ToolRuntime Code Mode collapse). Stub fetch to handle both calls.
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    let body;
    try { body = JSON.parse(init && init.body ? init.body : "{}"); } catch { body = {}; }
    if (body.method === "initialize") {
      return {
        ok: true,
        headers: { get: (h) => h === "mcp-session-id" ? "smoke-session-123" : "application/json" },
        text: async () => JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2024-11-05" } }),
      };
    }
    if (body.method === "tools/call" && body.params && body.params.name === "remember") {
      remembered.push(body.params.arguments);
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
  return {
    logger: { warn: () => {} },
    tools: toolsStub,
    on(name, fn) { (listeners[name] ??= []).push(fn); },
    systemPrompt: { section(s) { sections.push(s); } },
    inject(keys, fn) { fn({ commands: { register(c) { commands.push(c); } } }); },
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
    _restoreFetch: () => { globalThis.fetch = origFetch; },
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
  ok(/current_project":"llama\.cpp-public"/.test(deny1.reason), "S1 deny message carries project tag from agent cwd");
  ok(/"scope":"project"/.test(deny1.reason) && /"detail":"digest"/.test(deny1.reason), "S1 bootstrap recall is scoped + index-first (injection budget)");

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
  // Session format v4 rejects the retired v3 wrapper ({kind:"plugin"}) with
  // "format v4 message requires a producer-owned source kind" (see
  // @deepseek-ai/dsh-session-format-v3-to-v4: source() / producerKind()).
  ok(d2.messages[1].source?.kind === "plugin:ltm-gate", "S1 reminder source kind is producer-owned, not the retired v3 {kind:'plugin'}");
  const d3 = await ctx.fire("agent/pre-step", { agent, signal: new AbortController().signal }, async () => ({ kind: "enter", messages: [{ id: "m1" }] }));
  ok(d3.messages.length === 1, "S1 no reminder once satisfied");

  const sec = ctx._sections.find(s => s.name === "ltm:policy");
  const rulesText = sec ? sec.text({ agent }) : "";
  ok(!!sec && rulesText.includes("WORKING RULES"), "S1 ltm:policy section renders rules");
  ok(rulesText.includes("budgeted") && rulesText.includes("file_paths"), "S1 rules teach the budgeted recall + staleness-anchor contract");
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
  ok(sessionEvents[0].data?.source?.kind === "plugin:ltm-gate", "S4 notice source kind is producer-owned, not the retired v3 {kind:'plugin'}");
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

// --- S5: injection projection + quality-aware gate -------------------------
{
  const ctx = makeCtx();
  apply(ctx, { serverName: "ltm", projectRecall: true, maxRecallChars: 2000 });
  const payload = JSON.stringify({
    success: true,
    data: [
      { id: "m1", memory_type: "preference", title: "off-project noise", tags: ["SecVisionJetson"], importance: 10, timestamp: "2026-01-01T00:00:00Z", content: "x" },
      { id: "m4", memory_type: "preference", title: "recent critical", tags: ["unrelated"], importance: 9, timestamp: new Date().toISOString(), content: "w" },
      { id: "m2", memory_type: "preference", title: "project pref", tags: ["preference", "proj"], importance: 7, content: "y" },
      { id: "m3", memory_type: "fact", title: "a fact", tags: ["project", "proj"], importance: 8, content: "z" },
    ],
  });
  const agent = { meta: { cwd: "D:/tmp/proj" } };
  const decision = await ctx.fire(
    "tools/post-execute",
    { name: "mcp__ltm__get_recent_memories", agent, arguments: { current_project: "proj" } },
    { isError: false, content: [{ type: "text", text: payload }] },
    async () => ({ kind: "accept", content: [{ type: "text", text: payload }] }),
  );
  const out = JSON.parse(decision.content[0].text);
  ok(out.data.length === 3 && out.data.every((item) => item.id !== "m1"), "S5 projection drops stale off-project preferences");
  ok(out.data.some((item) => item.id === "m4"), "S5 projection keeps recent high-importance preferences");
  ok(out.projected && out.projected.dropped_preferences === 1, "S5 projection reports what it dropped and keeps JSON valid");
}

{
  const ctx = makeCtx();
  apply(ctx, { serverName: "ltm" });
  const agent = { meta: { cwd: "D:/tmp/proj" } };
  await ctx.fire(
    "tools/post-execute",
    { name: "mcp__ltm__get_recent_memories", agent, arguments: { current_project: "some-other-project" } },
    { isError: false },
    async () => ({ kind: "accept" }),
  );
  const denied = await ctx.fire("tools/pre-execute", { name: "read", agent }, async () => ({ kind: "allow" }));
  ok(denied.kind === "deny", "S5 recall for a different project does not satisfy the gate");

  const ctx2 = makeCtx();
  apply(ctx2, { serverName: "ltm" });
  const agent2 = { meta: { cwd: "D:/tmp/proj" } };
  await ctx2.fire(
    "tools/post-execute",
    { name: "mcp__ltm__get_recent_memories", agent: agent2, arguments: { current_project: "proj" } },
    { isError: false },
    async () => ({ kind: "accept" }),
  );
  const allowed = await ctx2.fire("tools/pre-execute", { name: "read", agent: agent2 }, async () => ({ kind: "allow" }));
  ok(allowed.kind === "allow", "S5 recall naming the current project satisfies the gate");
}

// --- S6: store gate ---------------------------------------------------------
{
  const ctx = makeCtx();
  apply(ctx, { serverName: "ltm", storeGate: "remind" });
  const agent = { meta: { cwd: "D:/tmp/proj" } };
  await ctx.fire("tools/post-execute", { name: "mcp__ltm__get_recent_memories", agent, arguments: { current_project: "proj" } }, { isError: false }, async () => ({ kind: "accept" }));
  await ctx.fire("tools/post-execute", { name: "write", agent }, { isError: false }, async () => ({ kind: "accept" }));
  const step = await ctx.fire("agent/pre-step", { agent, signal: new AbortController().signal }, async () => ({ kind: "enter", messages: [] }));
  ok(step.messages.length === 1 && /changed files/.test(step.messages[0].content[0].text), "S6 reminds after a write with no store");
  await ctx.fire("tools/post-execute", { name: "mcp__ltm__remember", agent }, { isError: false }, async () => ({ kind: "accept" }));
  const step2 = await ctx.fire("agent/pre-step", { agent, signal: new AbortController().signal }, async () => ({ kind: "enter", messages: [] }));
  ok(step2.messages.length === 0, "S6 reminder clears once something is stored");
}
{
  const ctx = makeCtx();
  apply(ctx, { serverName: "ltm", storeGate: "block" });
  const agent = { meta: { cwd: "D:/tmp/proj" } };
  await ctx.fire("tools/post-execute", { name: "mcp__ltm__get_recent_memories", agent, arguments: { current_project: "proj" } }, { isError: false }, async () => ({ kind: "accept" }));
  await ctx.fire("tools/post-execute", { name: "edit", agent }, { isError: false }, async () => ({ kind: "accept" }));
  const denied = await ctx.fire("tools/pre-execute", { name: "read", agent }, async () => ({ kind: "allow" }));
  ok(denied.kind === "deny" && /store gate/i.test(denied.reason), "S6 storeGate=block denies non-memory tools after an unstored write");
  const allowed = await ctx.fire("tools/pre-execute", { name: "mcp__ltm__remember", agent }, async () => ({ kind: "allow" }));
  ok(allowed.kind === "allow", "S6 store tools stay callable while the store gate blocks");
}

console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);