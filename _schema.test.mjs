// Real-schema test: imports the plugin with the ACTUAL schemastery and asserts
// the settings namespace schema accepts valid sections and rejects invalid ones.
//
// This is the test that catches a schema written in another library's idiom
// (zod's `.int()` / `.enum()` / `.optional()` / `.describe()` do not exist in
// schemastery, where they are `natural()` / `union([const(...)])` /
// `required(false)` / `description()`), which would otherwise only surface as a
// failed namespace registration when the host boots.
import { readFileSync } from "node:fs";
import { settingsSchema, mcpSettingsSchema, mcpSettingsBase, mcpEntryConfig, sameSettingsValue } from "./lib/index.js";

let pass = 0, fail = 0;
const ok = (cond, label) => { if (cond) { pass++; console.log("PASS", label); } else { fail++; console.log("FAIL", label); } };

const good = {
  serverName: "ltm",
  recallTools: ["get_recent_memories"],
  allowTools: [],
  openAfterFailedRecalls: 3,
  prompt: "full",
  storeOnCompact: true,
};

let resolved;
try {
  resolved = settingsSchema(good);
  ok(resolved && resolved.serverName === "ltm", "Z1 the schema resolves a valid section");
  ok(resolved.prompt === "full", "Z1 the prompt mode round-trips");
  ok(Array.isArray(resolved.recallTools) && resolved.recallTools.length === 1, "Z1 array fields round-trip");
} catch (error) {
  ok(false, "Z1 the schema resolves a valid section: " + String(error && error.message));
}

ok(typeof settingsSchema.toJSON === "function", "Z2 the schema serializes for the wire envelope");

const rejects = [
  ["an unknown prompt mode", { ...good, prompt: "nope" }],
  ["an over-long server name", { ...good, serverName: "x".repeat(40) }],
  ["an empty server name", { ...good, serverName: "" }],
  ["an empty recallTools list", { ...good, recallTools: [] }],
  ["a zero fail-open threshold", { ...good, openAfterFailedRecalls: 0 }],
  ["a fractional fail-open threshold", { ...good, openAfterFailedRecalls: 1.5 }],
  ["a negative fail-open threshold", { ...good, openAfterFailedRecalls: -2 }],
  ["a non-boolean storeOnCompact", { ...good, storeOnCompact: "yes" }],
];
for (const [label, bad] of rejects) {
  let threw = false;
  try { settingsSchema(bad); } catch { threw = true; }
  ok(threw, "Z3 rejects " + label);
}

// Optional fields may be absent and may be present as strings.
for (const extra of [
  ["absent optionals", {}],
  ["present optionals", { project: "dsh-ltm-gate", promptTemplate: "RECALL {project} via {server}: {tools}" }],
]) {
  let threw = false;
  try { settingsSchema({ ...good, ...extra[1] }); } catch { threw = true; }
  ok(!threw, "Z4 accepts " + extra[0]);
}

// ---------------------------------------------------------------------------
// Z5 - the mcp-ltm connection schema (the yaml entry behind the memory tools)
// ---------------------------------------------------------------------------

const mcpGood = { transport: "streamable-http", serverName: "ltm", url: "http://127.0.0.1:8000/mcp" };

let mcpResolved;
try {
  mcpResolved = mcpSettingsSchema(mcpGood);
  ok(mcpResolved.transport === "streamable-http", "Z5 the mcp schema resolves a streamable-http section");
  ok(mcpResolved.url === "http://127.0.0.1:8000/mcp", "Z5 the endpoint round-trips");
  ok(typeof mcpResolved.headers === "object" && Array.isArray(mcpResolved.args), "Z5 schemastery materializes the dict/array containers");
} catch (error) {
  ok(false, "Z5 the mcp schema resolves a streamable-http section: " + String(error && error.message));
}

