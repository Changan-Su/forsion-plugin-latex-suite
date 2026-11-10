# LaTeX Suite for Forsion

[简体中文](README.md)

Type short triggers to enter LaTeX in Amadeus notes. Your equations are stored in the note using Markdown dollar delimiters.

## Quick start

1. Install and enable **LaTeX Suite** from the Forsion plugin marketplace.
2. Open an Amadeus note and place the cursor in the body. Open the command palette and run **Insert inline math**. The command inserts a pair of dollar signs and places the cursor between them. Use **Insert block math** for a displayed equation.
3. Type `@a` between the delimiters to expand it to `\alpha`. Follow it with `sr` to get `\alpha^{2}`.
4. In another empty equation, type `//` to get `\frac{}{}`. Fill in the numerator, press **Tab** to reach the denominator, and press **Tab** again after filling it in to move past the fraction.

By default, snippets expand automatically inside paired math delimiters. You can type `mk` and `dm` in prose as usual. To use them to insert equations, enable **Automatic text snippets** under **Snippets** in the plugin settings.

Open **Guide & practice** in the plugin settings to search the active library by trigger, LaTeX command, or description. The practice editor uses the same input rules as notes and keeps your practice text in memory.

## Guides

- [Shortcuts and troubleshooting](docs/shortcuts.en.md)
- [Custom snippets and Obsidian migration](docs/custom-snippets.en.md)

## Development

Run `npm ci` to install dependencies and `npm run verify` to type-check, test, bundle, and check plugin loading. When changing the source, commit the rebuilt `main.js` as well. Marketplace installs use that bundle directly.

- `npm run test:ui` checks the settings panel in a standalone Chromium harness. Set `PW_HOST=/path/to/Forsion-Genesis/desktop/package.json` to point to a project with `playwright-core` installed. The harness requires Playwright's Chromium.
- `DESKTOP_DIR=/path/to/Forsion-Genesis/desktop npm run test:host` runs note editing, restart, and screenshot checks in the actual Forsion Electron build. Build the plugin and Genesis desktop first so the Electron main process, preload, and frontend assets are available. The harness uses a temporary user directory and vault. Set `OUT_DIR` to choose where results and screenshots go, or `KEEP_STATE=1` to retain the temporary state for debugging.

The default snippets, variables, and symbol maps come from [Obsidian LaTeX Suite](https://github.com/artisticat1/obsidian-latex-suite). See [LICENSE-upstream.md](LICENSE-upstream.md) for the upstream MIT license.
