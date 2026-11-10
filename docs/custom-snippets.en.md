# Custom snippets and Obsidian migration

[简体中文](custom-snippets.md) · [Quick start](../README.en.md)

## Choose a snippet source

Open **LaTeX Suite** settings and find **Snippet library source** under **Snippets**.

- **Built-in editor** uses the code editor in settings. Add entries to its array or replace the whole array. Copy your custom snippets before resetting to defaults.
- **Single file** uses a vault-relative path such as `LaTeX/snippets.js`. The file contains one snippet array.
- **Folder** combines the arrays from `.js` and `.json` snippet files in a vault folder and its subfolders. Configure your variables file separately and keep it outside that folder.

Your built-in editor text is kept when you switch to an external source. **Guide & practice** shows which file changes the host can detect automatically. You can also select **Reload snippets** to refresh manually. If the **Snippets** tab reports a path, read, or parse error, fix it and reload.

- When both snippets and variables are configured in the plugin, it can recover the last saved working configuration after a restart and keep the current text available for editing.
- When snippets or variables come from external files, a failed reload keeps the last working library from the current session. After a restart, the plugin reads the external files again from the current vault.

## Write snippets

A snippet library can be a JSON array or a JavaScript array expression. The JavaScript form allows regex literals, comments, and functions. Load JavaScript snippets only from sources you trust, since the plugin executes their code.

```js
[
  {trigger: "@a", replacement: "\\alpha", options: "mA"},
  {trigger: "ff", replacement: "\\frac{$0}{$1}$2", options: "m"},
  {
    trigger: /([A-Za-z])(\d)/,
    replacement: "[[0]]_{[[1]]}",
    options: "mA",
    excludedMacros: ["ce", "pu"],
  },
  {trigger: "U", replacement: "\\underbrace{${VISUAL}}_{$0}", options: "mAv"},
]
```

You can use this example as a small library. Type `@a` for `\alpha`, or type `ff` and press the manual trigger key for a fraction. In an equation, select some text and type `U` to put an underbrace below the selection.

| Option | Meaning |
| --- | --- |
| `m`, `n`, `M` | Math, inline math only, and block math only, respectively. |
| `t` | Prose and text inside an equation, such as `\text{…}`. Automatic expansion in either place requires **Automatic text snippets**. |
| `A` | Expand as soon as you finish typing the trigger. Omit it to use the configured manual trigger key. |
| `r` | Treat a string trigger as a regular expression. A regex literal implies this option. |
| `w` | Require a word boundary on both sides of the trigger. Configure word delimiters under **Advanced**. |
| `v` | Apply to a selection. Use a single-character trigger for automatic visual snippets. `${VISUAL}` represents the selected text and implies `v` when it appears in a replacement string. |

In JavaScript strings, write each LaTeX backslash as `\\`. Tabstops such as `$0` and `$1` are visited in numeric order, and `${0:x}` fills the first tabstop with `x`. `[[0]]` and `[[1]]` refer to the first and second regex capture groups. Replacement functions can return a string or return `false` to skip the match.

If triggers overlap, higher `priority` runs first, then longer triggers. Use `description` to explain a snippet. Use `excludedMacros: ["ce", "pu"]` to skip arguments of those macros, or `excludedEnvironments: ["align"]` to skip a named environment.

Literal and regex snippets can use `triggerAfter` to match and replace text immediately to the right of the cursor. For example, `trigger: "qq", triggerAfter: "?"` requires a `?` immediately after `qq` and replaces both. For regex snippets, `triggerAfter` is also a regex pattern, and capture placeholders refer to the left-hand trigger. Visual snippets do not accept this field.

## Set snippet variables

Under **Advanced**, edit the JSON object in **Snippet variables**, or configure a vault-relative variables file. Keys include `${…}` and values are strings. For example, add `"${VECTOR_AXIS}": "(?:x|y|z)"` and use `"(${VECTOR_AXIS})vv"` as a regex trigger. The built-in variables include `${GREEK}`, `${SYMBOL}`, `${MORE_SYMBOLS}`, and `${ACCENT}`. Custom values override defaults with the same name.

## Migrate from Obsidian

1. Copy your snippet array. If it is embedded in a Markdown fence, a module export, or a larger script, extract it into a single array expression. Copy your variables as a JSON object.
2. Paste the array into the built-in editor, or save it in a vault file and select that source. Set your manual trigger key and display preferences.
3. Check the syntax differences below, then try your most-used triggers under **Guide & practice**. If you rely on `mk` or `dm`, enable **Automatic text snippets**.

| Upstream feature | Behavior in Forsion |
| --- | --- |
| Per-snippet `triggerKey` | Remove this field. Manual snippets share the configured **Tab** or **Space** key. |
| `c`, `C`, code language filters, and `math` code fences | Code blocks and inline code are treated as literal text. Equation editing uses paired dollar delimiters. |
| `T` for text macros and `includedMacros` | These options are unsupported. `t` covers prose and text inside equations, and `excludedMacros` excludes macro arguments. |
| `U` undo flag | You can keep it in imported snippets. Undo uses the Forsion editor's history. To immediately restore the full trigger of an automatic expansion, use **Backspace** or the restore trigger command. |
| Functions returning LuaSnip-style nodes | Return a string with tabstops, or return `false` to skip the match. |
| Vim shortcuts and multiple cursors for tabstops | Use the Forsion shortcuts. Matching tabstops mirror their text with a single cursor. |
| Math across paragraphs and revealing individual LaTeX constructs | Keep multiline block math within one text block. With conceal enabled, entering an equation reveals its whole source. |

See [Obsidian LaTeX Suite 1.12.8 documentation](https://github.com/artisticat1/obsidian-latex-suite/blob/8498f43/DOCS.md) for the upstream syntax.
