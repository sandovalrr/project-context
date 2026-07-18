# Installation and client integration

Build and install the executable plus shared agent skill for the current user:

```sh
bun run install:user
```

This installs:

```text
~/.local/bin/project-context
~/.agents/skills/project-issues -> <checkout>/skills/project-issues
```

It also runs the non-destructive host setup. Missing starter configuration files are created, while existing configuration is left untouched.

## MCP client configuration

The project does not edit a particular agent client's settings. Obtain the client-neutral stdio manifest with:

```sh
project-context integration manifest
```

The equivalent configuration is:

```yaml
name: project_issues
command: ~/.local/bin/project-context
args: [mcp]
transport: stdio
```

Add those values using the MCP configuration mechanism supported by the chosen local agent client. The shared skill is implicitly invocable and tells an agent to resolve repository context before issue work.

## Shell completion

The executable can generate completion definitions for the active shell:

```sh
project-context completion
```

Follow the instructions in the generated script for the chosen shell. Use
`project-context <command> --help` to inspect nested commands and provider-safe
options. Commands emit plain JSON when redirected or when `--json` is used.
