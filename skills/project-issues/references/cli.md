# CLI fallback

Use these commands only when the provider-neutral MCP server is unavailable.

```text
project-context resolve --cwd <path>
project-context issue list [--status <canonical-status> ...] [--provider <alias> | --all]
project-context issue search <query> [--provider <alias> | --all]
project-context issue get <reference> [--provider <alias>]
project-context issue prepare create --title <title> [--description <text>] [--preset <name>]
project-context issue prepare update --ref <reference> --title <title>
project-context issue prepare comment --ref <reference> --body <text>
project-context issue prepare transition --ref <reference> --status <canonical-status>
project-context issue prepare close|reopen --ref <reference>
project-context issue prepare link --ref <reference> --url <issue-url>
project-context issue apply <preview-token>
```

The CLI prints JSON. Treat a successful `prepare` response as a preview, not permission to apply it. Show the preview and wait for explicit approval before `apply`.

Use `project-context <command> --help` for generated nested help and
`project-context completion` for shell completion. Pass `--json` when a plain,
machine-readable response is required explicitly.
