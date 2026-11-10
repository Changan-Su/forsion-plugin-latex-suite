# Shortcuts and troubleshooting

[简体中文](shortcuts.md) · [Quick start](../README.en.md)

## Write equations

| Action | How to use it |
| --- | --- |
| Start an equation | Run **Insert inline math** or **Insert block math** in the command palette. To wrap existing text, select it within one text block before running the command. |
| Expand automatically | Type the trigger inside paired math delimiters. Use `@a` for `\alpha`, `sq` for a square root, or `sr` for a squared exponent. |
| Expand manually | Type a manual trigger and press **Tab**. For example, type `\sum` and press **Tab** to add limits. You can change the manual trigger key to **Space**. |
| Fill in tabstops | Press **Tab** to go forward, **Shift+Tab** to go back, or **Esc** to finish. Tabstops with the same number update together, as in the opening and closing names of an environment. |
| Enter a fraction | Type `//` in an empty equation and fill in the numerator and denominator. If you have a numerator already, type `/`. For example, `(a+b)/` becomes `\frac{a+b}{}` with the cursor in the denominator. |
| Enter a matrix or alignment | Type `pmat` in block math. In the matrix, **Tab** inserts the column separator `&`, **Enter** inserts the LaTeX row separator `\\`, and **Shift+Enter** jumps past the end of the environment. The same shortcuts apply in configured environments such as `cases` and `align`. |
| Jump past brackets or math | Press **Tab** to jump past a closing bracket or math delimiter. If a paired closing bracket is immediately to the right, typing that bracket also moves past it. |
| Select or box an equation | Place the cursor inside and run **Select current equation** or **Box current equation**. Selection leaves out the delimiters, and boxing wraps the contents in `\boxed{…}`. |

By default, **Tab** tries manual expansion, tabstop navigation, matrix shortcuts, and tabout in that order. If none applies, the note handles **Tab**, for example to indent a list item. With **Space** as the manual trigger key, **Tab** starts with tabstop navigation.

Block math can span lines within one text block. Outside matrix shortcut environments, use **Shift+Enter** for a newline in the source. In a matrix, **Enter** inserts `\\` to separate typeset rows. Delimiters in separate paragraphs do not form an equation.

## Troubleshooting

**A trigger stays as typed.** Use an insert command to create paired delimiters, then type `@a` one character at a time between them. Check that the plugin is enabled and automatic expansion is active. A lone opening `$`, an escaped `\$`, and dollar signs in code do not open math. Keep leading and trailing spaces outside inline delimiters. Pasting and IME composition do not trigger automatic expansion. For a custom snippet, check its library, mode, and trigger key.

**Typing `mk` or `dm` in prose leaves it as text.** Use the insert commands in the command palette. If you prefer automatic text snippets, enable **Automatic text snippets** under **Snippets** in the plugin settings. This also controls automatic snippets inside text macros such as `\text{…}`. Manual prose snippets still use your chosen trigger key.

**I want to pause automatic expansion.** Run **Pause LaTeX automatic expansion** from the command palette. Run **Resume LaTeX automatic expansion** when ready. Pausing stops automatic snippets, automatic fractions, and jumping out by typing a closing bracket. Manual snippets and active tabstops remain available.

**A snippet just expanded unexpectedly.** Before typing further or moving the cursor, press **Backspace** or run **Restore the last LaTeX trigger**. This brings back the full trigger you typed, including its final character.

**Tab went somewhere unexpected.** Check for active tabstops or an environment with matrix shortcuts. Press **Esc** to end tabstop navigation. To allow jumping out from the middle of an equation, check **Exit equation only at end of line** under **Tabout**.

**The equation shows its source.** Check the delimiters and LaTeX syntax first. Forsion provides equation previews by default. On hosts without native previews, you can enable conceal in the plugin's display settings. Some commands then display as symbols when the cursor is outside the equation. Move the cursor back in to edit the source.

**My external file changed, but the snippets did not.** Run **Reload LaTeX snippets**, then check the path and error messages in the plugin settings. If the configuration fails to load, the plugin keeps using the last valid library from the current session. See [custom snippets and migration](custom-snippets.en.md) for file and folder rules.
