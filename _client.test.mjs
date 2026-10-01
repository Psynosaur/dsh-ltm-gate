// Structural + behavioural test for the browser half (lib/client.js).
//
// The bundle is a script that registers a lazy-CJS factory on the client module
// system, so it is executed here against a fake window, then materialized with a
// minimal React shim. That proves the two things a browser cannot tell us until
// it is too late: the factory registers as "dsh-ltm-gate", and the card it
// contributes claims the "ltm-gate" settings namespace with a working form.
import { readFileSync } from "fs";
import { fileURLToPath } from "url";

let pass = 0, fail = 0;
const ok = (cond, label) => { if (cond) { pass++; console.log("PASS", label); } else { fail++; console.log("FAIL", label); } };

const SRC = readFileSync(fileURLToPath(new URL("./lib/client.js", import.meta.url)), "utf8");

// ---- execute the bundle against a fake module loader -----------------------

const loads = [];
const fakeWindow = { __ModuleLoader__: { load(record) { loads.push(record); } } };
new Function("window", SRC)(fakeWindow);

ok(loads.length === 1, "C1 bundle registers exactly one module");
const record = loads[0] || {};
ok(record.id === "dsh-ltm-gate", "C1 module id is the package name");
ok(typeof record.factory === "function", "C1 registration carries a lazy factory");

// ---- materialize with a React shim ----------------------------------------

function createElement(type, props) {
  const children = Array.prototype.slice.call(arguments, 2);
  const next = {};
  if (props) for (const key of Object.keys(props)) next[key] = props[key];
  if (children.length === 1) next.children = children[0];
  else if (children.length > 1) next.children = children;
  return { type, props: next };
}
const ReactShim = { createElement };
const reactRuntimeShim = { jsx: createElement, jsxs: createElement, Fragment: "Fragment" };
const requireShim = (id) => {
  if (id === "react") return ReactShim;
  if (id === "react/jsx-runtime") return reactRuntimeShim;
  throw new Error("unexpected require: " + id);
};

const exports = record.factory(requireShim);
ok(typeof exports.apply === "function", "C2 exports apply");
ok(Array.isArray(exports.inject) && exports.inject.indexOf("slots") !== -1 && exports.inject.indexOf("settingsScope") !== -1, "C2 injects slots + settingsScope");

// ---- mount against a stub host --------------------------------------------

function makeScope(initial) {
  let state = initial;
  const listeners = new Set();
  const writes = [];
  return {
    getSnapshot: () => state,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    set(field, value) { writes.push({ op: "set", field, value }); return Promise.resolve(); },
    unset(field) { writes.push({ op: "unset", field }); return Promise.resolve(); },
    _writes: writes,
    _push(next) { state = next; Array.from(listeners).forEach((listener) => listener()); },
  };
}

const scope = makeScope({
  status: "ready",
  value: {
    serverName: "ltm",
    recallTools: ["get_recent_memories"],
    allowTools: ["todo_write", "ask_user_question"],
    openAfterFailedRecalls: 3,
    prompt: "full",
    storeOnCompact: true,
  },
  base: { serverName: "ltm", prompt: "full" },
  user: { allowTools: ["todo_write", "ask_user_question"] },
  revision: 4,
  writable: true,
  mode: "host",
});

// The MCP connection card binds the same-named namespace; its scope carries the
// entry config as the composition base, exactly like the host half serves it.
const mcpScope = makeScope({
  status: "ready",
  value: {
    transport: "streamable-http",
    serverName: "ltm",
    url: "http://127.0.0.1:8000/mcp",
    headers: {},
    args: [],
    env: {},
  },
  base: { transport: "streamable-http", serverName: "ltm", url: "http://127.0.0.1:8000/mcp" },
  user: {},
  revision: 2,
  writable: true,
  mode: "host",
});

const scopes = { "ltm-gate": scope, "mcp-ltm": mcpScope };

const bound = [];
const registered = [];
const injected = [];
const ctx = {
  settingsScope: { bind(spec) { bound.push(spec); return scopes[spec.namespace]; } },
  effect(fn) { const disposer = fn(); return typeof disposer === "function" ? disposer : () => {}; },
  slots: {
    inject(name, produce) { injected.push(name); registered.push(produce()); },
    register(options, component) { return { options, component }; },
  },
};

