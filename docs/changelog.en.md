# Changelog

[简体中文](../CHANGELOG.md)

## 1.1.0

- Snippets expand automatically inside paired math delimiters by default. Use the command palette to insert inline or block math. Automatic expansion in prose is opt-in.
- Added a searchable snippet reference, a separate practice editor, and commands to pause automatic expansion, resume it, and restore a trigger after expansion.
- **Tab** tries manual expansion before tabstop navigation, matrix shortcuts, and tabout. **Shift+Enter** exits a matrix environment. Snippets and equation tools support multiline block math within one text block.
- Fixed missing macro exclusions in the editable default snippets. Edit snippet variables in settings and reload external sources manually. The last valid built-in configuration can survive a restart. External load failures keep the last working library from the current session.
- Equation previews use the host by default. Added a [quick start](../README.en.md), [shortcuts and troubleshooting](shortcuts.en.md), and [migration notes](custom-snippets.en.md).

## 1.0.0 — 2026-08-15

Initial Forsion port of Obsidian LaTeX Suite, with snippet expansion, mirrored tabstops, tabout, automatic fractions, matrix shortcuts, bracket sizing, conceal, and an editable snippet library.
