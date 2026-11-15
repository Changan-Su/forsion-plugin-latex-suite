# Changelog

[简体中文](../CHANGELOG.md)

## Unreleased

- Placeholder navigation now matches Latex Suite in Obsidian. After the inner snippet of a nested expansion, Tab moves to the next outer placeholder instead of selecting the whole outer content. If you move to a later placeholder with the mouse or arrow keys, Tab continues from there. Navigation ends at the last placeholder, which is no longer highlighted or extended by further typing.
- After snippets with a single placeholder, such as `mk` and `dm`, the first Tab is no longer consumed by placeholder navigation. Shift+Tab on the first placeholder no longer ends navigation, and the placeholders remain.
- The placeholder after a fraction is no longer lost when typing `//` inside brackets enlarges them. Fractions created with `/` inside math now also let Tab move from the denominator to after the fraction.

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
