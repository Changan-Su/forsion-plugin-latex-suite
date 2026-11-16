These are the default snippet libraries that released builds wrote into user settings,
taken from each released `main.js` at runtime (function bodies are minified, as users see them).

- `1.0.0.txt`: the default library of 1.0.0.
- `1.0.0-reset.txt`: what "Reset to defaults" wrote in 1.0.0.
- `1.1.0-1.1.2.txt`: the default library of 1.1.0, 1.1.1 and 1.1.2 (identical).

`migrateDefaultSnippets` replaces a saved library with the current default only when the saved
settings carry no defaults revision (`latexSuiteDefaultsRevision`, written by every save after the first release that migrates)
and the library is byte-for-byte one of these. Once a save has written the revision, the library is
never replaced again, even if the user sets it back to one of these texts.

Before changing the defaults again, save the current release's default text here and register its
fingerprint under the current `DEFAULTS_REVISION` in `src/settingsUi/model.ts`, then bump the revision.
Unreleased intermediate builds are not registered.
