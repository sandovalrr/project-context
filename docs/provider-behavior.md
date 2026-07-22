# Provider behavior

## Linear

- Authentication: personal API key or OAuth access token passed as a bearer
  credential to Linear's hosted MCP server.
- Expected identity: workspace ID and display name.
- Required target: team.
- Provider operations use a fixed allowlist of hosted Linear MCP issue tools;
  the wider upstream tool catalog is never proxied to agents.
- Project policy: one explicit project, an explicit multi-project selection,
  `none` for unprojected issues, or `any` for all projected and unprojected
  issues in the configured team.
- Search, direct lookup, and mutation revalidation reject issues outside the
  configured team/project policy. `any` relaxes only project membership and
  never team membership.
- Creation under `any` sets the configured team and leaves the new issue
  unprojected.
- A multi-project selection restricts reads and mutations to its `include`
  list and creates issues in its required `create_in` project.
- Multi-project lists fan out by stable project ID, merge and deduplicate by
  issue identifier, and use bounded pagination. `none` lists the configured
  team and removes projected issues before returning content.
- User discovery returns active members of the configured team and uses the
  Linear user ID as `assignee`.
- Capabilities return team labels, Linear's canonical numeric priorities,
  team cycles, and project milestones where the target has an exact creation
  project. Option search narrows those target-scoped catalogs. Generic issue
  types remain unsupported.
- Create and update support due dates, estimates, cycles, milestones,
  target-scoped parents, and blocking/related/duplicate relationships. Removing
  a parent, cycle, due date, estimate, or duplicate uses `null`; relationship
  removals use `removeBlocks`, `removeBlockedBy`, and `removeRelatedTo`.
- Direct subissue listing validates `parent` before applying the upstream
  parent filter. Archived issues require an explicit `includeArchived` opt-in.
- Relation-expanded reads validate every related issue before returning any
  relation content. Comment replies and edits validate that the referenced
  comment belongs to the target issue and fail closed at the pagination bound.
- SLA fields are not part of the provider-neutral field set or hosted MCP input
  allowlist.
- Canonical states require explicit project mappings.
- Issue URLs are added through comments when a native relation is unavailable.
- Direct issue reads are revalidated before comments or mutations. Upstream
  response drift and missing required MCP tools fail closed.

## GitHub Issues

- Authentication: token from a command, keychain, file, or environment.
- Expected identity: login and host.
- Required target: explicit repository or `inherit` from a GitHub source repo.
- Optional narrower target: a GitHub Projects v2 node ID and stable Status field
  node ID. Reads and mutations then reject repository issues outside that
  Project.
- Project lists ignore pull requests, draft items, and issue items belonging to
  other repositories. Collection is bounded to ten 100-item pages and reports
  truncation at that boundary.
- Creating an issue adds its GraphQL node to the configured Project. Project
  Status drives canonical workflow filtering and transitions; the underlying
  issue lifecycle is synchronized to open, completed, or not planned.
- Pull requests returned through issue-shaped APIs are always excluded.
- User discovery uses the repository's available issue assignees and returns
  the GitHub login as `assignee`.
- Capabilities return repository labels, milestones, and repository-enabled
  issue types. Repositories without issue types report that field as
  unsupported. Priority remains unsupported.
- Option search scans repository labels, issue types, or milestones and reports
  truncation when a bounded catalog is incomplete.
- Create and update accept issue types and milestones returned by capability or
  option discovery. Updates can clear either field with `null`.
- Native parent/subissue, blocking/blocked-by, and duplicate relationships are
  supported. Direct subissue listing validates the parent, and relation-expanded
  reads return parent, direct subissues, dependencies, and the canonical
  duplicate only after every reference passes repository and optional Project
  target validation.
- Relationship writes re-resolve every referenced issue during apply. Parent
  replacement and removal use GitHub's subissue endpoints; dependency removal
  uses `removeBlocks` or `removeBlockedBy`; duplicate removal uses GitHub's
  native unmark operation.
