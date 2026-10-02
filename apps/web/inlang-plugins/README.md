# Vendored inlang plugins

`plugin-message-format.js.txt` is `dist/index.js` from the npm package
[`@inlang/plugin-message-format`](https://www.npmjs.com/package/@inlang/plugin-message-format)
**4.4.4**, copied byte for byte and only renamed (sha256
`b22cf60eb28b3c8c3ce1fb6300611a0552f12d0d995d37c4dd2c96e3ad80c645`). It is the version the
previous `@latest` CDN URL resolved to on 2026-10-02.

The `.txt` suffix keeps third-party minified code out of this repository's own source analysis
(ESLint, SonarCloud and jscpd only look at source extensions) without adding an ignore entry to any
of them. inlang does not care about the extension: it reads the file as text and imports it as a
`data:` module.

It is vendored (Story 68.2) so that `paraglide compile` makes no network request and produces the
same output every time, in this repository and in every consumer of `@project-vault/web-host`.
`../project.inlang/settings.json` loads it as `./inlang-plugins/plugin-message-format.js.txt`; inlang
resolves a relative module path from the directory that contains `project.inlang`. It is not kept
inside `project.inlang/`, because inlang rewrites a `.gitignore` there on every compile that
ignores everything except `settings.json`.

The plugin is MIT-licensed by Opral US Inc.; its licence text is in
`LICENSE-plugin-message-format` next to this file. Vendoring a copy with its licence notice is
permitted by the MIT licence.

The pin lives in `plugins.lock.json`. `scripts/check-paraglide-plugin-pinned.test.ts` fails CI if
`settings.json` points at a URL or `@latest`, or if a plugin file's sha256 differs from its pin.
To upgrade, follow the comment at the top of that guard and change the file, `plugins.lock.json`
and this README in one commit.
