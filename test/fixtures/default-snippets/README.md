These are the default snippet libraries that released builds wrote into user settings,
taken from each released `main.js` at runtime (function bodies are minified, as users see them).

- `1.0.0.txt`: the default library of 1.0.0.
- `1.0.0-reset.txt`: what "Reset to defaults" wrote in 1.0.0.
- `1.1.0-1.1.2.txt`: the default library of 1.1.0, 1.1.1 and 1.1.2 (identical).

`migrateDefaultSnippets` replaces a saved library with the current default only when the saved
settings carry an older defaults revision (`latexSuiteDefaultsRevision`; none counts as 0) and the
library is byte-for-byte one of the texts registered for that revision or any later one below the
current revision. Settings without a revision are checked against every table, because 1.1.0 to 1.1.2
drop the key when they save (1.0.0 keeps unknown keys, so it keeps the revision). Every save after a
successful load writes the larger of the revision it read and the current one, and writes back a
value it cannot read unchanged. Once a save has written the current revision, the library is never
replaced by this release again, even if the user sets it back to one of these texts.

## Before changing the defaults again

1. Take the text from the **last released `main.js` of the current revision**, not from the source:

   ```
   git show v<last release>:main.js | node scripts/dump-default-snippets.mjs - --out test/fixtures/default-snippets/<versions>.txt
   ```

   It prints the length and fingerprint to register. Do not use the text vitest sees in
   `DEFAULT_SETTINGS.snippetsSourceText`: the bundle serializes its function bodies minified, so the
   texts differ. A fingerprint taken from vitest keeps every test green, but users who never edited
   their library would never be upgraded. If the tool also prints a separate reset text, save and
   register that too.
2. In `src/settingsUi/model.ts`, add a new table under the current `DEFAULTS_REVISION` in
   `RELEASED_DEFAULTS_BY_REVISION` with that fingerprint. Do not add it to an older table.
3. In `test/settingsModel.test.ts`, update the test that pins the registered fingerprints: add the
   file to `released` and the fingerprint to the expected tables.
4. Bump `DEFAULTS_REVISION`.

Unreleased intermediate builds are not registered.
