"use strict";
// dsh-ltm-gate - browser half.
//
// Registers ONE card into Settings > Plugins > Plugin configuration, keyed on
// the `ltm-gate` settings namespace the host half registers. The pair is what
// makes the panel appear: the Host serves the namespace, this bundle claims it,
// and the Plugins section dispatches the card by that key. Without this half
// the namespace is served and simply renders nothing.
//
// Bundle format: the client module system's lazy-CJS factory. Running this file
// only REGISTERS the factory; the module body - React surface creation
// included - runs at materialization (first import of "dsh-ltm-gate").
//
// Deliberately dependency-free beyond React: the card owns its own staging and
// revision fencing rather than importing another plugin's form model, which the
// client bundle-purity gate forbids anyway.

window.__ModuleLoader__.load({
  id: "dsh-ltm-gate",
  factory: function (require) {
    "use strict";

    var React = require("react");
    var h = React.createElement;
    var NL = String.fromCharCode(10);

    /** Settings namespace owned by the Host half. */
    var NS = "ltm-gate";

    /** Every field the panel edits, in render order. */
    var FIELDS = [
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
        hint: "Replaces the built-in policy text. Placeholders: {project}, {server}, {tools}. Leave blank to use the built-in rules."
      },
      {
        key: "serverName",
        kind: "text",
        label: "MCP server name",
        hint: "Memory tools are addressed as mcp__<serverName>__<tool>."
      },
      {
        key: "project",
        kind: "text",
        label: "Project tag",
        hint: "Sent to recall tools as current_project. Blank derives it from the session working directory."
      },
      {
        key: "recallTools",
        kind: "list",
        label: "Recall tools",
        hint: "Comma-separated MCP tool names without the mcp__ prefix. A successful call to any one of them opens the gate."
      },
      {
        key: "allowTools",
        kind: "list",
        label: "Tools allowed while the gate is closed",
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
        hint: "When the harness compacts the session, store the summary verbatim as a project memory."
      }
    ];

    var BY_KEY = {};
    var i;
    for (i = 0; i < FIELDS.length; i++) BY_KEY[FIELDS[i].key] = FIELDS[i];

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
    function createController(scope) {
      var drafts = {};
      var touched = {};
      var invalid = {};
      var expanded = false;
      var saving = false;
      var failure = false;
      var store = createStore(null);

      function snapshot() {
        var s = scope.getSnapshot();
        var value = s.status === "ready" && s.value && typeof s.value === "object" ? s.value : undefined;
        var user = s.user && typeof s.user === "object" ? s.user : {};
        var fields = [];
        var dirty = false;
        var key;
        for (var n = 0; n < FIELDS.length; n++) {
          var f = FIELDS[n];
          var staged = Object.prototype.hasOwnProperty.call(touched, f.key);
          if (staged) dirty = true;
          fields.push({
            key: f.key,
            kind: f.kind,
            label: f.label,
            hint: f.hint,
            options: f.options,
            draft: staged ? drafts[f.key] : toDraft(f, value === undefined ? undefined : value[f.key]),
            overridden: Object.prototype.hasOwnProperty.call(user, f.key),
            invalid: invalid[f.key]
          });
        }
        return {
          status: s.status,
          writable: s.writable === true,
          mode: s.mode,
          fields: fields,
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
        for (key in touched) {
          if (!touched[key]) continue;
          var parsed = parse(BY_KEY[key], drafts[key]);
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

      // Publish the first snapshot before anyone can render: the card is
      // dispatched from the namespace ledger, and a null first snapshot would
      // render an empty list item.
      publish();

      return {
        store: store,
        publish: publish,
        dispose: unsubscribe,
        face: function () {
          return {
            hooks: { ltmGateCard: store },
            save: save,
            discard: discard,
            toggle: toggle,
            edit: edit,
            resetField: resetField
          };
        }
      };
    }

    var cardStyle = {
      border: "1px solid var(--dsw-alias-border-l2)",
      background: "var(--dsw-alias-bg-layer-3)",
      borderRadius: "10px",
      overflow: "hidden",
      minWidth: 0
    };
    var headStyle = {
      boxSizing: "border-box",
      width: "100%",
      display: "flex",
      justifyContent: "space-between",
      alignItems: "center",
      gap: "12px",
      padding: "12px 14px",
      background: "transparent",
      border: 0,
      color: "inherit",
      font: "inherit",
      textAlign: "left",
      cursor: "pointer"
    };
    var titleStyle = { display: "block", fontSize: "14px", fontWeight: 600, lineHeight: "20px" };
    var descStyle = { display: "block", marginTop: "2px", color: "var(--dsw-alias-label-tertiary)", fontSize: "12px", lineHeight: "18px" };
    var metaRowStyle = { display: "flex", alignItems: "center", gap: "8px", flexShrink: 0 };
    var bodyStyle = {
      borderTop: "1px solid var(--dsw-alias-border-l2)",
      padding: "12px 14px 14px",
      display: "flex",
      flexDirection: "column",
      gap: "12px"
    };
    var rowStyle = { display: "flex", flexDirection: "column", gap: "5px" };
    var labelRowStyle = { display: "flex", alignItems: "center", gap: "8px" };
    var labelStyle = { fontSize: "13px", fontWeight: 500 };
    var hintStyle = {
      margin: 0,
      color: "var(--dsw-alias-label-tertiary)",
      fontSize: "12px",
      lineHeight: "17px"
    };
    var inputStyle = {
      boxSizing: "border-box",
      width: "100%",
      padding: "6px 9px",
      borderRadius: "8px",
      border: "1px solid var(--dsw-alias-border-l2)",
      background: "var(--dsw-alias-bg-layer-1)",
      color: "inherit",
      font: "inherit",
      fontSize: "13px"
    };
    var checkboxRowStyle = { display: "flex", alignItems: "center", gap: "8px" };
    var badgeStyle = {
      border: "1px solid var(--dsw-alias-border-l2)",
      borderRadius: "999px",
      padding: "1px 8px",
      color: "var(--dsw-alias-label-tertiary)",
      fontSize: "11px",
      lineHeight: "16px",
      whiteSpace: "nowrap"
    };
    var resetStyle = {
      border: 0,
      background: "transparent",
      color: "var(--dsw-alias-state-business-primary)",
      font: "inherit",
      fontSize: "11px",
      cursor: "pointer",
      padding: 0,
      whiteSpace: "nowrap"
    };
    var actionsRowStyle = { display: "flex", alignItems: "center", gap: "8px" };
    var buttonStyle = {
      border: "1px solid var(--dsw-alias-border-l2)",
      borderRadius: "8px",
      background: "transparent",
      color: "inherit",
      font: "inherit",
      fontSize: "13px",
      padding: "5px 12px",
      cursor: "pointer"
    };
    var failureStyle = {
      margin: 0,
      color: "var(--dsw-alias-state-error-primary)",
      fontSize: "12px",
      lineHeight: "17px"
    };

    function control(field, state, actions) {
      var disabled = !state.writable;
      var id = "ltm-gate-" + field.key;
      var onText = function (event) { actions.edit(field.key, event.target.value); };
      if (field.kind === "boolean") {
        return h("div", { style: checkboxRowStyle },
          h("input", {
            id: id,
            type: "checkbox",
            checked: field.draft === true,
            disabled: disabled,
            onChange: function (event) { actions.edit(field.key, event.target.checked); }
          }),
          h("label", { htmlFor: id, style: { fontSize: "13px" } }, field.label)
        );
      }
      if (field.kind === "select") {
        return h("select", {
          id: id,
          style: inputStyle,
          value: field.draft,
          disabled: disabled,
          onChange: onText
        }, field.options.map(function (option) {
          return h("option", { key: option[0], value: option[0] }, option[1]);
        }));
      }
      if (field.kind === "textarea") {
        return h("textarea", {
          id: id,
          style: Object.assign({}, inputStyle, { minHeight: "132px", resize: "vertical", fontFamily: "inherit" }),
          value: field.draft,
          disabled: disabled,
          spellCheck: false,
          onChange: onText
        });
      }
      return h("input", {
        id: id,
        type: field.kind === "number" ? "number" : "text",
        min: field.kind === "number" ? 1 : undefined,
        style: inputStyle,
        value: field.draft,
        disabled: disabled,
        autoComplete: "off",
        onChange: onText
      });
    }

    /** The card the Plugins section dispatches for the ltm-gate namespace. */
    function LtmGateCard(props) {
      var state = props.useLtmGateCard(function (value) { return value; });
      if (!state) return null;
      var actions = { edit: props.edit };
      var disabled = !state.writable;

      var rows = state.fields.map(function (field) {
        if (field.kind === "boolean") {
          return h("div", { key: field.key, style: rowStyle },
            control(field, state, actions),
            h("p", { style: hintStyle }, field.hint),
            field.invalid ? h("p", { style: failureStyle }, field.invalid) : null
          );
        }
        return h("div", { key: field.key, style: rowStyle },
          h("div", { style: labelRowStyle },
            h("label", { htmlFor: "ltm-gate-" + field.key, style: labelStyle }, field.label),
            field.overridden && field.key !== "prompt" ? h("span", { style: badgeStyle }, "Overridden") : null,
            field.overridden && field.key !== "prompt"
              ? h("button", {
                type: "button",
                style: resetStyle,
                disabled: disabled,
                onClick: function () { props.resetField(field.key); }
              }, "Reset to default")
              : null
          ),
          control(field, state, actions),
          h("p", { style: hintStyle }, field.hint),
          field.invalid ? h("p", { style: failureStyle }, field.invalid) : null
        );
      });

      return h("li", { style: cardStyle, "data-plugin": NS },
        h("button", {
          type: "button",
          style: headStyle,
          "aria-expanded": state.expanded,
          onClick: props.toggle
        },
          h("span", null,
            h("span", { style: titleStyle }, "LTM gate"),
            h("span", { style: descStyle }, "Blocks every non-memory tool call until the session recalls from long-term memory.")
          ),
          h("span", { style: metaRowStyle },
            state.dirty ? h("span", { style: badgeStyle }, "Unsaved") : null,
            state.saving ? h("span", { style: badgeStyle }, "Saving...") : null,
            h("span", { style: hintStyle }, state.expanded ? "Hide settings" : "Show settings")
          )
        ),
        state.expanded
          ? h("div", { style: bodyStyle },
            state.status === "unavailable"
              ? h("p", { style: hintStyle }, "This deployment does not expose the ltm-gate settings namespace.")
              : null,
            state.status === "ready" && !state.writable
              ? h("p", { style: hintStyle }, "This deployment stores settings read-only; changes will not persist.")
              : null,
            rows,
            h("div", { style: actionsRowStyle },
              h("button", {
                type: "button",
                style: buttonStyle,
                disabled: disabled || !state.dirty || state.saving,
                onClick: props.save
              }, state.saving ? "Saving..." : "Save"),
              h("button", {
                type: "button",
                style: buttonStyle,
                disabled: !state.dirty || state.saving,
                onClick: props.discard
              }, "Discard")
            ),
            state.failure
              ? h("p", { style: failureStyle }, "The deployment did not accept these values; they were left here for you to correct.")
              : null
          )
          : null
      );
    }

    /** Services this browser half needs: the slot ledger and the settings transport. */
    var inject = ["slots", "settingsScope"];

    /**
     * Bind the namespace scope and claim the card's slot key.
     * @param ctx - the browser plugin context.
     */
    function apply(ctx) {
      var scope = ctx.settingsScope.bind({ namespace: NS });
      var controller = createController(scope);
      if (typeof ctx.effect === "function") {
        ctx.effect(function () {
          return function () { controller.dispose(); };
        }, "ltm-gate: card controller");
      }
      ctx.slots.inject("settings.plugin.item", function () {
        return ctx.slots.register({
          name: "settings.plugin.item",
          key: NS,
          inject: function () { return controller.face(); }
        }, LtmGateCard);
      });
    }

    return { apply: apply, inject: inject };
  }
});
