# Contributing to project-context

Thank you for helping improve project-context. Contributions must preserve its
provider-neutral issue scope, local security boundaries, and predictable
two-phase write behavior.

## Prerequisites

- Git and Node.js 22 or 24.
- Bun 1.3.14, pinned in `package.json` and `mise.toml`.
- Linux or macOS. CI validates both operating systems.

Install exactly the locked dependency graph:

```sh
bun ci
bun run check
bun run test:packed
```

The lockfile and `bunfig.toml` enforce a 48-hour cooling-off period for every
new direct or transitive npm package version. Do not bypass it. Exact direct
dependency versions are required.

Provider accounts are unnecessary for tests. Never commit tokens, real project
mappings, account names, credential files, runtime state, release artifacts, or
history-backup bundles.

## Scope and architecture

Read `docs/architecture.md`, `docs/configuration.md`,
`docs/routing-and-safety.md`, and `docs/threat-model.md` before changing core
behavior. Keep the CLI, MCP schemas, examples, docs, and optional skill aligned.

Issue handling is in scope. Pull requests, releases as an MCP capability,
repository administration, Git identities, and SSH configuration are not.

## Code style

- Do not use `let`. Split mutable cases into focused functions that return a
  result.
- Do not hide reassignment through mutable arrays or objects.
- Group related declarations and separate distinct groups with blank lines.
- Prefer early returns, explicit error codes, narrow interfaces, and readable
  names.
- Use two-space indentation and double-quoted TypeScript strings. Biome is the
  formatting and linting authority.

Add deterministic tests before implementation when behavior changes. Tests
must not make live provider calls or require real credentials.

## Validation

Run before opening a pull request:

```sh
bun run format
bun run check
bun run check:package-age
bun audit --audit-level=high
bun run test:packed
```

CI repeats source checks and tests the npm tarball on Node 22 and 24 across
Ubuntu and macOS. Node 26 is a non-blocking forward-compatibility smoke test.

## Commits and pull requests

Use Conventional Commit subjects because semantic-release derives versions and
release notes from them:

```text
fix: reject redirected provider responses
feat: add a provider-neutral issue operation
feat!: change a public MCP tool contract
```

Before 1.0, breaking changes normally produce a minor release; the maintainer
must explicitly authorize the first 1.0 release. Keep commits focused. Pull
requests should explain motivation, user-visible behavior, security impact,
tests, and related issues.

CODEOWNERS review is required for workflows, release code, schemas, package
metadata, and registry metadata. Do not create tags or edit release versions by
hand; follow `docs/releasing.md`.

## License and attribution

Contributions are licensed under the MIT License. The copyright and permission
notice must remain with copies or substantial portions of the software.

If you use this repository as a starting point, please include a visible
acknowledgment such as:

> Based on project-context, created by Richard Sandoval.
