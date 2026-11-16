# Changelog

[简体中文](../CHANGELOG.md)

## Unreleased

- Placeholder navigation now matches Latex Suite in Obsidian. After the inner snippet of a nested expansion, Tab moves to the next outer placeholder instead of selecting the whole outer content. If you move to a later placeholder with the mouse or arrow keys, Tab continues from there. Navigation ends at the last placeholder, which is no longer highlighted or extended by further typing.
- After snippets with a single placeholder, such as `mk` and `dm`, the first Tab is no longer consumed by placeholder navigation. Shift+Tab on the first placeholder no longer ends navigation, and the placeholders remain.
- The placeholder after a fraction is no longer lost when typing `//` inside brackets enlarges them. Fractions created with `/` inside math now also let Tab move from the denominator to after the fraction.
- Brackets in math now use the same colors as Latex Suite in Obsidian. Paired brackets cycle through three colors by nesting depth, and unmatched brackets turn red. Command brackets such as `\{ \}`, `\left( \right)` and `\langle \rangle` are paired too. The innermost pair around the cursor gets a background instead of an outline.
- Placeholder markers use the upstream style: an empty placeholder is a thin dotted line, and filled placeholders cycle through blue, orange and green backgrounds.
- New math delimiter highlighting, on by default. Matched `$` and `$$` turn green; an unclosed `$$` or a stray `$` inside display math turns red. Turn it off under Display settings.
- These colors have separate light and dark variants that follow Forsion's appearance, and Forsion's own math source colors no longer override them.
- Automatic text snippets are now on by default, as in Latex Suite for Obsidian: typing `mk` or `dm` in prose inserts inline or block math. If an earlier version saved this setting as off, that choice is kept. To keep prose snippets from expanding, turn off Automatic text snippets under Snippets.
- `dm` in prose now behaves as in Obsidian: words containing dm no longer turn into math in numbered headings (such as "## 1. Introduction") or quotes. On the first line of a list item it still expands, and links and bold text on the line are kept; later paragraphs of the same item and tables inside it do not expand. Typing `dm` right before another word no longer expands.
- `dm` now expands only at the start of a line or after a space, unlike Latex Suite for Obsidian. Typing admin, admit or Admiral in prose, file names and words such as installer.dmg, non-dm or path/dm, or roadmap or landmark in a list item, no longer turns into block math; `dm` on its own still expands. Only words that start with dm, such as dmesg or dmg, still expand when you type the m; press Backspace to undo.
  - If you never edited your snippet library, it switches to the new defaults when you update. This happens once: if you change it back to the old rules after updating, it stays that way.
  - If you edited it, or load snippets from a file or folder, your library is kept as it is. To get the same behavior, open Snippet library under Snippets and make three edits: in the `{trigger: "dm", …}` snippet change `trigger: "dm"` to `trigger: /(?<!\S)dm/`; change `/(\S\s*)dm/` to `/(\S\s+)dm/`; and in the snippet described as "Display math when in a list", change `(?<text>.*)dm` to `(?<text>(?:.*\s)?)dm`.
- Typing a snippet that captures the previous character, such as a Greek letter, inside a repeated placeholder no longer adds a stray `{` to the other copies.

## 1.1.2 — 2026-11-13

- Enter in multiline `align`, matrix and cases environments now inserts `\\` and moves to a new source line, preserving indentation and leading alignment cells.
- Fix Tab jumping to a closing bracket on a later row instead of inserting `&` on the current row.
- Preserve source newlines in environment snippets, placeholder navigation and Greek expansion at the beginning of a new row.

## 1.1.1 — 2026-11-12

- Fix Greek snippet expansion at the start of a formula. Tab skips coincident empty stops and can leave the formula with the same keypress.
- Add the missing Psi entry to the default Greek-letter snippets. Existing custom snippets and settings are preserved.

## 1.1.0 — 2026-11-10

- Snippets expand automatically inside paired math delimiters by default. Use the command palette to insert inline or block math. Automatic expansion in prose is opt-in.
- Added a searchable snippet reference, a separate practice editor, and commands to pause automatic expansion, resume it, and restore a trigger after expansion.
- **Tab** tries manual expansion before tabstop navigation, matrix shortcuts, and tabout. **Shift+Enter** exits a matrix environment. Snippets and equation tools support multiline block math within one text block.
- Fixed missing macro exclusions in the editable default snippets. Edit snippet variables in settings and reload external sources manually. The last valid built-in configuration can survive a restart. External load failures keep the last working library from the current session.
- Equation previews use the host by default. Added a [quick start](../README.en.md), [shortcuts and troubleshooting](shortcuts.en.md), and [migration notes](custom-snippets.en.md).

## 1.0.0 — 2026-08-15

Initial Forsion port of Obsidian LaTeX Suite, with snippet expansion, mirrored tabstops, tabout, automatic fractions, matrix shortcuts, bracket sizing, conceal, and an editable snippet library.
