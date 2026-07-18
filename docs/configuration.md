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

The initial migration path treats an otherwise valid unversioned registry (or
one declaring `version: 0`) as version 0 and adds `version: 1`. Preview reports
both affected files without writing. Apply reacquires the configuration lock,
re-reads and validates both registries, backs them up, and replaces each file
through a mode-`0600` temporary file.

## Project registry

`projects.yaml` contains routing and expected identity, never credentials.
Provider IDs are authoritative; names are display metadata. A sanitized,
complete starting point is in `examples/projects.example.yaml`.

```yaml
version: 1

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
              open: open
              in_progress:
                state: open
                add_labels: [in-progress]
              done: closed
              canceled: closed
```

Linear requires a team and an explicit project object or `none`. Jira Cloud
requires a project ID/name. A GitHub target can be `inherit` for a GitHub source
repository or an explicit `{id, owner, name}` object. A Bitbucket repository may
route to any supported issue provider.

Run `project-context config validate` after every edit. Run
`project-context doctor --cwd /path/to/repository` to also verify permissions,
routing, and the active account.

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
