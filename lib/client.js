"use strict";
// dsh-ltm-gate - browser half.
//
// Registers TWO cards into Settings > Plugins > Plugin configuration, each
// keyed on a settings namespace the host half registers: `ltm-gate` (the gate
// itself) and `mcp-ltm` (the MCP server entry it guards). The pairing is what
// makes a panel appear: the Host serves the namespace, this bundle claims it,
// and the Plugins section dispatches one card per claimed namespace.
//
// Bundle format: the client module system's lazy-CJS factory. Running this file
// only REGISTERS the factory; the module body - stylesheet injection and the
// React surface included - runs at materialization (first import).
//
// The chrome mirrors the built-in plugin cards (same DOM shape, same class-level
// declarations, same design tokens) under its own `ltmg_` prefix rather than
// importing that package's chrome, which the client bundle-purity gate forbids.

window.__ModuleLoader__.load({
  id: "dsh-ltm-gate",
  factory: function (require) {
    "use strict";

    var React = require("react");
    var h = React.createElement;
    var NL = String.fromCharCode(10);

    /** Settings namespaces owned by the Host half. */
    var NS = "ltm-gate";
    var MCP_NS = "mcp-ltm";

    // ---------------------------------------------------------------------
    // Stylesheet: the card chrome, declared under this bundle's own prefix.
    // ---------------------------------------------------------------------

    var CSS = [
      ".ltmg_card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:12px;list-style:none;transition:border-color .16s,background .16s}",
      ".ltmg_card:hover{border-color:var(--dsw-alias-label-dimmed)}",
      ".ltmg_cardOpen{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-label-dimmed)}",
      ".ltmg_header{appearance:none;width:100%;font:inherit;color:inherit;text-align:left;cursor:pointer;background:0 0;border:0;border-radius:12px;align-items:center;gap:12px;padding:14px 16px;display:flex}",
      ".ltmg_header:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}",
      ".ltmg_headText{flex-direction:column;flex:1;gap:4px;min-width:0;display:flex}",
      ".ltmg_name{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:1.4}",
      ".ltmg_description{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.5}",
      ".ltmg_chevron{color:var(--dsw-alias-label-tertiary);flex:none;transition:transform .16s}",
      ".ltmg_chevronOpen{transform:rotate(180deg)}",
      ".ltmg_body{border-top:1px solid var(--dsw-alias-border-l2);margin:0 16px;padding-bottom:8px}",
      ".ltmg_readOnly{color:var(--dsw-alias-label-tertiary);margin:12px 0 0;font-size:12px;line-height:1.5}",
      ".ltmg_pending{white-space:nowrap;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);border-radius:999px;flex:none;padding:1px 8px;font-size:11px;font-weight:500;line-height:17px}",
      ".ltmg_footer{border-top:1px solid var(--dsw-alias-border-l2);justify-content:flex-end;align-items:center;gap:8px;padding:12px 0 4px;display:flex}",
      ".ltmg_failed{min-width:0;color:var(--dsw-alias-label-error);flex:1;margin:0;font-size:12px;line-height:1.5}",
      ".ltmg_discard,.ltmg_save{appearance:none;font:inherit;cursor:pointer;border:1px solid transparent;border-radius:8px;padding:5px 14px;font-size:13px;line-height:1.5}",
      ".ltmg_discard{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);background:0 0}",
      ".ltmg_discard:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed)}",
      ".ltmg_save{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3)}",
      ".ltmg_discard:disabled,.ltmg_save:disabled{opacity:.4;cursor:default}",
      ".ltmg_discard:focus-visible,.ltmg_save:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}",
      ".ltmg_field{flex-direction:column;gap:6px;padding:12px 0;display:flex}",
      ".ltmg_field+.ltmg_field{border-top:1px solid var(--dsw-alias-border-l2)}",
      ".ltmg_head{align-items:center;gap:8px;display:flex}",
      ".ltmg_label{min-width:0;color:var(--dsw-alias-label-primary);flex:1;font-size:13px;font-weight:500;line-height:1.5}",
      ".ltmg_badges{align-items:center;gap:8px;display:inline-flex}",
      ".ltmg_badge{white-space:nowrap;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);border-radius:999px;padding:1px 8px;font-size:11px;font-weight:500;line-height:17px}",
      ".ltmg_reset{font:inherit;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:none;padding:0;font-size:12px;line-height:1.5}",
      ".ltmg_reset:hover:not(:disabled){color:var(--dsw-alias-label-primary)}",
      ".ltmg_reset:disabled{cursor:default;opacity:.5}",
      ".ltmg_input{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);height:34px;font:inherit;color:var(--dsw-alias-label-primary);border-radius:8px;padding:0 12px;font-size:13px;line-height:1.5;box-sizing:border-box;width:100%}",
      ".ltmg_input:focus-visible{border-color:var(--dsw-alias-brand-primary);outline:none}",
      ".ltmg_input:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}",
      ".ltmg_inputInvalid{border-color:var(--dsw-alias-label-error)}",
      ".ltmg_textarea{height:auto;min-height:120px;padding:8px 12px;resize:vertical}",
      ".ltmg_invalid{color:var(--dsw-alias-label-error);margin:0;font-size:12px;line-height:1.5}",
      ".ltmg_hint{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:1.5}",
      ".ltmg_toggle{align-items:center;gap:8px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.5;display:flex}",
      ".ltmg_checkbox{width:16px;height:16px;accent-color:var(--dsw-alias-brand-primary);margin:0}"
    ].join("");

    var CSS_TAG = "dsh-ltm-gate/card.css";
    if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(CSS_TAG) + "]") === null) {
      var styleTag = document.createElement("style");
      styleTag.dataset.plugin = "dsh-ltm-gate";
      styleTag.dataset.pluginCss = CSS_TAG;
      styleTag.textContent = CSS;
      document.head.appendChild(styleTag);
    }

    /** Class map, kept beside the stylesheet so the two cannot drift. */
    var C = {
      card: "ltmg_card",
      cardOpen: "ltmg_cardOpen",
      header: "ltmg_header",
      headText: "ltmg_headText",
      name: "ltmg_name",
      description: "ltmg_description",
      chevron: "ltmg_chevron",
      chevronOpen: "ltmg_chevronOpen",
      body: "ltmg_body",
      readOnly: "ltmg_readOnly",
      pending: "ltmg_pending",
      footer: "ltmg_footer",
      failed: "ltmg_failed",
      discard: "ltmg_discard",
      save: "ltmg_save",
      field: "ltmg_field",
      head: "ltmg_head",
      label: "ltmg_label",
      badges: "ltmg_badges",
      badge: "ltmg_badge",
      reset: "ltmg_reset",
      input: "ltmg_input",
      inputInvalid: "ltmg_inputInvalid",
      textarea: "ltmg_textarea",
      invalid: "ltmg_invalid",
      hint: "ltmg_hint",
      toggle: "ltmg_toggle",
      checkbox: "ltmg_checkbox"
    };

    /** Every field the gate card edits, in render order. */
    var GATE_FIELDS = [
      {
        key: "prompt",
        kind: "select",
        label: "Memory rules prompt",
        hint: "How the mandatory memory rules reach the system prompt.",
        options: [
          ["full", "full - always present"],
          ["gate", "gate - hidden once the session has recalled"],
          ["off", "off - never present"]
        ]
      },
      {
        key: "promptTemplate",
        kind: "textarea",
        label: "Custom memory rules (system prompt)",
        placeholder: "Leave blank to use the built-in policy.",
        hint: "Replaces the built-in policy text. Placeholders: {project}, {server}, {tools}.",
        rows: 8
      },
      {
        key: "serverName",
        kind: "text",
        label: "MCP server name",
        placeholder: "ltm",
        hint: "Memory tools are addressed as mcp__<serverName>__<tool>."
      },
      {
        key: "project",
        kind: "text",
        label: "Project tag",
        placeholder: "derived from the session working directory",
        hint: "Sent to recall tools as current_project."
      },
      {
        key: "recallTools",
        kind: "list",
        label: "Recall tools",
        placeholder: "get_recent_memories",
        hint: "Comma-separated MCP tool names without the mcp__ prefix. A successful call to any one of them opens the gate."
      },
      {
        key: "allowTools",
        kind: "list",
        label: "Tools allowed while the gate is closed",
        placeholder: "todo_write, ask_user_question",
        hint: "Comma-separated tool names that may still run before the recall happens."
      },
      {
        key: "openAfterFailedRecalls",
        kind: "number",
        label: "Fail open after N failed recalls",
        hint: "Consecutive failed recall calls before the gate opens, so a dead memory server cannot brick the agent."
      },
      {
        key: "storeOnCompact",
        kind: "boolean",
        label: "Store compactions as memories",
        toggle: "Enabled",
        hint: "When the harness compacts the session, store the summary verbatim as a project memory."
      },
      {
        key: "rememberTool",
        kind: "text",
        label: "Compaction tool",
        placeholder: "remember",
        hint: "Raw MCP tool name the direct compaction call uses. Blank uses remember."
      }
    ];

    /**
     * The MCP connection card: the `mcp-ltm` loader entry the gate's memory
     * tools come from. Field names are flat; the host nests reconnect.* again
     * when it projects a saved value back onto the entry.
     *
     * `when` hides the rows that do not apply to the selected transport, using
     * the staged draft when there is one so switching transport updates the form
     * before anything is saved.
     */
    var MCP_FIELDS = [
      {
        key: "transport",
        kind: "select",
        label: "Transport",
        hint: "How the host reaches the memory server.",
        options: [
          ["streamable-http", "streamable-http - URL and headers"],
          ["stdio", "stdio - spawn a command"]
        ]
      },
      {
        key: "serverName",
        kind: "text",
        label: "MCP server name",
        placeholder: "ltm",
        hint: "Must match the LTM gate's MCP server name, or the gate's tool names stop resolving."
      },
      {
        key: "url",
        kind: "text",
        label: "Endpoint URL",
        placeholder: "http://127.0.0.1:8000/mcp",
        hint: "Streamable-HTTP endpoint of the memory server.",
        when: function (value) { return value.transport !== "stdio"; }
      },
      {
        key: "headers",
        kind: "dict",
        label: "HTTP headers",
        placeholder: "Authorization: Bearer ...",
        rows: 3,
        hint: "One Name: value per line, sent on every request.",
        when: function (value) { return value.transport !== "stdio"; }
      },
      {
        key: "command",
        kind: "text",
        label: "Command",
        placeholder: "python",
        hint: "Executable a stdio server is spawned from.",
        when: function (value) { return value.transport === "stdio"; }
      },
      {
        key: "args",
        kind: "list",
        label: "Arguments",
        placeholder: "-m, long_term_memory_mcp",
        hint: "Comma-separated arguments for the command.",
        when: function (value) { return value.transport === "stdio"; }
      },
      {
        key: "env",
        kind: "dict",
        label: "Environment",
        placeholder: "LTM_DB_PATH: /data/memories.db",
        rows: 3,
        hint: "One NAME: value per line, added to the spawned server's environment.",
        when: function (value) { return value.transport === "stdio"; }
      },
      {
        key: "cwd",
        kind: "text",
        label: "Working directory",
        placeholder: "the host's working directory",
        hint: "Working directory for a stdio server.",
        when: function (value) { return value.transport === "stdio"; }
      },
      {
        key: "toolCallTimeoutMs",
        kind: "number",
        label: "Tool call timeout (ms)",
        hint: "Per-call timeout. Blank leaves the bridge default of 60000."
      },
      {
        key: "failOnStartupError",
        kind: "boolean",
        label: "Fail boot when the first connection fails",
        toggle: "Enabled",
        hint: "Off: the host boots and the bridge keeps retrying in the background."
      },
      {
        key: "reconnectEnabled",
        kind: "boolean",
        label: "Reconnect after a lost connection",
        toggle: "Enabled",
        hint: "Off: registered tools stay dead until the plugin or host reloads."
      },
      {
        key: "reconnectInitialDelayMs",
        kind: "number",
        label: "First reconnect delay (ms)",
        hint: "Backoff starts here and doubles per attempt."
      },
      {
        key: "reconnectMaxDelayMs",
        kind: "number",
        label: "Reconnect delay ceiling (ms)",
        hint: "Backoff never grows past this."
      },
      {
        key: "reconnectMaxAttempts",
        kind: "number",
        label: "Reconnect attempts before giving up",
        hint: "Consecutive failures before the bridge unregisters its tools."
      }
    ];

    /** A field list plus its key index; one set per card. */
    function fieldSet(fields) {
      var byKey = {};
      for (var n = 0; n < fields.length; n++) byKey[fields[n].key] = fields[n];
      return { fields: fields, byKey: byKey };
    }
    var GATE_SET = fieldSet(GATE_FIELDS);
    var MCP_SET = fieldSet(MCP_FIELDS);

    /** Sentinel standing for "clear this field so it re-inherits the default". */
    var UNSET = { unset: true };

    /** Minimal snapshot store; the slot runtime wraps it into a React hook. */
    function createStore(initial) {
      var state = initial;
      var listeners = new Set();
      return {
        getSnapshot: function () { return state; },
        subscribe: function (listener) {
          listeners.add(listener);
          return function () { listeners.delete(listener); };
        },
        set: function (next) {
          state = next;
          Array.from(listeners).forEach(function (listener) { listener(); });
        }
      };
    }

    /** Render one stored value into the text (or boolean) the control stages. */
    function toDraft(field, value) {
      if (value === undefined || value === null) return field.kind === "boolean" ? false : "";
      if (field.kind === "boolean") return value === true;
      if (field.kind === "list") return Array.isArray(value) ? value.join(", ") : String(value);
      if (field.kind === "dict") {
        if (typeof value !== "object" || value === null || Array.isArray(value)) return "";
        var lines = [];
        for (var key in value) {
          if (Object.prototype.hasOwnProperty.call(value, key)) lines.push(key + ": " + value[key]);
        }
        return lines.join(NL);
      }
      return String(value);
    }

    /** Turn one staged draft into a write value, or the reason it cannot be written. */
    function parse(field, draft) {
      if (field.kind === "boolean") return { ok: true, value: draft === true };
      var text = String(draft === undefined || draft === null ? "" : draft).trim();
      if (field.kind === "number") {
        if (text === "") return { ok: true, value: UNSET };
        var n = Number(text);
        if (!isFinite(n) || Math.floor(n) !== n || n < 1) {
          return { ok: false, message: "Enter a whole number of 1 or more." };
        }
        return { ok: true, value: n };
      }
      if (field.kind === "list") {
        var parts = text === "" ? [] : text.split(NL).join(",").split(",");
        var list = [];
        var j;
        for (j = 0; j < parts.length; j++) {
          var item = parts[j].trim();
          if (item !== "") list.push(item);
        }
        if (field.key === "recallTools" && list.length === 0) {
          return { ok: false, message: "Name at least one recall tool." };
        }
        return { ok: true, value: list };
      }
      if (field.kind === "select") {
        var k;
        for (k = 0; k < field.options.length; k++) {
          if (field.options[k][0] === text) return { ok: true, value: text };
        }
        return { ok: false, message: "Choose one of the listed modes." };
      }
      if (field.kind === "dict") {
        if (text === "") return { ok: true, value: UNSET };
        var entries = text.split(NL);
        var dict = {};
        for (var d = 0; d < entries.length; d++) {
          var line = entries[d].trim();
          if (line === "") continue;
          var at = line.indexOf(":");
          if (at <= 0) return { ok: false, message: "Use one Name: value per line." };
          dict[line.slice(0, at).trim()] = line.slice(at + 1).trim();
        }
        return { ok: true, value: dict };
      }
      if (text === "") return { ok: true, value: UNSET };
      if (field.key === "serverName" && !/^[A-Za-z0-9_-]{1,32}$/.test(text)) {
        return { ok: false, message: "Use 1-32 letters, digits, underscores or dashes." };
      }
      return { ok: true, value: text };
    }

    /**
     * Staged editor over the bound namespace scope.
     *
     * Writes go one field at a time through the scope, which fences each with the
     * namespace revision it read; the Host stays the only authority on whether a
     * value was accepted, so a rejected write keeps its draft and flips the
     * failure notice instead of pretending the save landed.
     */
    function createController(scope, fields, byKey) {
      var drafts = {};
      var touched = {};
      var invalid = {};
      var expanded = false;
      var saving = false;
      var failure = false;
      var store = createStore(null);

      /** Staged-or-composed value per field, used to decide row visibility. */
      function effectiveValues() {
        var s = scope.getSnapshot();
        var value = s.status === "ready" && s.value && typeof s.value === "object" ? s.value : undefined;
        var out = {};
        for (var n = 0; n < fields.length; n++) {
          var key = fields[n].key;
          out[key] = Object.prototype.hasOwnProperty.call(touched, key)
            ? drafts[key]
            : (value === undefined ? undefined : value[key]);
        }
        return out;
      }

      function snapshot() {
        var s = scope.getSnapshot();
        var ready = s.status === "ready" && s.value && typeof s.value === "object";
        var value = ready ? s.value : undefined;
        var user = s.user && typeof s.user === "object" ? s.user : {};
        var effective = effectiveValues();
        var rows = [];
        var dirty = false;
        for (var n = 0; n < fields.length; n++) {
          var f = fields[n];
          if (f.when !== undefined && !f.when(effective)) continue;
          var staged = Object.prototype.hasOwnProperty.call(touched, f.key);
          if (staged) dirty = true;
          rows.push({
            key: f.key,
            kind: f.kind,
            label: f.label,
            hint: f.hint,
            placeholder: f.placeholder,
            toggle: f.toggle,
            rows: f.rows,
            options: f.options,
            draft: staged ? drafts[f.key] : toDraft(f, value === undefined ? undefined : value[f.key]),
            overridden: Object.prototype.hasOwnProperty.call(user, f.key),
            invalid: invalid[f.key]
          });
        }
        return {
          available: ready,
          status: s.status,
          writable: s.writable === true,
          mode: s.mode,
          fields: rows,
          expanded: expanded,
          dirty: dirty,
          saving: saving,
          failure: failure
        };
      }

      function publish() { store.set(snapshot()); }

      var unsubscribe = scope.subscribe(function () { publish(); });

      function edit(key, draft) {
        drafts[key] = draft;
        touched[key] = true;
        delete invalid[key];
        failure = false;
        publish();
      }

      function discard() {
        drafts = {};
        touched = {};
        invalid = {};
        failure = false;
        publish();
      }

      function toggle() {
        expanded = !expanded;
        publish();
      }

      function resetField(key) {
        delete touched[key];
        delete drafts[key];
        delete invalid[key];
        failure = false;
        publish();
        return scope.unset(key).then(undefined, function () {
          failure = true;
          publish();
        });
      }

      function save() {
        var writes = [];
        var bad = {};
        var key;
        var effective = effectiveValues();
        for (key in touched) {
          if (!touched[key]) continue;
          var field = byKey[key];
          if (field === undefined) continue;
          // A row hidden by the transport chooser is not written: its draft is
          // dropped with the touch so the form stops claiming an edit.
          if (field.when !== undefined && !field.when(effective)) {
            delete touched[key];
            delete drafts[key];
            continue;
          }
          var parsed = parse(field, drafts[key]);
          if (!parsed.ok) { bad[key] = parsed.message; continue; }
          writes.push({ key: key, value: parsed.value });
        }
        invalid = bad;
        if (Object.keys(bad).length > 0) {
          publish();
          return Promise.resolve();
        }
        saving = true;
        failure = false;
        publish();
        var chain = Promise.resolve();
        writes.forEach(function (write) {
          chain = chain.then(function () {
            return write.value === UNSET ? scope.unset(write.key) : scope.set(write.key, write.value);
          }).then(function () {
            delete touched[write.key];
            delete drafts[write.key];
          }, function () {
            failure = true;
          });
        });
        return chain.then(function () {
          saving = false;
          publish();
        });
      }

      publish();

      return {
        store: store,
        publish: publish,
        dispose: unsubscribe,
        face: function (hookName) {
          var hooks = {};
          hooks[hookName] = store;
          return {
            hooks: hooks,
            save: save,
            discard: discard,
            toggle: toggle,
            edit: edit,
            resetField: resetField
          };
        }
      };
    }

    /** The 14px outline disclosure chevron the built-in cards use. */
    function chevron(open) {
      return h("svg", {
        className: open ? C.chevron + " " + C.chevronOpen : C.chevron,
        width: 14,
        height: 14,
        viewBox: "0 0 14 14",
        fill: "none",
        "aria-hidden": "true"
      }, h("path", {
        d: "M3.5 5.25L7 8.75L10.5 5.25",
        stroke: "currentColor",
        strokeWidth: 1.4,
        strokeLinecap: "round",
        strokeLinejoin: "round"
      }));
    }

    /** One labelled control: label row, control, then hint or the invalid reason. */
    function fieldRow(field, actions, disabled) {
      var id = "ltm-gate-" + field.key;
      var onText = function (event) { actions.edit(field.key, event.target.value); };
      var control;

      if (field.kind === "boolean") {
        control = h("label", { className: C.toggle, htmlFor: id },
          h("input", {
            id: id,
            className: C.checkbox,
            type: "checkbox",
            checked: field.draft === true,
            disabled: disabled,
            onChange: function (event) { actions.edit(field.key, event.target.checked); }
          }),
          h("span", null, field.toggle)
        );
      } else if (field.kind === "select") {
        control = h("select", {
          id: id,
          className: field.invalid ? C.input + " " + C.inputInvalid : C.input,
          value: field.draft,
          disabled: disabled,
          onChange: onText
        }, field.options.map(function (option) {
          return h("option", { key: option[0], value: option[0] }, option[1]);
        }));
      } else if (field.kind === "textarea" || field.kind === "dict") {
        control = h("textarea", {
          id: id,
          className: C.input + " " + C.textarea + (field.invalid ? " " + C.inputInvalid : ""),
          rows: field.rows,
          value: field.draft,
          placeholder: field.placeholder === undefined ? "" : field.placeholder,
          disabled: disabled,
          spellCheck: false,
          onChange: onText
        });
      } else {
        control = h("input", {
          id: id,
          className: field.invalid ? C.input + " " + C.inputInvalid : C.input,
          type: "text",
          inputMode: field.kind === "number" ? "numeric" : undefined,
          value: field.draft,
          placeholder: field.placeholder === undefined ? "" : field.placeholder,
          disabled: disabled,
          autoComplete: "off",
          onChange: onText
        });
      }

      return h("div", { key: field.key, className: C.field },
        h("div", { className: C.head },
          h("label", { className: C.label, htmlFor: id }, field.label),
          field.overridden
            ? h("span", { className: C.badges },
              h("span", { className: C.badge }, "Overridden"),
              h("button", {
                type: "button",
                className: C.reset,
                disabled: disabled,
                onClick: function () { actions.resetField(field.key); }
              }, "Reset to default")
            )
            : null
        ),
        control,
        h("p", { className: field.invalid ? C.invalid : C.hint },
          field.invalid ? field.invalid : field.hint)
      );
    }

    /**
     * Build the component a card slot dispatches for one namespace.
     *
     * Both cards are the same card: the slot runtime maps the spec's hook name
     * to the injected prop, and everything below reads only the snapshot the
     * controller publishes.
     * @param spec - namespace, hook name, header copy and field set.
     * @returns the card component.
     */
    function makeCard(spec) {
      return function Card(props) {
        var state = props[spec.prop](function (value) { return value; });
        if (!state || !state.available) return null;
        var actions = { edit: props.edit, resetField: props.resetField };
        var disabled = !state.writable;
        var open = state.expanded;

        return h("li", { className: open ? C.card + " " + C.cardOpen : C.card, "data-plugin": spec.ns },
          h("button", {
            type: "button",
            className: C.header,
            "aria-expanded": open,
            "aria-label": (open ? "Hide settings" : "Show settings") + ": " + spec.name,
            onClick: props.toggle
          },
            h("span", { className: C.headText },
              h("span", { className: C.name }, spec.name),
              h("span", { className: C.description }, spec.description)
            ),
            state.dirty ? h("span", { className: C.pending }, "Unsaved") : null,
            chevron(open)
          ),
          open
            ? h("div", { className: C.body },
              !state.writable
                ? h("p", { className: C.readOnly, role: "status" }, "This deployment stores settings read-only; changes will not persist.")
                : null,
              state.fields.map(function (field) { return fieldRow(field, actions, disabled); }),
              h("div", { className: C.footer },
                state.failure
                  ? h("p", { className: C.failed, role: "status" }, "The deployment did not accept these values; they were left here for you to correct.")
                  : null,
                h("button", {
                  type: "button",
                  className: C.discard,
                  disabled: !state.dirty || state.saving,
                  onClick: props.discard
                }, "Discard"),
                h("button", {
                  type: "button",
                  className: C.save,
                  disabled: !state.dirty || state.saving || disabled,
                  onClick: props.save
                }, state.saving ? "Saving..." : "Save")
              )
            )
            : null
        );
      };
    }

    /** The two cards this bundle dispatches, one per served namespace. */
    var GATE_CARD = {
      ns: NS,
      hook: "ltmGateCard",
      prop: "useLtmGateCard",
      name: "LTM gate",
      description: "Blocks every non-memory tool call until the session recalls from long-term memory.",
      set: GATE_SET
    };
    var MCP_CARD = {
      ns: MCP_NS,
      hook: "ltmMcpCard",
      prop: "useLtmMcpCard",
      name: "LTM MCP server",
      description: "The mcp-ltm loader entry the gate's memory tools come from: transport, endpoint, headers and reconnect policy.",
      set: MCP_SET
    };
    var GATE_COMPONENT = makeCard(GATE_CARD);
    var MCP_COMPONENT = makeCard(MCP_CARD);

    /** Services this browser half needs: the slot ledger and the settings transport. */
    var inject = ["slots", "settingsScope"];

    /**
     * Bind one namespace scope and claim that namespace's card slot key.
     * @param ctx - the browser plugin context.
     * @param spec - the card spec (namespace, hook name, copy, field set).
     * @param Component - the component the slot dispatches for this key.
     */
    function mount(ctx, spec, Component) {
      var scope = ctx.settingsScope.bind({ namespace: spec.ns });
      var controller = createController(scope, spec.set.fields, spec.set.byKey);
      if (typeof ctx.effect === "function") {
        ctx.effect(function () {
          return function () { controller.dispose(); };
        }, "dsh-ltm-gate: " + spec.ns + " card controller");
      }
      ctx.slots.inject("settings.plugin.item", function () {
        return ctx.slots.register({
          name: "settings.plugin.item",
          key: spec.ns,
          inject: function () { return controller.face(spec.hook); }
        }, Component);
      });
    }

    /** @param ctx - the browser plugin context. */
    function apply(ctx) {
      mount(ctx, GATE_CARD, GATE_COMPONENT);
      mount(ctx, MCP_CARD, MCP_COMPONENT);
    }

    return { apply: apply, inject: inject };
  }
});
