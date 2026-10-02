# Pinned inlang plugins

Paraglide loads its message-format plugin through `../project.inlang/settings.json`. Until Story
68.2 that file fetched `@inlang/plugin-message-format@latest` from a CDN on every compile, so a
compile could change without any commit, and an offline compile silently produced no messages.

The plugin is now an exact-pinned devDependency of `apps/web`: `@inlang/plugin-message-format`
**4.4.4**, the version `@latest` resolved to on 2026-10-02 (MIT, Opral US Inc.). `settings.json`
loads it from `./node_modules/@inlang/plugin-message-format/dist/index.js`. inlang resolves a
relative module path from the directory that contains `project.inlang`. The file is installed from
`pnpm-lock.yaml`, whose integrity hash pins its bytes, so compiling makes no network request.

`plugins.lock.json` records each plugin's version, the module path `settings.json` uses, the path
it is packed to, and the sha256 of the file. `scripts/check-paraglide-plugin-pinned.test.ts` fails
CI in four cases:

- `settings.json` points at a URL or `@latest`;
- a module is not in `plugins.lock.json`;
- the devDependency is not pinned to exactly the locked version;
- the installed file's sha256 differs from the pin.

The published `@project-vault/web-host` package cannot rely on PV's `node_modules`.
`scripts/pack-web-host.ts` therefore copies each plugin file to its `packedAs` path in the package,
together with the plugin's own `LICENSE`, this README and `plugins.lock.json`, and rewrites the
packed `settings.json` to load that copy. MIT permits shipping a copy with its licence notice.

To upgrade, bump the devDependency to an exact new version (`pnpm --filter @project-vault/web-host
add -D --save-exact @inlang/plugin-message-format@<version>`). Then update `version` and `sha256`
(`sha256sum apps/web/node_modules/@inlang/plugin-message-format/dist/index.js`) in
`plugins.lock.json` and the version in this README, all in one commit.

This directory is not inside `project.inlang/`, because inlang rewrites a `.gitignore` there on
every compile. That `.gitignore` ignores everything except `settings.json`.
