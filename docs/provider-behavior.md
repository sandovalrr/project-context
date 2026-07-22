# Provider behavior

## Linear

- Authentication: personal API key.
- Expected identity: workspace ID and display name.
- Required target: team.
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
- User discovery returns active members of the configured team and uses the
  Linear user ID as `assignee`.
- Capabilities return team labels and Linear's canonical numeric priorities.
- Option search uses team-filtered label queries and the fixed Linear priority
  catalog. Generic issue types remain unsupported.
- Canonical states require explicit project mappings.
- Issue URLs are added through comments when a native relation is unavailable.

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
- Capabilities return repository labels and explicitly mark priority and generic
  issue type as unsupported.
- Option search scans only repository labels, stops after ten 100-label pages,
  and reports truncation when the bound prevents a complete answer.
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
issue type, creation time, and due date. Unsupported or absent values are
`null`. The assignee object includes the exact provider-native `assignee` value
accepted by issue creation and updates.

`get_issue_capabilities` returns supported fields and exact reusable options
for the configured target. It also overlays host-configured canonical statuses,
required creation fields, defaults, and named presets. Preset template names
are returned, but template contents are not. Agents must not infer support from
an empty option list: `operations`, `acceptsCustomValues`, `defaultValue`, and
`discoveryTool` are authoritative. Inline option catalogs are bounded to 100;
`optionsTruncated: true` means callers must not treat the catalog as complete.

`search_issue_options` narrows reusable `labels`, `priority`, or `issueType`
values inside the configured provider target. Returned values are opaque and
must be passed unchanged. Results are bounded to 100 and include `truncated`;
an incomplete result is never evidence that an option is invalid. Providers
return `ISSUE_OPTION_FIELD_UNSUPPORTED` when a field has no safe searchable
catalog. Capability `discoveryTool: search_issue_options` identifies fields
that support this operation.
