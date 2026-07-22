# Threat model

## Security goals

`project-context` aims to prevent issue operations from being routed to the
wrong repository, provider, tenant, account, or target; prevent credentials and
issue content from leaking through logs or local state; and prevent a prepared
write from being altered, replayed, or silently redirected.

It is a local single-user tool. Availability is secondary to failing closed.
When state is ambiguous, the safe outcome is an actionable error and a fresh
preview.

## Protected assets

- Linear, GitHub, and Jira credentials.
- Provider identity and organization boundaries.
- Issue content contained in prepared writes.
- Host-local project routing and templates.
- Integrity of npm packages, release metadata, and MCP Registry entries.
- Metadata in audit records, backups, and local paths.

## Trust boundaries

### Local OS account

The user's account, filesystem permissions, process environment, keychain, Git
configuration, and installed `node`/`npx` executables are trusted. Another local
account should not be able to read mode-`0600` files. Root or compromise of the
user account defeats this boundary.

### MCP client and agent

The client may invoke every exposed tool. The server enforces that an apply has
a valid prepared token, but it cannot prove a human reviewed the preview. The
client or agent is trusted to show the preview and wait for explicit approval.
The optional skill documents that policy; it is not a cryptographic consent
mechanism.

### Source repository

Checked-out repositories are untrusted inputs. They do not contain routing or
credentials and cannot change the host-local project registry. Git remotes and
paths are normalized and matched against explicit configuration. Command
credential resolvers must not execute repository-controlled scripts.

### Provider networks

Linear's hosted MCP and API, GitHub, Jira Cloud, DNS, TLS, and the local network
are external trust boundaries. Requests use HTTPS and fixed allowed origins,
reject redirects, time out, and cap response bodies. Provider responses remain
untrusted data and are normalized before returning to the client.

### Package and release infrastructure

GitHub Actions, npm trusted publishing, and the MCP Registry's GitHub OIDC
exchange are trusted for distribution. Workflows use read-only permissions by
default, full-SHA action pins, a protected release environment, exact locked
dependencies, a 48-hour package cooling-off period, checksums, an SBOM, and
publication of the draft-built tarball without rebuilding.

## Threats and mitigations

### Wrong repository or issue provider

Ambiguous remotes, aliases, identifier patterns, client roots, and provider
selection fail closed. Explicit URLs or provider-qualified references take
precedence only when that provider is configured for the repository.

Linear `project: any` is an explicit widening from one project to the complete
configured team. The adapter still adds the team filter to list/search requests
and validates the returned team on direct reads used during mutation prepare
and apply.

A Linear multi-project target uses stable IDs for an explicit allowlist. The
adapter applies that allowlist to list/search queries and validates it again on
direct reads. Its required `create_in` ID must be in the allowlist, preventing
creation from silently depending on list order or escaping the read boundary.

The hosted Linear MCP advertises a much wider tool catalog than project-context
needs. The adapter statically allowlists issue read/write, comment, user, label,
status, cycle, and milestone tools, validates their input interfaces at
connection time, rejects non-allowlisted input properties before transport,
and normalizes their output through local schemas. Missing tools, input schema
drift, malformed output, and out-of-target results fail closed. SLA fields,
attachments, deletes, projects, initiatives, releases, diffs, reviews,
delegation, and administrative tools are not reachable through project-context.

GitHub Project targets use stable GraphQL node IDs for both the Project and its
Status field. Direct reads and mutations verify Project membership; Project
lists filter content type and repository. Names are never used as the security
boundary.

GitHub hierarchy, dependency, and duplicate operations resolve references
through the configured repository before writing and repeat optional Project
membership checks during apply. Relation reads reject missing or mismatched
repository identities before returning the relation set. Comment edits compare
the provider-owned `issue_url` with the configured target and revalidate the
issue before mutation. Bounded relation pagination fails closed rather than
returning an apparently complete partial graph.

### Valid credential for the wrong account

Provider profiles bind credentials to an expected workspace, login, or Jira
site/account. Identity is checked during prepare and again immediately before a
write.

### Credential disclosure

Literal YAML credentials are rejected. File and keychain values stay in
memory. Command resolvers use argv execution without a shell or stdin, enforce
time/output limits, and redact process output from failures. Credentials never
enter preview files, audit events, or diagnostics.

Environment variables can leak through other same-user processes or debugging
tools. File or keychain resolvers are preferable for long-lived credentials.

### SSRF, redirects, and response exhaustion

Adapters allow only their fixed HTTPS origin: Linear's hosted MCP and API,
`api.github.com`, or the configured `*.atlassian.net` tenant. Redirects are
rejected. Requests have a 20-second timeout and responses are capped at 2 MiB.
Safe request IDs may be reported; response bodies are not copied into errors.

### Tampered or replayed preview

Prepared payloads use AES-256-GCM with authenticated token and expiry metadata.
The local key and payloads require mode `0600` regular files. Apply atomically
claims the token and rechecks configuration hash, repository, identity, target,
issue version, and expiry. Tampering invalidates authentication.

Encryption protects an offline copy of a pending file from a reader who lacks
the separate key. It does not protect against compromise of the running user,
who can read both.

### Duplicate writes after timeout

Writes are not retried automatically. Once apply claims a token, any uncertain
failure becomes `indeterminate` and the token cannot be replayed. The user must
inspect provider state before preparing another mutation.

### Audit or backup disclosure

Audit records exclude descriptions, comments, attachments, and credentials,
but their repository/provider/identity metadata may still be sensitive. Audit
and backup locations are user-only. Audit rotation bounds accumulation and
explicit purge is available.

### Dependency or workflow compromise

Direct dependencies are exact-pinned and the complete Bun lockfile is
committed. New package versions must be at least 48 hours old. CI audits the
graph and tests the packed artifact under supported Node/OS combinations.
Release workflows and metadata require CODEOWNERS review; third-party Actions
are pinned to full commit SHAs.

The release draft carries an exact tarball, CycloneDX JSON application SBOM,
and SHA-256 manifest. Publishing rechecks tag, versions, checksums, SBOM, and
MCP behavior, then sends the same tarball to npm using OIDC provenance. Registry
publication occurs only after npm exposes that version.

## Residual risks and non-goals

- A malicious or compromised MCP client can call apply immediately after
  prepare, invoke broad reads, or expose returned issue data.
- Root, same-user compromise, debugger access, malicious Node/npm binaries, or
  compromised credential helpers can access secrets.
- Provider-side compromise, malicious issue content, DNS/TLS ecosystem failure,
  and provider authorization bugs are outside local enforcement.
- Creating an issue and adding it to a Project, or changing Project Status and
  synchronizing the issue lifecycle, are separate provider writes. A failure
  between them can leave partial provider state that requires inspection; the
  client does not retry either write automatically.
- Creating or updating an issue and then applying GitHub hierarchy, dependency,
  or duplicate relationships may require several provider writes. A failure
  between them is indeterminate and may leave a partial relationship set that
  requires inspection.
- AES encryption does not provide protection when both key and state directory
  are stolen together.
- Metadata-only audit is not a tamper-evident or remote compliance log.
- Hosted HTTP MCP, multi-user isolation, OAuth delegation, Windows support, and
  permanent issue deletion are out of scope for version 0.1.

## Security verification checklist

Before a release, verify configuration and state permission tests, credential
redaction, origin/redirect/timeout/body limits, identity mismatch behavior,
preview tamper/expiry/single-claim behavior, indeterminate write handling,
audit content/rotation, package file allowlist, Node compatibility, checksums,
SBOM validation, and OIDC-only publication.
