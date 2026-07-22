# Linear MCP integration

The Linear issue adapter delegates provider operations to Linear's hosted MCP
server at `https://mcp.linear.app/mcp`. Existing host-local `token` credentials
are passed as bearer credentials. No extra client configuration or interactive
OAuth flow is required when a personal API key or OAuth access token is already
configured.

## Allowed operations

Project-context does not proxy the hosted server. Its internal MCP client can
call only this fixed tool set:

| Linear MCP tool | Project-context use |
| --- | --- |
| `get_issue` | Target-scoped reads and mutation revalidation |
| `list_issues` | Lists, searches, archived opt-in, and direct subissue filtering |
| `save_issue` | Create, update, workflow, planning fields, subissues, and relationships |
| `list_comments` | Comment reads after issue target validation |
| `save_comment` | Comments, replies, edits, and provider-neutral related links |
| `get_user` | Authenticated principal identity |
| `list_users` | Target-team assignee discovery |
| `list_issue_labels` | Label validation and capabilities |
| `list_issue_statuses` | Exact workflow transition resolution |
| `list_cycles` | Target-team cycle validation and discovery |
| `list_milestones` | Target-project milestone validation and discovery |

SLA fields, attachments, deletes, projects, initiatives, releases, diffs,
reviews, documents, customer needs, delegation, agent skills, and
administrative tools are deliberately excluded. Adding an upstream capability
requires a provider-neutral operation, local target rules, preview/apply
behavior for writes, response schemas, tests, and an explicit allowlist change.

## Security controls

- The endpoint is fixed to the exact HTTPS origin and path; redirects fail.
- Requests time out after 20 seconds and responses are capped at 2 MiB.
- MCP transport calls are not retried because the HTTP layer cannot infer
  whether a tool call is a read or a write.
- Every connection verifies the required tool names and input properties.
- Every tool call rejects input properties outside its local allowlist before
  transport. An upstream field being available does not make it reachable.
- Tool errors are redacted and JSON output is validated locally.
- Direct reads and mutations revalidate the configured team and project
  policy. Related issues, subissue parents, and relationship targets are also
  validated. Comment reads, replies, and edits validate both the issue and
  comment ownership before returning or changing content.
- The normal encrypted preview/apply token, identity check, version check, and
  metadata-only audit remain authoritative for writes.

Linear MCP currently exposes the authenticated user but not the workspace ID.
The adapter therefore retains one minimal read-only query to
`https://api.linear.app/graphql` for `organization { id name }`. This preserves
the configured expected-workspace check instead of weakening tenant identity.

## Target policies and pagination

An exact project uses one upstream project-filtered stream. A multi-project
target creates one bounded stream per included stable project ID, merges them
by issue identifier, and orders the result by `updatedAt`. An `any` target uses
the configured team without a project filter.

Linear MCP has no explicit unprojected-only filter. A `none` target therefore
pages through the configured team and drops projected issues before returning
content. Collection stops after ten pages of at most 250 items. If that bound
or the requested result limit prevents complete collection, operations that
support it return `truncated: true`.

`include_archived` is false unless explicitly requested. A parent filter first
validates the parent through the configured target, then passes its identifier
to Linear's direct-subissue filter. Relation-expanded reads fetch every
referenced issue separately and return the relation set only after all of them
pass the same target policy.
