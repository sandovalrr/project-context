# Architecture

## Purpose and boundaries

`project-context` provides repository-aware issue handling without placing
agent configuration or credentials inside application repositories. Version
0.1 supports Linear, GitHub Issues, and Jira Cloud through a local stdio MCP
server and a diagnostic CLI. Hosted HTTP MCP, OAuth, pull requests, releases,
Git authentication, commit signing, and repository administration are out of
scope.

## Components

```text
MCP client or CLI
        |
        v
Node 22+ bundled executables
  | working-directory/root allowlist
  | repository resolver
  | YAML schema and configuration
  | credential resolver
  | deterministic issue router
  | encrypted preview/apply engine
  | metadata-only audit writer
        |
        +------ Linear adapter
        +------ GitHub Issues adapter
        +------ Jira Cloud adapter
```

`project-context-mcp` starts the stdio server directly. `project-context`
exposes setup, diagnostics, the same issue operations, audit maintenance, and
optional skill installation. The package bundles its JavaScript and has no npm
runtime dependencies. Bun is the locked development, test, and build tool;
published execution uses standard Node APIs.

## Repository and working-directory identity

The canonical repository identity is the normalized `origin` remote, for
example `github.com/owner/repository` or
`bitbucket.org/workspace/repository`. SSH and HTTPS normalize to the same ID.
Host-local remote/path aliases cover forks and exceptional layouts. Ambiguity
stops resolution.

MCP client roots form an allowlist. An explicit tool `cwd` has highest priority,
but when roots are present it must fall inside exactly one. Exactly one root can
serve as the cwd; multiple roots require an explicit selection. Environment and
process cwd are fallbacks only.

## Configuration and identity

Reusable provider profiles bind credential aliases to expected identities.
Project entries reference profiles and add their issue target. The source-code
host and issue provider are independent.

Every write revalidates the provider identity immediately before execution. A
valid credential for the wrong Linear workspace, GitHub login, or Jira
site/account is rejected. Provider origins are fixed to Linear, GitHub's public
API, or the configured `*.atlassian.net` tenant.

## Mutation protocol

All writes have two phases:

1. Prepare resolves context, validates identity and target, normalizes fields,
   fetches current issue state, and stores an encrypted payload for ten minutes.
2. Apply atomically claims the token, decrypts it, and revalidates repository,
   configuration hash, identity, target, issue version, and expiry before the
   provider call.

Pending payloads use AES-256-GCM with a local mode-`0600` 256-bit key and
authenticated token/expiry metadata. A token can be claimed only once. A
failure after claim is marked `indeterminate`; the server never replays it
because the remote provider may already have accepted the write.

The protocol technically enforces prepare-before-apply. Human approval between
the calls is a client/agent responsibility, documented by the optional skill.
See the threat model for this trust boundary.

## Network behavior

All provider traffic uses HTTPS, rejects redirects, has a 20-second timeout,
and caps response bodies at 2 MiB. Only read operations retry temporary
429/502/503/504 responses. Writes are never automatically retried unless a
future adapter introduces an explicit provider idempotency guarantee.

## Local state and observability

Runtime state defaults to `~/.local/state/project-context/`. It contains the
preview key, pending changes, backups, and a metadata-only mutation audit. Audit
files rotate at 10 MiB with five retained rotations and can be listed or purged
explicitly. Read operations are not audited. There is no telemetry or remote
diagnostic export.

## Distribution

`server.json` describes the npm stdio package for the official MCP Registry.
Releases include one npm tarball, a CycloneDX JSON application SBOM, and SHA-256
checksums. The release workflow publishes that exact draft asset rather than
rebuilding it. See `docs/releasing.md`.