exports.apply(ctx);
ok(bound.length === 2, "C3 binds one scope per card");
ok(bound[0].namespace === "ltm-gate" && bound[1].namespace === "mcp-ltm", "C3 the scopes are the gate and the MCP entry");
ok(injected.indexOf("settings.plugin.item") !== -1, "C3 contributes to settings.plugin.item");
ok(registered.length === 2, "C3 registers one card per namespace");
const entry = registered[0];
const mcpEntry = registered[1];
ok(entry && entry.options.name === "settings.plugin.item", "C3 registers into the card slot");
ok(entry && entry.options.key === "ltm-gate", "C3 the gate card key is its settings namespace");
ok(mcpEntry && mcpEntry.options.key === "mcp-ltm", "C3 the MCP card key is its settings namespace");
ok(entry && typeof entry.options.inject === "function", "C3 the card registration carries an inject face");
ok(entry && typeof entry.component === "function", "C3 the card has a component");

// ---- render + drive the form ----------------------------------------------

const face = entry.options.inject();
ok(face.hooks && face.hooks.ltmGateCard && typeof face.hooks.ltmGateCard.getSnapshot === "function", "C4 the inject face exposes the card hook store");

const selector = (snapshot) => snapshot;
const store = face.hooks.ltmGateCard;

/** Render any card with its slot-injected hook prop, like the slot runtime. */
function renderCard(cardEntry, cardFace, propName, hookName) {
  const props = {};
  for (const key of Object.keys(cardFace)) props[key] = cardFace[key];
  props[propName] = (sel) => (sel || selector)(cardFace.hooks[hookName].getSnapshot());
  return cardEntry.component(props);
}
function render() {
  return renderCard(entry, face, "useLtmGateCard", "ltmGateCard");
}

function walk(node, visit) {
  if (node === null || node === undefined || node === false) return;
  if (Array.isArray(node)) { for (const child of node) walk(child, visit); return; }
  if (typeof node === "string" || typeof node === "number") { visit({ type: "#text", props: { children: String(node) } }); return; }
  visit(node);
  if (node.props && node.props.children !== undefined) walk(node.props.children, visit);
}
function texts(node) { const out = []; walk(node, (n) => { if (n.type === "#text") out.push(n.props.children); }); return out; }
function nodesOfType(node, type) { const out = []; walk(node, (n) => { if (n.type === type) out.push(n); }); return out; }

let tree = render();
ok(tree.type === "li", "C5 the card renders a list item for the cards list");
ok(texts(tree).join(" ").indexOf("LTM gate") !== -1, "C5 collapsed card names the plugin");
ok(nodesOfType(tree, "textarea").length === 0, "C5 collapsed card hides the fields");

face.toggle();
tree = render();
ok(nodesOfType(tree, "textarea").length === 1, "C6 expanded card renders the system-prompt textarea");
ok(nodesOfType(tree, "select").length === 1, "C6 expanded card renders the prompt-mode select");
ok(nodesOfType(tree, "input").length === 7, "C6 expanded card renders every text, list, number and boolean control");
const joined = texts(tree).join(" ");
ok(joined.indexOf("Custom memory rules") !== -1, "C6 the custom system prompt field is labelled");
ok(joined.indexOf("{project}") !== -1, "C6 the custom prompt hint documents the placeholders");
ok(joined.indexOf("Recall tools") !== -1, "C6 the recall-tools field is labelled");
ok(joined.indexOf("Overridden") !== -1, "C6 a user-overridden field is badged");

// staged edit -> save writes exactly the changed field
face.edit("openAfterFailedRecalls", "9");
let state = store.getSnapshot();
ok(state.dirty === true, "C7 staging marks the card dirty before any write");
await face.save();
const recallWrite = scope._writes.filter((w) => w.field === "openAfterFailedRecalls");
ok(recallWrite.length === 1 && recallWrite[0].op === "set" && recallWrite[0].value === 9, "C7 save writes the staged number as an integer");
ok(store.getSnapshot().dirty === false, "C7 a landed save clears the dirty flag");

// invalid draft blocks the save and reports why
face.edit("openAfterFailedRecalls", "0");
await face.save();
ok(scope._writes.filter((w) => w.field === "openAfterFailedRecalls").length === 1, "C8 an invalid number writes nothing");
const invalidText = texts(render()).join(" ");
ok(invalidText.indexOf("whole number") !== -1, "C8 the invalid draft explains itself");

