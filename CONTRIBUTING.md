# Contributing to pocketwind

Read the [engineering standards](docs/engineering-standards.md) and
[code of conduct](CODE_OF_CONDUCT.md) before contributing.
Use the Node version in `.nvmrc`.

```sh
npm ci
npm run dev
npm run check
npm run build
```

The development server serves `/pocketwind/`. `npm run check` runs formatting,
lint, browser and worker type checks, script and unit-test type checks,
unit tests, and CSS token lint.

Installation configures the pre-commit hook through `.simple-git-hooks.json`.
When a checkout has an externally managed `core.hooksPath`, preserve it and use
`SKIP_INSTALL_SIMPLE_GIT_HOOKS=1 npm ci`; run `npm run check` before handing off changes.

Keep changes focused and include behavior tests for new logic. Report bugs and
propose changes through the [issue tracker](https://github.com/intesarjawad/pocketwind/issues).