- Existing comments can be edited only after their `issue_url` proves ownership
  by the target issue. GitHub comments are flat, so threaded replies remain
  unsupported.
- Generic `relatedTo`, custom priority/due-date/estimate/cycle mappings, and
  archived issue semantics remain unsupported.
- Without a Project target, native states are `open` and `closed` and
  `in_progress` requires configured labels. With a Project target, native states
  are Status option names and `Canceled` represents GitHub's `not_planned`
  closure reason.
- No pull-request, release, or repository-administration operations are exposed.

## Jira Cloud

- Authentication: account email plus API token.
- Expected identity: site and account ID.
- Required target: Jira project.
- Search, direct lookup, and mutation revalidation reject issues outside the
  configured project target.
- User discovery uses Jira's project-assignable user search and returns the
  account ID as `assignee`.
- Capabilities return project issue types and project-available priorities;
  labels accept custom values.
- Option search uses only project-available priorities and creatable issue
  types. Jira label discovery is intentionally unsupported because Jira exposes
  a site-global label catalog rather than a project-scoped catalog.
- Canonical state mappings resolve to one uniquely named available transition.
- Jira Server and Data Center are unsupported.

## Shared operations

Adapters expose provider-neutral list/read/search, create, update, comment,
transition, close/reopen, and related-link operations where the provider
supports them. Permanent deletion is never exposed. Unsupported native features
produce a capability error rather than an approximation.

Providers use the generic create/update field map only for capabilities they
advertise. Linear supports `parent`, planning fields, all three relationship
directions, duplicates, and explicit removals. GitHub supports `issueType`,
`milestone`, `parent`, blocking relationships, duplicates, and explicit blocker
removals. The generic comment operation accepts either `comment_id` for an edit
or `parent_comment_id` for a reply. These modes are mutually exclusive;
GitHub supports edits but not replies.

`search_issues` accepts title/description text. It is not a status or structured
filter. `list_issues` accepts optional canonical status filters, returns both
the provider-native `status` and normalized `canonicalStatus`, and orders each
provider group by most recently updated. Omitted statuses list all workflow
states; unclassifiable results have `canonicalStatus: null`. Each group reports
`truncated` when more results exist beyond its per-provider limit.

`list_users` and `search_users` return only active users assignable within the
configured issue target. Each result includes a provider-native `assignee`
value that can be passed unchanged to issue creation or updates, plus the
display name and any username or email the provider exposes. User search
matches those available identity fields. Callers must present multiple matches
for selection rather than guessing a user.

Issue snapshots include normalized assignee and creator identities, priority,
issue type, creation time, due date, estimate, cycle, milestone, archive time,
and opt-in relations. Expanded relations include the parent, direct subissues,
blocking directions, related issues, and canonical duplicate. Unsupported,
absent, or unrequested values are `null` or an empty relation array.
The assignee object includes the exact provider-native `assignee` value accepted
by issue creation and updates.

`get_issue_capabilities` returns supported fields and exact reusable options
for the configured target. It also overlays host-configured canonical statuses,
required creation fields, defaults, and named presets. Preset template names
are returned, but template contents are not. Agents must not infer support from
an empty option list: `operations`, `acceptsCustomValues`, `defaultValue`, and
`discoveryTool` are authoritative. Inline option catalogs are bounded to 100;
`optionsTruncated: true` means callers must not treat the catalog as complete.

`search_issue_options` narrows reusable `labels`, `priority`, `issueType`,
`cycle`, or `milestone` values inside the configured provider target. Returned
values are opaque and must be passed unchanged. Results are bounded to 100 and
include `truncated`;
an incomplete result is never evidence that an option is invalid. Providers
return `ISSUE_OPTION_FIELD_UNSUPPORTED` when a field has no safe searchable
catalog. Capability `discoveryTool: search_issue_options` identifies fields
that support this operation.
