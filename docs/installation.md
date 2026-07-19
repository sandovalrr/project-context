# Installation and MCP clients

## Requirements and version pinning

Use Node.js 22 or newer on Linux or macOS. The npm artifact is a bundled Node
application with no runtime package dependencies. Bun is required only to
develop or release the repository.

The examples below pin `0.1.0`. Replace it with the release you have reviewed.
Pinning makes MCP startup reproducible and avoids silently executing a newly
published version.

Run host setup once:

```sh
VERSION=0.1.0
npx -y --package="@sandovalrr/project-context-mcp@$VERSION" project-context setup
```

`setup` is non-interactive and idempotent: it creates only missing files with
user-only permissions and repairs directory permissions. It does not alter an
existing file; validation and `doctor` reject an unsafe existing mode rather
than silently changing it. `setup --guided` additionally asks for a provider
profile and emits non-secret YAML-shaped snippets. It never asks for an API
token. Add secrets separately with a file, environment variable, keychain
resolver, or hidden terminal entry.

Validate before connecting an agent:

```sh
npx -y --package="@sandovalrr/project-context-mcp@$VERSION" project-context config migrate
npx -y --package="@sandovalrr/project-context-mcp@$VERSION" project-context config validate
npx -y --package="@sandovalrr/project-context-mcp@$VERSION" project-context doctor
```

If migration reports pending files, review the preview and rerun it with
`--apply`. Existing files are backed up before the project registry is upgraded
to schema version 2; credentials remain on schema version 1.

## Shared stdio definition

Every client launches the same local process:

```text
command: npx
args:
  - -y
  - --package=@sandovalrr/project-context-mcp@0.1.0
  - project-context-mcp
transport: stdio
```

The MCP process writes protocol messages to stdout and diagnostics to stderr.
Do not wrap it in a shell command, background it, or attach a remote HTTP
transport. Version 0.1 supports local stdio only.

The CLI can generate the configuration below with the package version already
pinned:

```sh
project-context integration manifest --client codex
project-context integration manifest --client claude
project-context integration manifest --client zed
project-context integration manifest --client vscode
```

Codex output is TOML; the other client outputs are JSON. Without `--client`,
the command prints the provider-neutral manifest and shared skill path. Add
`--json` to a client-specific command when automation needs a stable envelope
with `client`, `format`, and `configuration` fields.

### Working-directory resolution

The server determines repository context in this order:

1. A `cwd` argument passed to a tool.
2. The single filesystem root supplied by the MCP client.
3. `PROJECT_CONTEXT_CWD`.
4. The MCP process working directory.

If a client supplies multiple roots, the tool requires an explicit `cwd`. If
roots are supplied, the selected directory must be inside exactly one root.
This prevents an agent from silently routing issue work through another open
workspace.

## Codex

Add this user-level entry to `~/.codex/config.toml`, or place it in a trusted
repository's `.codex/config.toml` when it should be project-specific:

```toml
[mcp_servers.project_issues]
enabled = true
required = true
command = "npx"
args = [
  "-y",
  "--package=@sandovalrr/project-context-mcp@0.1.0",
  "project-context-mcp",
]
startup_timeout_sec = 20
tool_timeout_sec = 60
```

If the client does not supply a usable root, add a non-secret fallback:

```toml
[mcp_servers.project_issues.env]
PROJECT_CONTEXT_CWD = "/absolute/path/to/repository"
```

Restart Codex, then use `/mcp` or `codex mcp list` to confirm that
`project_issues` is active. Keep provider tokens out of `config.toml`; prefer
the credential resolvers documented in `configuration.md`.

## Claude Code and Claude Desktop

Claude Code can register the server at user scope:

```sh
claude mcp add-json --scope user project_issues \
  '{"type":"stdio","command":"npx","args":["-y","--package=@sandovalrr/project-context-mcp@0.1.0","project-context-mcp"]}'
claude mcp get project_issues
```

For Claude Desktop, add the equivalent entry to its user configuration and
restart the application:

```json
{
  "mcpServers": {
    "project_issues": {
      "command": "npx",
      "args": [
        "-y",
        "--package=@sandovalrr/project-context-mcp@0.1.0",
        "project-context-mcp"
      ]
    }
  }
}
```

Use user scope unless you intentionally want to commit a project MCP
configuration. Host-local routing already selects the correct project without
placing mappings or account details in the repository.

## Zed

Open **Settings → AI → MCP Servers → Add Server → Add Local Server**, or edit
the user settings file:

```json
{
  "context_servers": {
    "project_issues": {
      "command": "npx",
      "args": [
        "-y",
        "--package=@sandovalrr/project-context-mcp@0.1.0",
        "project-context-mcp"
      ],
      "env": {}
    }
  }
}
```

The MCP Servers page should show a green active indicator. For a Zed remote
project, configure the server in the environment where `npx`, the Git checkout,
and host-local project-context configuration are available. Do not point a
local MCP process at credential files that exist only on the remote host.

## VS Code

Run **MCP: Open User Configuration** and add:

```json
{
  "servers": {
    "project_issues": {
      "type": "stdio",
      "command": "npx",
      "args": [
        "-y",
        "--package=@sandovalrr/project-context-mcp@0.1.0",
        "project-context-mcp"
      ]
    }
  }
}
```

User configuration avoids committing host-specific data. A workspace
`.vscode/mcp.json` is also supported, but should contain only the generic
command; keep credentials and repository mappings outside the workspace. In a
Remote SSH or dev-container window, configure and run the MCP server in that
remote environment.

## Optional agent skill

The package includes a provider-neutral skill that instructs compatible agents
to resolve context first and require explicit approval between preview and
apply. Installation is always explicit:

```sh
npx -y --package="@sandovalrr/project-context-mcp@0.1.0" project-context skill status
npx -y --package="@sandovalrr/project-context-mcp@0.1.0" project-context skill install
```

If status reports `outdated` or `unmanaged`, inspect the existing directory.
`skill install --replace` backs it up before copying the packaged version.

## Troubleshooting

- `CONFIG_NOT_FOUND`: run `project-context setup`; MCP startup itself never
  creates files.
- `INTERACTIVE_TERMINAL_REQUIRED`: run guided setup or credential entry in a
  real terminal, not through an MCP tool.
- Ambiguous roots: pass an explicit absolute `cwd` inside one client root.
- Identity mismatch: authenticate the configured account; never weaken
  `expected_identity` to make another account pass.
- Client starts then exits: inspect the client's MCP stderr log and confirm
  Node 22+, `npx`, and the pinned package version are available.
