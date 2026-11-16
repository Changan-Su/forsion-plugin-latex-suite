These are the default snippet libraries that released builds wrote into user settings,
taken from each released `main.js` at runtime (function bodies are minified, as users see them).

- `1.0.0.txt`: the default library of 1.0.0.
- `1.0.0-reset.txt`: what "Reset to defaults" wrote in 1.0.0.
- `1.1.0-1.1.2.txt`: the default library of 1.1.0, 1.1.1 and 1.1.2 (identical).

`migrateDefaultSnippets` replaces a saved library with the current default only when the saved
settings carry an older defaults revision (`latexSuiteDefaultsRevision`; none counts as 0) and the
library is byte-for-byte one of the texts registered for that revision or any later one below the
current revision. Settings without a revision are checked against every table, because 1.1.2 and
earlier drop the key when they save. Every save after a successful load writes the larger of the
revision it read and the current one, and writes back a value it cannot read unchanged. Once a save
has written the current revision, the library is never replaced by this release again, even if the
user sets it back to one of these texts.

Before changing the defaults again, save the current release's default text here and register its
fingerprint in a new table under the current `DEFAULTS_REVISION` in `src/settingsUi/model.ts`, then
bump the revision. Unreleased intermediate builds are not registered.
