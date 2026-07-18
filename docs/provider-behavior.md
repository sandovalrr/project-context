# Provider behavior

## Linear

- Authentication: personal API key.
- Expected identity: workspace ID and display name.
- Required target: team.
- Optional target: explicit project object or `none`.
- Canonical states require explicit project mappings.
- Issue URLs are added through comments when a native relation is unavailable.

## GitHub Issues

- Authentication: token from a command, keychain, file, or environment.
- Expected identity: login and host.
- Required target: explicit repository or `inherit` from a GitHub source repo.
- Pull requests returned through issue-shaped APIs are always excluded.
- Native states are `open` and `closed`; `in_progress` requires configured
  labels.
- No pull-request, release, or repository-administration operations are exposed.

## Jira Cloud

- Authentication: account email plus API token.
- Expected identity: site and account ID.
- Required target: Jira project.
- Canonical state mappings resolve to one uniquely named available transition.
- Jira Server and Data Center are unsupported in schema version 1.

## Shared operations

Adapters expose provider-neutral read/search, create, update, comment,
transition, close/reopen, and related-link operations where the provider
supports them. Permanent deletion is never exposed. Unsupported native features
produce a capability error rather than an approximation.