// list fields round-trip through comma/newline text
face.discard();
face.edit("recallTools", "get_recent_memories, search_by_tags");
await face.save();
const listWrite = scope._writes.filter((w) => w.field === "recallTools");
ok(listWrite.length === 1 && listWrite[0].value.length === 2 && listWrite[0].value[1] === "search_by_tags", "C9 a list field is split and trimmed into an array");

// clearing a text field unsets it so it re-inherits the composition default
face.edit("project", "");
await face.save();
const unsetWrite = scope._writes.filter((w) => w.field === "project");
ok(unsetWrite.length === 1 && unsetWrite[0].op === "unset", "C10 clearing a text field unsets the override");

// reset-to-default path
await face.resetField("allowTools");
ok(scope._writes.filter((w) => w.field === "allowTools" && w.op === "unset").length === 1, "C11 reset unsets the stored override");

// live scope change repaints the card
const before = store.getSnapshot();
scope._push({ status: "ready", value: { serverName: "mem" }, base: {}, user: {}, revision: 5, writable: false, mode: "memory" });
const after = store.getSnapshot();
ok(before !== after, "C12 a scope commit republishes the card snapshot");
ok(after.writable === false, "C12 read-only deployments are reflected");
const readOnlyText = texts(render()).join(" ");
ok(readOnlyText.indexOf("read-only") !== -1, "C12 the read-only notice is shown");

{
  const unavailable = makeScope({ status: "unavailable", value: undefined, base: undefined, user: undefined, revision: undefined, writable: false, mode: "memory" });
  const bound2 = [];
  const registered2 = [];
  exports.apply({
    settingsScope: { bind(spec) { bound2.push(spec); return unavailable; } },
    effect(fn) { fn(); },
    slots: { inject(name, produce) { registered2.push(produce()); }, register(options, component) { return { options, component }; } },
  });
  const face2 = registered2[0].options.inject();
  face2.toggle();
  const tree2 = renderCard(registered2[0], face2, "useLtmGateCard", "ltmGateCard");
  ok(tree2 === null, "C13 an unserved gate namespace renders nothing, like the built-in cards");
  const face3 = registered2[1].options.inject();
  face3.toggle();
  const tree3 = renderCard(registered2[1], face3, "useLtmMcpCard", "ltmMcpCard");
  ok(tree3 === null, "C13 an unserved MCP namespace renders nothing too");
}

// ---- chrome parity with the built-in cards ---------------------------------

const classOf = (node) => (node && node.props && node.props.className) || "";
if (store.getSnapshot().expanded) face.toggle(); // normalize to collapsed
const collapsed = render();
ok(classOf(collapsed).indexOf("ltmg_card") !== -1, "C14 the card root carries the card class");
ok(nodesOfType(collapsed, "svg").length === 1, "C14 the collapsed header renders the disclosure chevron");
ok(classOf(nodesOfType(collapsed, "button")[0]).indexOf("ltmg_header") !== -1, "C14 the header is a header-classed button");
ok(nodesOfType(collapsed, "button")[0].props["aria-expanded"] === false, "C14 a collapsed header reports aria-expanded false");
ok(typeof nodesOfType(collapsed, "button")[0].props["aria-label"] === "string", "C14 the header carries an accessible name");
ok(nodesOfType(collapsed, "span").some((n) => classOf(n).indexOf("ltmg_name") !== -1), "C14 the title uses the name class");

if (!store.getSnapshot().expanded) face.toggle(); // normalize to expanded
const expanded = render();
ok(classOf(expanded).indexOf("ltmg_cardOpen") !== -1, "C15 an open card carries the open class");
ok(nodesOfType(expanded, "svg").length === 1 && classOf(nodesOfType(expanded, "svg")[0]).indexOf("ltmg_chevronOpen") !== -1, "C15 the chevron rotates when open");
const footer = nodesOfType(expanded, "div").filter((n) => classOf(n).indexOf("ltmg_footer") !== -1)[0];
ok(!!footer, "C15 the actions live in a footer row");
const footerButtons = nodesOfType(footer, "button").map((n) => classOf(n));
ok(footerButtons.some((c) => c.indexOf("ltmg_discard") !== -1) && footerButtons.some((c) => c.indexOf("ltmg_save") !== -1), "C15 the footer holds discard and save");
const fields = nodesOfType(expanded, "div").filter((n) => classOf(n).indexOf("ltmg_field") !== -1);
ok(fields.length === 9, "C15 every setting renders as a field row");
ok(fields.every((f) => nodesOfType(f, "p").length === 1), "C15 every field row ends in a hint or invalid line");