try {
  const stdio = mcpSettingsSchema({ transport: "stdio", command: "python", args: ["-m", "ltm"], env: { A: "b" } });
  ok(stdio.command === "python" && stdio.args.length === 2 && stdio.env.A === "b", "Z5 the stdio branch resolves command, args and env");
} catch (error) {
  ok(false, "Z5 the stdio branch resolves: " + String(error && error.message));
}

const mcpRejects = [
  ["a missing transport", { serverName: "ltm", url: "http://x/mcp" }],
  ["an unknown transport", { ...mcpGood, transport: "websocket" }],
  ["a non-string header value", { ...mcpGood, headers: { retries: 3 } }],
  ["a fractional timeout", { ...mcpGood, toolCallTimeoutMs: 1.5 }],
  ["a negative timeout", { ...mcpGood, toolCallTimeoutMs: -1 }],
  ["a non-boolean reconnect flag", { ...mcpGood, reconnectEnabled: "yes" }],
  ["a non-string stdio argument", { transport: "stdio", command: "python", args: [7] }],
];
for (const [label, bad] of mcpRejects) {
  let threw = false;
  try { mcpSettingsSchema(bad); } catch { threw = true; }
  ok(threw, "Z6 the mcp schema rejects " + label);
}

// ---------------------------------------------------------------------------
// Z7 - projection: entry config <-> flat scope value <-> wire config
// ---------------------------------------------------------------------------

const entryConfig = { serverName: "ltm", transport: "streamable-http", url: "http://127.0.0.1:8000/mcp" };
const entryBase = mcpSettingsBase(entryConfig);
ok(sameSettingsValue(entryBase, mcpSettingsSchema(entryBase)), "Z7 an override-free namespace resolves to its own base (no needless bridge restart)");

const overridden = mcpSettingsSchema({ ...entryBase, url: "http://10.0.0.5:9000/mcp", reconnectEnabled: true, reconnectMaxAttempts: 4 });
ok(!sameSettingsValue(entryBase, overridden), "Z7 an override makes the resolved value differ from the base");

const wire = mcpEntryConfig(overridden, "ltm");
ok(wire.transport === "streamable-http" && wire.url === "http://10.0.0.5:9000/mcp", "Z7 the wire config carries the endpoint");
ok(wire.reconnect.enabled === true && wire.reconnect.maxAttempts === 4, "Z7 flat reconnect fields nest for the bridge");
ok(wire.command === undefined && wire.args === undefined, "Z7 transport-irrelevant fields are dropped");

const stdioWire = mcpEntryConfig({ transport: "stdio", serverName: "ltm", command: "python", args: ["-m", "ltm"], env: { A: "b" } }, "ltm");
ok(stdioWire.command === "python" && stdioWire.cwd === "" && stdioWire.headers === undefined, "Z7 a stdio projection carries command/cwd and no headers");
ok(mcpEntryConfig({ transport: "stdio", serverName: "ltm" }, "ltm") === undefined, "Z7 stdio without a command is not projected");
ok(mcpEntryConfig({ transport: "streamable-http", serverName: "ltm" }, "ltm") === undefined, "Z7 streamable-http without a url is not projected");
ok(mcpEntryConfig({ transport: "streamable-http", url: "http://x/mcp" }, "ltm").serverName === "ltm", "Z7 an unset serverName falls back to the entry's own");

// ---------------------------------------------------------------------------
// Z8 - the full MCP field set the card renders (every row must be accepted)
// ---------------------------------------------------------------------------

const fullMcp = {
  ...mcpGood,
  headers: { Authorization: "Bearer x" },
  toolCallTimeoutMs: 15000,
  failOnStartupError: true,
  reconnectEnabled: true,
  reconnectInitialDelayMs: 250,
  reconnectMaxDelayMs: 5000,
  reconnectMaxAttempts: 4,
};
let fullResolved;
try {
  fullResolved = mcpSettingsSchema(fullMcp);
  ok(fullResolved.failOnStartupError === true, "Z8 failOnStartupError resolves");
  ok(fullResolved.reconnectInitialDelayMs === 250 && fullResolved.reconnectMaxDelayMs === 5000, "Z8 the reconnect delay fields resolve");
  ok(fullResolved.headers.Authorization === "Bearer x", "Z8 the headers dict resolves");
} catch (error) {
  ok(false, "Z8 every card row resolves: " + String(error && error.message));
}

