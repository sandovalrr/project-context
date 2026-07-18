# Architecture

## Purpose

Provide repository-aware issue handling for local agents without placing agent
configuration or credentials inside application repositories. The first
version supports Linear, GitHub Issues, and Jira Cloud. Pull requests, releases,
Git authentication, commit signing, and general repository administration are
out of scope.

## Components

```text
Agent / local MCP client
          |
          v
project_issues MCP server  <-->  project-issues skill
          |
          v
shared project-context core
  | repository resolver
  | YAML configuration + schema
  | credential resolver
  | deterministic router
  | preview/apply engine
  | redacted audit writer
          |
          +------ Linear adapter
          +------ GitHub Issues adapter
          +------ Jira Cloud adapter
```

The executable exposes the same core through a diagnostic CLI and a stdio MCP
server. An agent sees one provider-neutral tool set rather than overlapping tools
from multiple issue systems.

## Repository identity

The canonical identity is the normalized `origin` Git remote:

```text
github.com/owner/repository
bitbucket.org/workspace/repository
```

SSH and HTTPS remotes normalize to the same identity. Host-local remote and path
aliases cover forks, repositories without an origin, and exceptional layouts.
The resolver stops on ambiguity. Version one resolves at the Git repository
level only; subdirectories cannot silently change issue routing.

## Configuration and state

Host-local configuration defaults to:

```text
~/.agents/config/project-context/
```

The repository ships examples and schemas, but never real project mappings or
credentials. `project-context setup` creates a starter configuration only when
none exists. It never treats examples as routing data or overwrites existing
configuration.

Runtime state defaults to:

```text
~/.local/state/project-context/
```

It contains locks, short-lived prepared operations, timestamped backups, and a
metadata-only audit log. It contains no provider credentials or issue bodies.

## Provider model

Reusable global provider profiles define authentication aliases and expected
identities. Project entries reference those profiles and add their specific
issue target:

- Linear: workspace profile plus required team and explicit project or `none`.
- GitHub Issues: GitHub identity plus an explicit target repository or
  `inherit` from a GitHub source repository.
- Jira Cloud: Jira site/account identity plus a required Jira project.

The source-code host and issue provider are independent. A Bitbucket repository
may use GitHub Issues, Linear, Jira Cloud, or multiple configured providers.

## Authentication

Version one uses local API-key/token authentication:

- Linear personal API key.
- GitHub token, commonly resolved through `gh auth token`.
- Jira Cloud account email plus API token.

OAuth is deferred. Credential aliases resolve through host-local `file`,
`command`, `environment`, `keychain`, or non-secret `literal` fields. Secrets
must never appear in prompts, configuration previews, errors, logs, process
arguments, or audit entries.

Every provider profile binds a credential to an expected identity. Writes
revalidate that identity immediately before execution. A valid credential for
the wrong workspace, GitHub login, or Jira site/account is rejected.

## Mutation protocol

All issue writes use two phases:

1. Prepare: resolve repository/provider, validate identity and target, normalize
   fields, fetch the current issue version when applicable, and return an exact
   preview plus an opaque operation token.
2. Apply: load the immutable prepared payload, revalidate repository,
   configuration hash, credential identity, provider target, issue version, and
   expiration before performing the mutation.

Prepared operations expire after ten minutes. A configuration change, target
issue update, repository change, identity mismatch, or payload alteration
invalidates the token and requires a new preview.

Permanent issue deletion is unsupported. Bulk changes require their own
explicit preview and confirmation.

## Installation boundaries

Core installation and agent-client registration are separate:

```text
bun run install:user
project-context integration manifest
```

The first installs the executable and shared skill without replacing host
configuration. The second prints a client-neutral stdio MCP manifest; the user
adds it through the chosen local agent client's configuration mechanism. Hosted
agent clients are outside version-one scope when they cannot use local stdio
MCP, configuration, or credential storage.