// The stylesheet is the shared chrome, declared under this bundle's own prefix.
const cssStart = SRC.indexOf("var CSS = [");
ok(cssStart !== -1, "C16 the bundle ships its own stylesheet");
for (const token of ["--dsw-alias-bg-layer-3", "--dsw-alias-border-l2", "--dsw-alias-label-primary", "--dsw-alias-brand-primary", "--dsw-alias-label-error"]) {
  ok(SRC.indexOf(token) !== -1, "C16 stylesheet uses the shared token " + token);
}
ok(SRC.indexOf("data-plugin-css") !== -1 && SRC.indexOf("dsh-ltm-gate/card.css") !== -1, "C16 the stylesheet is injected once under a plugin-scoped tag");
ok(SRC.indexOf("--dsw-") !== -1 && !/style: \{/.test(SRC), "C16 the card does not fall back to inline styling");

// ---- the MCP connection card ----------------------------------------------

const mcpFace = mcpEntry.options.inject();
ok(mcpFace.hooks.ltmMcpCard && typeof mcpFace.hooks.ltmMcpCard.getSnapshot === "function", "C17 the MCP card exposes its own hook store");
ok(mcpFace.hooks.ltmGateCard === undefined, "C17 the hook stores are per card");
const mcpStore = mcpFace.hooks.ltmMcpCard;
const renderMcp = () => renderCard(mcpEntry, mcpFace, "useLtmMcpCard", "ltmMcpCard");
const fieldRows = (tree) => nodesOfType(tree, "div").filter((n) => classOf(n).indexOf("ltmg_field") !== -1);

mcpFace.toggle();
let mcpTree = renderMcp();
ok(mcpTree.type === "li" && texts(mcpTree).join(" ").indexOf("LTM MCP server") !== -1, "C17 the MCP card names the entry it configures");
ok(nodesOfType(mcpTree, "select").length === 1, "C17 the transport chooser is a select");
ok(nodesOfType(mcpTree, "textarea").length === 1, "C17 streamable-http renders the headers field, not the env field");
ok(fieldRows(mcpTree).length === 10, "C17 only the rows the selected transport uses are rendered");

// switching transport re-derives the row set from the staged draft
mcpFace.edit("transport", "stdio");
mcpTree = renderMcp();
ok(nodesOfType(mcpTree, "textarea").length === 1, "C17 stdio renders the env field, not the headers field");
ok(fieldRows(mcpTree).length === 12, "C17 stdio renders its own row set before anything is saved");

mcpFace.edit("command", "python");
await mcpFace.save();
const stdioWrites = mcpScope._writes.filter((w) => w.field === "transport" || w.field === "command");
ok(stdioWrites.length === 2, "C18 saving a transport switch writes the chooser and the newly visible row");
ok(stdioWrites.every((w) => w.op === "set"), "C18 both writes are sets");
ok(mcpScope._writes.filter((w) => w.field === "url").length === 0, "C18 a row hidden by the transport is never written");

// dict fields round-trip as one Name: value per line
mcpFace.discard();
mcpFace.edit("headers", "Authorization: Bearer abc" + String.fromCharCode(10) + "X-Trace: 7");
await mcpFace.save();
const headerWrite = mcpScope._writes.filter((w) => w.field === "headers").pop();
ok(headerWrite && headerWrite.value.Authorization === "Bearer abc", "C18 a dict field parses the first Name: value pair");
ok(headerWrite && headerWrite.value["X-Trace"] === "7", "C18 every line of the dict becomes an entry");

// a malformed dict line blocks the save and explains itself
mcpFace.discard();
mcpFace.edit("headers", "no colon here");
await mcpFace.save();
ok(mcpScope._writes.filter((w) => w.field === "headers").length === 1, "C18 a malformed header line writes nothing");
ok(texts(renderMcp()).join(" ").indexOf("Name: value") !== -1, "C18 the malformed line explains itself");

// a draft on a row the transport hides is dropped instead of saved
mcpFace.discard();
mcpFace.edit("url", "http://elsewhere/mcp");
mcpFace.edit("transport", "stdio");
await mcpFace.save();
ok(mcpScope._writes.filter((w) => w.field === "url").length === 0, "C19 a staged row hidden by the transport is not written");
ok(mcpStore.getSnapshot().dirty === false, "C19 dropping the hidden draft clears the unsaved marker");

console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
