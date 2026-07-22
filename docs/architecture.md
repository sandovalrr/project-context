# Architecture

## Purpose and boundaries

`project-context` provides repository-aware issue handling without placing
agent configuration or credentials inside application repositories. Version
0.1 supports Linear, GitHub Issues, and Jira Cloud through a local stdio MCP
server and a diagnostic CLI. Hosting project-context as an HTTP MCP server,
pull requests, releases, Git authentication, commit signing, and repository
administration are out of scope.

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
        |          +------ allowlisted hosted Linear MCP tools
        |          +------ workspace identity query
        +------ GitHub Issues adapter
        |          +------ optional Projects v2 boundary
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

The GitHub adapter keeps repository issue operations as its public provider
interface. When a Projects v2 target is present, an internal GraphQL module
owns bounded item collection, membership assertions, Project enrollment, and
Status option mutation. This prevents Project-specific concepts from leaking
into provider-neutral operations.

GitHub issue types, milestones, subissues, dependencies, duplicates, and
comment edits remain behind that same provider-neutral interface. Repository
REST endpoints perform the native operations. A narrow GraphQL query is used
only to read or clear the canonical duplicate relationship, which REST does
not return as a normal issue field. Every related issue is checked against the
configured repository and optional Project target before content is returned
or a write is applied.

Every write revalidates the provider identity immediately before execution. A
valid credential for the wrong Linear workspace, GitHub login, or Jira
site/account is rejected. Provider origins are fixed to Linear, GitHub's public
API, or the configured `*.atlassian.net` tenant.

The Linear adapter is an MCP client as well as an issue adapter. It connects to
Linear's hosted Streamable HTTP MCP endpoint with the resolved bearer
credential, verifies the upstream tool interface, and exposes only the issue
operations already present at project-context's provider-neutral seam. It does
not proxy Linear's tool catalog. A minimal direct Linear API query remains for
the expected workspace ID because the hosted MCP does not expose workspace
identity. See [Linear MCP integration](linear-mcp.md).

The Linear adapter keeps planning fields, subissue parents, relationships, and
comment modes behind that same seam. The upstream tool name and its broader
field catalog never become caller-controlled. Target validation is reused for
primary issues and every referenced issue; comment ownership has a separate
bounded internal seam.

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
and caps response bodies at 2 MiB. Direct read operations may retry temporary
429/502/503/504 responses. Linear MCP transport requests are never retried
because read and write tool calls share the same HTTP method. Writes are never
automatically retried unless a future adapter introduces an explicit provider
idempotency guarantee.

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
