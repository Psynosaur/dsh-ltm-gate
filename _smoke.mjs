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
const { apply, sanitizeProject } = mod;

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
function makeCtx() {
  const listeners = {};
  const sections = [];
  const commands = [];
  return {
    logger: { warn: () => {} },
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

console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);