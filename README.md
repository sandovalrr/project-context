# project-context

`project-context` is a local, provider-neutral MCP server for repository-scoped
issue handling. It gives agents one guarded interface to Linear, GitHub Issues,
and Jira Cloud while keeping project mappings and credentials outside source
repositories.

The server resolves the current Git repository, selects its configured issue
provider, verifies the authenticated account, and separates every write into a
preview and a single-attempt apply step. Pull requests, releases, repository
administration, Git authentication, and commit signing are intentionally out of
scope.

## Quick start

Requirements: Node.js 22 or newer on Linux or macOS.

```sh
VERSION=0.1.0
npx -y --package="@sandovalrr/project-context-mcp@$VERSION" project-context setup
npx -y --package="@sandovalrr/project-context-mcp@$VERSION" project-context doctor
```

The first command creates secure, host-local starter files without overwriting
anything that already exists:

```text
~/.agents/config/project-context/projects.yaml
~/.agents/config/project-context/credentials.yaml
~/.agents/config/project-context/templates/
~/.agents/config/project-context/secrets/
~/.local/state/project-context/
```

Copy and adapt the sanitized examples in `examples/`, validate the result, and
then register the `project-context-mcp` stdio command in your MCP client. The
complete Codex, Claude, Zed, and VS Code configurations are in
[`docs/installation.md`](docs/installation.md).

## Safety model

- Host-local YAML determines the repository, provider, target, and expected
  identity. Missing or ambiguous context fails closed for writes.
- Credentials resolve from files, environment variables, OS keychains, or
  argv-only commands. Literal secrets in YAML are rejected.
- Provider calls are restricted to fixed HTTPS origins, reject redirects, cap
  response sizes and timeouts, and never automatically retry writes.
- Prepared writes expire after ten minutes, are encrypted with AES-256-GCM,
  and can be claimed only once. An uncertain apply result becomes
  `indeterminate` and is never replayed automatically.
- Mutation audit records contain metadata only, are mode `0600`, and rotate
  locally. The project has no telemetry.

Read [`docs/threat-model.md`](docs/threat-model.md) for trust boundaries and
residual risks, and [`docs/routing-and-safety.md`](docs/routing-and-safety.md)
for operational behavior.

## Commands and MCP tools

```sh
project-context --help
project-context setup --guided
project-context config validate
project-context resolve --cwd /path/to/repository
project-context issue list --status open --status in_progress
project-context issue user search "John Smith"
project-context issue capabilities
project-context issue option search labels security
project-context issue comment list github:#42 --limit 20
project-context doctor
project-context audit list
project-context skill status
project-context integration manifest --client codex
```

The stdio server exposes eleven tools:

- `resolve_project_context`
- `list_issues`
- `search_issues`
- `list_users`
- `search_users`
- `search_issue_options`
- `get_issue_capabilities`
- `get_issue`
- `list_issue_comments`
- `prepare_issue_change`
- `apply_issue_change`

Every tool has an input and output schema. Starting the server has no setup side
effects; when host configuration is absent, tools return an actionable
structured error.

`integration manifest` prints the provider-neutral command definition by
default. Pass `--client codex`, `claude`, `zed`, or `vscode` to emit native,
ready-to-paste configuration pinned to the installed package version. Add
`--json` when automation needs an envelope containing the client, format, and
configuration.

The optional `project-issues` agent skill is packaged but never installed as an
npm lifecycle side effect:

```sh
project-context skill status
project-context skill install
```

Use `--replace` only after reviewing status; replacement creates a timestamped
backup.

## Documentation

- [`docs/installation.md`](docs/installation.md): package and MCP client setup.
- [`docs/configuration.md`](docs/configuration.md): host-local YAML and credential resolvers.
- [`docs/architecture.md`](docs/architecture.md): components and runtime boundaries.
- [`docs/provider-behavior.md`](docs/provider-behavior.md): provider-specific behavior.
- [`docs/releasing.md`](docs/releasing.md): bootstrap, semantic release, npm, and MCP Registry.
- [`CONTRIBUTING.md`](CONTRIBUTING.md): development and review requirements.
- [`SECURITY.md`](SECURITY.md): supported versions and private reporting.

## License and attribution

This project is available under the [MIT License](LICENSE), copyright 2026
Richard Sandoval. The copyright and permission notice must remain with copies
or substantial portions of the software.

If this repository is used as the starting point for another project, a visible
acknowledgment is appreciated:

> Based on project-context, created by Richard Sandoval.
