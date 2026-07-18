import { describe, expect, test } from "bun:test";

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
    expect(top.stdout.toString()).toContain("project-context completion");
    expect(top.stderr.toString()).toBe("");

    const prepare = cli("issue", "prepare", "--help");
    expect(prepare.exitCode).toBe(0);
    expect(prepare.stdout.toString()).toContain("--clear-assignee");
    expect(prepare.stdout.toString()).toContain("--issue-type");
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
});
