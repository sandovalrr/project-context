# Host-local configuration

The default host layout is:

```text
~/.agents/config/project-context/projects.yaml
~/.agents/config/project-context/credentials.yaml
~/.agents/config/project-context/templates/
~/.agents/config/project-context/secrets/
~/.local/state/project-context/
```

Run `project-context setup` to create missing starter files without overwriting existing files. Run `project-context config validate` and `project-context doctor --cwd <repository>` after changes.

The project registry uses schema version 2. Run `project-context config migrate`
to preview an older host configuration and `project-context config migrate
--apply` to create a backup and upgrade it explicitly.

The project registry is keyed by normalized Git remote, such as `github.com/example/example-repository`. Provider profiles bind expected identities to credential aliases. Project entries select a default provider and provider-specific targets. Use stable provider IDs as authoritative values and names only as display metadata.

A Linear target requires a team plus a project policy. Use an `{id, name}`
object for one project, an `{include, create_in}` object for an explicit set of
projects, `none` for only unprojected issues, or `any` for every projected and
unprojected issue in that team. Multi-project `include` entries use stable IDs;
`create_in` is required and must name one of those IDs. `any` does not include
other teams, and creation through it leaves the new issue unprojected.

Use the repository's `examples/` and `schemas/` directories for starter YAML and validation details. Never copy real tokens into example files.

Canonical list filters use `mappings.status`. Add an explicit provider-neutral
`match` with `state` or `states`, `labels_all`, and `labels_none` when transition
mappings overlap. `doctor` reports missing or ambiguous list mappings.

A GitHub provider may add `target.project` with stable `id` and
`status_field.id` values plus display metadata. That narrows all issue reads and
writes to issue items in the configured GitHub Project. Project Status names
become native workflow states; new issues are added to the Project.
