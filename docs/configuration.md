# Configuration

## Locations

```text
~/.agents/config/project-context/projects.yaml
~/.agents/config/project-context/credentials.yaml
~/.agents/config/project-context/templates/
~/.agents/config/project-context/secrets/
```

Override the configuration directory with `PROJECT_CONTEXT_CONFIG_DIR`.

Both YAML documents use an explicit schema version. Unsupported provider types
invalidate the complete configuration. Newer schema versions are rejected;
older versions require an explicit, previewed `project-context config migrate`.

## Project registry

`projects.yaml` contains no credentials. Provider IDs are authoritative and
names are display metadata. `project-context doctor` detects renamed or
inaccessible resources and offers a previewed name refresh; it never substitutes
another resource with the same name.

```yaml
version: 1

providers:
  linear-example:
    type: linear
    credential: linear-example
    expected_identity:
      workspace:
        id: 98b7d4a0-0000-4000-8000-000000000001
        name: Example Workspace

  github-personal:
    type: github
    credential: github-personal
    expected_identity:
      login: example-user
      host: github.com

projects:
  github.com/example-user/example:
    aliases:
      remotes: []
      paths: []

    issues:
      default: linear
      providers:
        linear:
          type: linear
          profile: linear-example
          identifiers:
            - '^ENG-[0-9]+$'
          target:
            team:
              id: 98b7d4a0-0000-4000-8000-000000000002
              name: Engineering
            project:
              id: 98b7d4a0-0000-4000-8000-000000000003
              name: Platform
          mappings:
            status:
              open: Backlog
              in_progress: In Progress
              done: Done
              canceled: Canceled
          create:
            required: [title, description]
            defaults:
              priority: medium
              labels: [engineering]
            presets:
              bug:
                labels: [bug]
                priority: high
                template: bug-report

        github:
          type: github
          profile: github-personal
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

When Linear intentionally has no project, declare it explicitly:

```yaml
target:
  team:
    id: team-id
    name: Engineering
  project: none
```

A GitHub Issues target may differ from the source repository:

```yaml
target:
  repository:
    id: github.com/acme/platform-issues
    owner: acme
    name: platform-issues
```

## Credential registry

`credentials.yaml` maps aliases to field resolvers. `project-context credential
add` owns creation and replacement; manual secret entry in YAML is unsupported.

```yaml
version: 1

credentials:
  linear-example:
    fields:
      token:
        source: file
        path: ~/.agents/config/project-context/secrets/linear-example

  github-personal:
    fields:
      token:
        source: command
        command: [gh, auth, token, --hostname, github.com]

  jira-example:
    fields:
      email:
        source: literal
        value: developer@example.com
      token:
        source: keychain
        service: project-context/jira-example
        account: developer@example.com
```

Secret commands run without a shell. Output is trimmed, held only in memory,
and redacted from errors. Environment-backed secrets are supported for CI and
temporary sessions but are not the default.

## Safe updates

All configuration writes acquire a lock, validate the complete result, create a
timestamped backup, and replace atomically. The CLI never commits, pulls, pushes,
or otherwise synchronizes configuration through Git.

