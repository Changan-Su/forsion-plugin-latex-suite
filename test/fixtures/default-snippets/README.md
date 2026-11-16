These are the default snippet libraries that released builds wrote into user settings,
taken from each released `main.js` at runtime (function bodies are minified, as users see them).

- `1.0.0.txt`: the default library of 1.0.0.
- `1.0.0-reset.txt`: what "Reset to defaults" wrote in 1.0.0.
- `1.1.0-1.1.2.txt`: the default library of 1.1.0, 1.1.1 and 1.1.2 (identical).

`restoreLegacyDefaultSnippets` replaces a saved library with the current default only when it is
byte-for-byte one of these. Add the next release's text here before changing the defaults again.
