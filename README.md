# project-context

`project-context` gives local coding agents one guarded interface for issue
tracking across Linear, GitHub Issues, and Jira Cloud. It resolves the current
Git repository against host-local configuration, selects the configured issue
provider, validates the authenticated identity, and previews every mutation
before applying it.

The repository contains the CLI/MCP implementation, schemas, examples,
documentation, and the `project-issues` agent skill. Real project mappings,
credentials, templates, and audit state remain outside this repository on each
host.

Default host-local paths:

```text
~/.agents/config/project-context/projects.yaml
~/.agents/config/project-context/credentials.yaml
~/.agents/config/project-context/templates/
~/.agents/config/project-context/secrets/
~/.local/state/project-context/
```

The implementation targets Bun and TypeScript. See
[`docs/architecture.md`](docs/architecture.md) for the system contract and
[`docs/configuration.md`](docs/configuration.md) for the YAML model.
See [`docs/installation.md`](docs/installation.md) for the user-scoped install
and client-neutral MCP manifest.

The CLI provides nested command help, strict option validation, spelling
suggestions, and shell completion:

```sh
project-context --help
project-context issue --help
project-context completion
```

Interactive terminals receive colorized JSON. Redirected output and `--json`
remain plain machine-readable JSON; `--no-color` disables styling explicitly.

## Contributing

Contributions are welcome. Read [`CONTRIBUTING.md`](CONTRIBUTING.md) for the
development prerequisites, architecture boundaries, coding rules, validation
commands, and pull request checklist. Report security concerns privately as
described in [`SECURITY.md`](SECURITY.md).

## License and attribution

This project is available under the [`MIT License`](LICENSE), copyright 2026
Richard Sandoval. The copyright and permission notice must remain with copies
or substantial portions of the software.

If this repository is used as the starting point for another project, a visible
acknowledgment is appreciated:

> Based on project-context, created by Richard Sandoval.
