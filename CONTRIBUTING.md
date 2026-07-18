# Contributing to project-context

Thank you for helping improve project-context. Contributions should preserve
its provider-neutral design, security boundaries, and predictable issue
handling.

## Prerequisites

- Git.
- Bun 1.3.14, as declared by `packageManager` in `package.json` and by
  `mise.toml`. You may install it directly or run `mise install`.
- A Linux or macOS development environment. Continuous integration runs on
  Ubuntu.

Provider accounts and credentials are not required for the test suite. Never
commit real project mappings, access tokens, API keys, credential files, or
runtime state. Host-specific data belongs under the paths documented in
`README.md`.

## Set up the project

1. Fork the repository and clone your fork.
2. Create a focused branch from `main`.
3. Install the exact locked dependencies:

   ```sh
   bun ci
   ```

4. Confirm the baseline is healthy:

   ```sh
   bun run check
   bun run build
   ```

For substantial behavior or architecture changes, open an issue before doing
the implementation so the intended scope can be agreed upon.

## Architecture and scope

Read these documents before changing core behavior:

- `docs/architecture.md` defines the system boundaries.
- `docs/configuration.md` defines host-local configuration.
- `docs/routing-and-safety.md` defines provider routing and write safeguards.
- `docs/provider-behavior.md` defines provider-specific behavior.

Issue handling is in scope. Pull requests, releases, Git authentication,
commit signing, and repository administration are intentionally out of scope.
Keep the CLI, MCP tools, schemas, examples, documentation, and agent skill in
sync when a contract changes.

## Code style

- Do not use `let`. Prefer immutable `const` bindings and extract branches or
  state transitions into focused functions that return their result.
- Do not conceal reassignment through object or array mutation.
- Group declarations by purpose and separate distinct declaration groups with
  a blank line.
- Favor early returns, explicit error codes, narrow interfaces, and readable
  names over clever abstractions.
- Preserve the existing two-space formatting and double-quoted TypeScript
  strings. Biome is the source of truth for automated formatting and linting.

Run formatting before submitting a change:

```sh
bun run format
```

## Tests and validation

Add or update tests for every behavior change. Tests must be deterministic,
must not depend on real provider credentials, and must not make live provider
requests. Use the existing injected fetchers and temporary configuration
patterns.

Before opening a pull request, run the same checks as continuous integration:

```sh
bun run typecheck
bun run lint
bun test
bun run build
bun audit --audit-level=high
```

## Commits and pull requests

- Keep commits focused and use an imperative summary.
- Explain the motivation, user-visible behavior, and security impact in the
  pull request description.
- Link relevant issues and describe the validation performed.
- Include documentation and examples when behavior or configuration changes.
- Confirm that no secrets, personal host configuration, generated binaries,
  or unrelated changes are included.
- Wait for all required continuous-integration checks to pass.

Maintainers may request revisions when a change broadens scope, weakens a
security boundary, silently changes provider behavior, or lacks appropriate
tests.

## Security reports

Do not report vulnerabilities or exposed credentials in a public issue. Follow
the private reporting process in `SECURITY.md`.

## License and attribution

By contributing, you agree that your contribution is licensed under the MIT
License. The MIT copyright and permission notice must remain with copies or
substantial portions of the software.

If you use this repository as the starting point for another project, please
also include a visible acknowledgment such as:

> Based on project-context, created by Richard Sandoval.
