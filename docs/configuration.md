# Configuration

## Host-local locations

```text
~/.agents/config/project-context/projects.yaml
~/.agents/config/project-context/credentials.yaml
~/.agents/config/project-context/templates/
~/.agents/config/project-context/secrets/
~/.local/state/project-context/
```

Override the first root with `PROJECT_CONTEXT_CONFIG_DIR` and the state root
with `PROJECT_CONTEXT_STATE_DIR`. Both should be absolute, user-controlled
paths. Directories are mode `0700`; configuration, secrets, pending changes,
keys, and audit files are mode `0600`. Symlinks and broader permissions on
security-sensitive files fail closed.

Both YAML registries use an explicit schema version. A newer version is
rejected. `project-context config migrate` previews an available migration;
`--apply` is required for atomic replacement and timestamped backup. Startup
never migrates configuration.

The current project registry schema is version 2; the credential registry
remains version 1. Migration upgrades an unversioned or version-1 project
registry to version 2 and an unversioned credential registry to version 1.
Preview reports affected files without writing. Apply reacquires the
configuration lock, re-reads and validates both registries, backs them up, and
replaces each file through a mode-`0600` temporary file.

## Project registry

`projects.yaml` contains routing and expected identity, never credentials.
Provider IDs are authoritative; names are display metadata. A sanitized,
complete starting point is in `examples/projects.example.yaml`.

```yaml
version: 2

providers:
  github-example:
    type: github
    credential: github-example
    expected_identity:
      login: example-user
      host: github.com

projects:
  github.com/example/example-repository:
    aliases:
      remotes: []
      paths: []
    issues:
      default: github
      providers:
        github:
          type: github
          profile: github-example
          target:
            repository: inherit
          mappings:
            status:
              open:
                state: open
                match:
                  state: open
                  labels_none: [in-progress, canceled]
              in_progress:
                state: open
                add_labels: [in-progress]
                remove_labels: [canceled]
                match:
                  state: open
                  labels_all: [in-progress]
                  labels_none: [canceled]
              done:
                state: closed
                remove_labels: [in-progress, canceled]
                match:
                  state: closed
                  labels_none: [canceled]
              canceled:
                state: closed
                add_labels: [canceled]
                remove_labels: [in-progress]
                match:
                  state: closed
                  labels_all: [canceled]
```

Linear requires a team and one explicit project policy:

- An `{id, name}` object includes only that project.
- An `{include, create_in}` object includes several named projects. `create_in`
  is required and must equal one of the included project IDs.
- `none` includes only issues without a project.
- `any` includes projected and unprojected issues across the configured team.

`any` never crosses the configured team boundary. New issues created through an
`any` target are created in the team without an assigned project; project
assignment remains a separate provider-side decision.

```yaml
target:
  team:
    id: 00000000-0000-4000-8000-000000000002
    name: Engineering
  project: any
```

Use stable Linear project IDs for a multi-project selection. Direct reads,
lists, searches, and mutations reject issues outside `include`. New issues are
created in `create_in`; list order never controls issue placement.

```yaml
target:
  team:
    id: 00000000-0000-4000-8000-000000000002
    name: Engineering
  project:
    include:
      - id: 00000000-0000-4000-8000-000000000003
        name: Notifications
      - id: 00000000-0000-4000-8000-000000000004
        name: Conditions
    create_in: 00000000-0000-4000-8000-000000000003
```

Jira Cloud requires a project ID/name. A GitHub target can be `inherit` for a
GitHub source repository or an explicit `{id, owner, name}` object. A Bitbucket
repository may route to any supported issue provider.

GitHub Projects v2 can optionally narrow that repository target further. The
Project and Status field GraphQL node IDs are authoritative; owner, number,
name, and field name are readable metadata. A Project target includes only
issue items from the configured repository. Pull requests and draft items are
ignored.

```yaml
target:
  repository: inherit
  project:
    id: PVT_example
    owner: example-organization
    number: 9
    name: UI Team
    status_field:
      id: PVTSSF_example
      name: Status
mappings:
  status:
    open:
      state: Ready for Dev
      match:
        states: [Idea, In Requirements, Ready for Dev]
    in_progress:
      state: In Development
      match:
        states: [In Development, In Review, Quality Assurance]
    done: Done
    canceled:
      state: Done
      match:
        state: Canceled
```

For Project targets, the configured Project Status is the native status.
`Canceled` is synthesized when GitHub reports a closed issue with reason
`not_planned`; it does not require a matching Project option. A transition also
synchronizes the underlying issue: `open` and `in_progress` reopen it, `done`
closes it as completed, and `canceled` closes it as not planned.

Run `project-context config validate` after every edit. Run
`project-context doctor --cwd /path/to/repository` to also verify permissions,
routing, the active account, and whether canonical statuses are unambiguously
listable.

Status strings derive a read predicate that matches the same provider-native
state. Object mappings without `match` derive `state`, `labels_all` from
`add_labels`, and `labels_none` from `remove_labels`. Add an explicit `match`
when those derived predicates overlap. Listing fails closed with
`STATUS_MAPPING_MISSING` or `STATUS_FILTER_AMBIGUOUS` rather than weakening a
requested canonical filter.

Use `match.states` when one canonical status represents multiple native
workflow states. `state` and `states` are mutually exclusive within one match.

## Credential registry

`credentials.yaml` contains resolver instructions, not literal tokens. Literal
credential values are invalid.

```yaml
version: 1

credentials:
  linear-example:
    fields:
      token:
        source: file
        path: ~/.agents/config/project-context/secrets/linear-example

  github-example:
    fields:
      token:
        source: command
        command: [gh, auth, token, --hostname, github.com]

  jira-example:
    fields:
      email:
        source: environment
        variable: JIRA_EXAMPLE_EMAIL
      token:
        source: keychain
        service: project-context/jira-example
        account: developer@example.com
```

Resolvers:

- `file`: reads one user-only regular file.
- `environment`: reads a named variable from the MCP process environment.
- `keychain`: reads the local OS credential store.
- `command`: executes an argv array directly, never through a shell.

Command resolvers receive no stdin, time out after ten seconds, and may return
at most 64 KiB. Their stdout and stderr are never included in errors. Use an
absolute executable or a tightly controlled `PATH`; do not point a resolver at
a repository script.

For hidden file-backed token entry:

```sh
project-context credential add linear-example --field token
project-context credential test linear-example
```

Secrets are held only long enough to make a provider request. They are excluded
from previews, errors, diagnostics, audit events, and pending-change files.

## Safe updates and backups

Configuration writes acquire a lock, validate the entire result, create a
timestamped backup, and replace atomically. The CLI never commits, pulls,
pushes, or synchronizes host configuration through Git. Backups and templates
may still contain sensitive organization metadata; protect them like the main
configuration.
