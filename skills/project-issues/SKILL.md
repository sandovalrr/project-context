---
name: project-issues
description: Resolve repository-specific issue context and safely read or change Linear, GitHub Issues, and Jira Cloud issues through the provider-neutral project_issues MCP server or project-context CLI. Use whenever work involves listing, searching, reading, creating, updating, commenting on, transitioning, closing, reopening, or linking issues. Do not use for pull requests, releases, repository administration, or local Git configuration.
---

# Project Issues

Use the host-local project registry to select the correct issue workspace, account, and project for the current Git repository. Treat the configured context as authoritative for external issue writes.

## Resolve Context First

1. Call `resolve_project_context` once when issue work begins.
2. Resolve again when the working repository changes or when configuration is edited.
3. State the selected provider, target, and authenticated identity before preparing a write.
4. Stop before a write if the repository, provider, credential, or identity is not configured or does not match.

Use `project-context resolve --cwd <path>` only when the `project_issues` MCP tools are unavailable.

## Route Deterministically

Provider selection follows this order:

1. An explicit issue URL.
2. A qualified reference such as `linear:ENG-123`, `github:#318`, or `jira:OPS-42`.
3. One unique configured identifier pattern.
4. The configured default provider.

Never infer a provider from issue wording. Never retry a failed provider operation against another provider. List and search only the default provider unless the user explicitly names a provider or requests all configured providers.

## Read Issues

- Use `list_issues` for canonical status filters, `search_issues` only for title/description text, and `get_issue` for a single issue.
- Never simulate status filtering by searching for text such as "in progress".
- Treat `truncated: true` as incomplete. Surface missing or ambiguous mapping errors instead of weakening the requested filter.
- For an unconfigured repository, explain that host-local context is missing. Conversational or explicitly supplied context may support a read, but do not treat it as write authorization.
- GitHub pull requests are outside this skill even though the GitHub Issues API can return them.

## Resolve Assignees

- Use `search_users` when the user names or describes an assignee. Use `list_users` when they ask who can be assigned or when no useful search text is available.
- Treat the returned `assignee` field as opaque provider-native data. Pass it unchanged in the `assignee` field of a prepared create or update.
- If no users match, say so. If multiple users plausibly match, show the available display name, username, and email and ask the user to choose. Never guess based on name similarity.
- Results are restricted to active users assignable within the configured issue target. Treat `truncated: true` as incomplete and narrow the search before assigning.

## Write Issues Safely

All external writes use two phases:

1. Call `prepare_issue_change` with the complete intended change.
2. Show the provider, identity, target issue or creation target, changed fields, and expiry from the preview.
3. Wait for explicit user approval of that preview.
4. Call `apply_issue_change` with the returned token.

Never call `apply_issue_change` without a preview from the same conversation. Tokens expire after ten minutes and become invalid when repository, Git root, configuration, credential identity, or issue version changes. If invalidated, prepare a new preview and ask again.

Creation presets are opt-in. An agent may recommend one but must not select it silently. Bulk changes require a separate preview and approval for each batch; do not turn many individual approvals into implied bulk approval.

Supported writes are create, update, comment, transition, close, reopen, and link. Permanent issue deletion is unsupported.

## Protect Credentials and Scope

- Never request, print, log, or place API tokens in issue content, command arguments, project files, or prompts.
- Direct the user to `project-context credential add <alias>` for hidden terminal entry.
- Configuration and credentials are host-local under `~/.agents/config/project-context/`; do not add them to a repository.
- Keep work limited to issues. Do not manage pull requests, releases, repository settings, Git identities, SSH keys, or provider administration.

Read [configuration.md](references/configuration.md) only when configuring or troubleshooting a host. Read [cli.md](references/cli.md) only when MCP tools are unavailable.
