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

