import { describe, expect, test } from "bun:test";
import packageMetadata from "../package.json" with { type: "json" };

const packageArgument = `--package=${packageMetadata.name}@${packageMetadata.version}`;

function cli(...args: string[]) {
  return Bun.spawnSync(["bun", "src/cli.ts", ...args], {
    cwd: import.meta.dir.replace(/\/tests$/, ""),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, NO_COLOR: "1" },
  });
}

describe("CLI usability", () => {
  test("generates structured top-level and nested help", () => {
    const top = cli("--help");
    expect(top.exitCode).toBe(0);
    expect(top.stdout.toString()).toContain("project-context issue");
    expect(top.stdout.toString()).toContain("project-context audit");
    expect(top.stdout.toString()).toContain("project-context skill");
    expect(top.stdout.toString()).toContain("project-context completion");
    expect(top.stderr.toString()).toBe("");

    const prepare = cli("issue", "prepare", "--help");
    expect(prepare.exitCode).toBe(0);
    expect(prepare.stdout.toString()).toContain("--clear-assignee");
    expect(prepare.stdout.toString()).toContain("--issue-type");
    expect(prepare.stdout.toString()).toContain("--clear-issue-type");
    expect(prepare.stdout.toString()).toContain("--clear-milestone");
    expect(prepare.stdout.toString()).toContain("--parent-comment-id");
    expect(prepare.stdout.toString()).toContain("--due-date");
    expect(prepare.stdout.toString()).toContain("--blocks");

    const list = cli("issue", "list", "--help");
    expect(list.exitCode).toBe(0);
    expect(list.stdout.toString()).toContain("--status");
    expect(list.stdout.toString()).toContain("--all");
    expect(list.stdout.toString()).toContain("--limit");
    expect(list.stdout.toString()).toContain("--include-archived");
    expect(list.stdout.toString()).toContain("--parent");

    const get = cli("issue", "get", "--help");
    expect(get.exitCode).toBe(0);
    expect(get.stdout.toString()).toContain("--include-relations");

    const users = cli("issue", "user", "--help");
    expect(users.exitCode).toBe(0);
    expect(users.stdout.toString()).toContain("list");
    expect(users.stdout.toString()).toContain("search");

    const capabilities = cli("issue", "capabilities", "--help");
    expect(capabilities.exitCode).toBe(0);
    expect(capabilities.stdout.toString()).toContain("--provider");
    expect(capabilities.stdout.toString()).toContain("--all");

    const comments = cli("issue", "comment", "list", "--help");
    expect(comments.exitCode).toBe(0);
    expect(comments.stdout.toString()).toContain("<reference>");
    expect(comments.stdout.toString()).toContain("--limit");

    const options = cli("issue", "option", "search", "--help");
    expect(options.exitCode).toBe(0);
    expect(options.stdout.toString()).toContain("<field>");
    expect(options.stdout.toString()).toContain("<query>");
    expect(options.stdout.toString()).toContain("--limit");
  });

  test("rejects conflicting options as machine-readable JSON", () => {
    const result = cli("issue", "search", "example", "--all", "--provider", "github", "--json");
    expect(result.exitCode).toBe(1);
    const error = JSON.parse(result.stderr.toString());
    expect(error).toMatchObject({ error: "CLI_USAGE" });
    expect(error.message).toContain("mutually exclusive");
  });

  test("generates shell completion support", () => {
    const result = cli("completion");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("project-context");
  });

  test("emits version-pinned native manifests for supported MCP clients", () => {
    const generic = cli("integration", "manifest", "--json");
    const codex = cli("integration", "manifest", "--client", "codex");
    const claude = cli("integration", "manifest", "--client", "claude");
    const zed = cli("integration", "manifest", "--client", "zed");
    const vscode = cli("integration", "manifest", "--client", "vscode");

    expect(generic.exitCode).toBe(0);
    expect(JSON.parse(generic.stdout.toString())).toMatchObject({
      mcp: {
        command: "npx",
        args: ["-y", packageArgument, "project-context-mcp"],
      },
    });

    expect(codex.exitCode).toBe(0);
    expect(codex.stdout.toString()).toContain("[mcp_servers.project_issues]");
    expect(codex.stdout.toString()).toContain(JSON.stringify(packageArgument));

    expect(claude.exitCode).toBe(0);
    expect(JSON.parse(claude.stdout.toString())).toMatchObject({
      mcpServers: { project_issues: { command: "npx" } },
    });

    expect(zed.exitCode).toBe(0);
    expect(JSON.parse(zed.stdout.toString())).toMatchObject({
      context_servers: { project_issues: { command: "npx" } },
    });

    expect(vscode.exitCode).toBe(0);
    expect(JSON.parse(vscode.stdout.toString())).toMatchObject({
      servers: { project_issues: { type: "stdio", command: "npx" } },
    });
  });

  test("wraps a native client manifest when machine-readable output is requested", () => {
    const result = cli("integration", "manifest", "--client", "codex", "--json");

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout.toString())).toMatchObject({
      client: "codex",
      format: "toml",
      configuration: expect.stringContaining("[mcp_servers.project_issues]"),
    });
  });
});