const envStdio = mcpSettingsSchema({ transport: "stdio", command: "python", env: { LTM_DB: "/data/mem.db" } });
ok(envStdio.env.LTM_DB === "/data/mem.db", "Z8 the stdio env map resolves as a string dict");

const fullWire = mcpEntryConfig(fullResolved, "ltm");
ok(fullWire.reconnect.initialDelayMs === 250 && fullWire.reconnect.maxDelayMs === 5000 && fullWire.reconnect.maxAttempts === 4, "Z8 the wire config nests all four reconnect fields");
ok(fullWire.failOnStartupError === true && fullWire.toolCallTimeoutMs === 15000, "Z8 the wire config carries the startup policy and timeout");

for (const [label, bad] of [
  ["a negative reconnect delay", { ...fullMcp, reconnectInitialDelayMs: -1 }],
  ["a fractional reconnect ceiling", { ...fullMcp, reconnectMaxDelayMs: 1.5 }],
  ["a non-boolean failOnStartupError", { ...fullMcp, failOnStartupError: "yes" }],
]) {
  let threw = false;
  try { mcpSettingsSchema(bad); } catch { threw = true; }
  ok(threw, "Z8 the mcp schema rejects " + label);
}

// The gate namespace carries the compaction tool name too.
try {
  const withTool = settingsSchema({ ...good, rememberTool: "store_memory" });
  ok(withTool.rememberTool === "store_memory", "Z8 the gate schema accepts rememberTool");
} catch (error) {
  ok(false, "Z8 the gate schema accepts rememberTool: " + String(error && error.message));
}

// ---------------------------------------------------------------------------
// Z9 - the browser cards and the host schemas cannot drift apart
//
// Every row a card renders must exist in the namespace schema that validates
// the save, or the panel silently fails on that field. The card field lists and
// the schemas are read from source, so a field added on one side alone fails
// here instead of at runtime.
// ---------------------------------------------------------------------------

const clientSrc = readFileSync(new URL("./lib/client.js", import.meta.url), "utf8");
const hostSrc = readFileSync(new URL("./lib/index.js", import.meta.url), "utf8");

const cardKeys = (name) => {
  const at = clientSrc.indexOf("var " + name + " = [");
  const end = clientSrc.indexOf("\n    ];", at);
  return [...clientSrc.slice(at, end).matchAll(/key: "([A-Za-z0-9_]+)"/g)].map((match) => match[1]);
};
const schemaKeys = (name) => {
  const at = hostSrc.indexOf("export const " + name + " = z.object({");
  const end = hostSrc.indexOf("\n});", at);
  return [...hostSrc.slice(at, end).matchAll(/^  ([A-Za-z0-9_]+): z\./gm)].map((match) => match[1]);
};

for (const [card, schema] of [["GATE_FIELDS", "settingsSchema"], ["MCP_FIELDS", "mcpSettingsSchema"]]) {
  const fields = cardKeys(card);
  const accepted = schemaKeys(schema);
  ok(fields.length > 0, "Z9 " + card + " is a non-empty field list");
  const unserved = fields.filter((key) => !accepted.includes(key));
  ok(unserved.length === 0, "Z9 every " + card + " row is accepted by " + schema + (unserved.length ? " (unserved: " + unserved.join(", ") + ")" : ""));
}

ok(cardKeys("GATE_FIELDS").includes("rememberTool"), "Z9 the gate card exposes the compaction tool name");
ok(schemaKeys("mcpSettingsSchema").includes("reconnectInitialDelayMs") && schemaKeys("mcpSettingsSchema").includes("failOnStartupError"), "Z9 the MCP schema serves the full connection field set");

console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
