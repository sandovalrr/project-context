import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { applyIssueOperation, prepareIssueOperation } from "../src/core/operations.ts";
import { getPaths } from "../src/core/paths.ts";
import { setupHostConfiguration } from "../src/core/setup.ts";
import { withTemporaryDirectory } from "./helpers/temporary.ts";

afterEach(async () => {
  delete process.env.PROJECT_CONTEXT_CONFIG_DIR;
  delete process.env.PROJECT_CONTEXT_STATE_DIR;
  delete process.env.TEST_GITHUB_TOKEN;
});

function mockFetch(responses: unknown[]) {
  const sequence = responses.values();
  const fetcher = mock(async (url: string | URL | Request) => {
    const next = sequence.next();
    if (next.done) throw new Error(`unexpected request ${url}`);
    return new Response(JSON.stringify(next.value), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  return fetcher as unknown as typeof fetch;
}

async function withFixture<T>(work: (repository: string) => Promise<T>): Promise<T> {
  return withTemporaryDirectory("project-context-operations-", async (directory) => {
    process.env.PROJECT_CONTEXT_CONFIG_DIR = join(directory, "config");
    process.env.PROJECT_CONTEXT_STATE_DIR = join(directory, "state");
    process.env.TEST_GITHUB_TOKEN = "token";
    await setupHostConfiguration();
    const repository = join(directory, "repository");
    Bun.spawnSync(["git", "init", "-q", repository]);
    Bun.spawnSync([
      "git",
      "-C",
      repository,
      "remote",
      "add",
      "origin",
      "git@github.com:example/example-repository.git",
    ]);
    await writeFile(
      getPaths().projectsFile,
      `version: 1
providers:
  github-example:
    type: github
    credential: github-example
    expected_identity:
      login: example-user
      host: github.com
projects:
  github.com/example/example-repository:
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
              done: closed
`,
    );
    await writeFile(
      getPaths().credentialsFile,
      `version: 1
credentials:
  github-example:
    fields:
      token:
        source: environment
        variable: TEST_GITHUB_TOKEN
`,
    );
    return work(repository);
  });
}

const issue = {
  id: 10,
  number: 3,
  title: "Example issue",
  body: "Description",
  state: "open",
  labels: [],
  html_url: "https://github.com/example/example-repository/issues/3",
  updated_at: "2026-07-18T10:00:00Z",
};

describe("issue write workflow", () => {
  test("previews, revalidates, applies, consumes, and audits without issue content", async () => {
    await withFixture(async (repository) => {
      const fetcher = mockFetch([
        { id: 1, login: "example-user" },
        issue,
        { id: 1, login: "example-user" },
        issue,
        {},
        { ...issue, updated_at: "2026-07-18T10:01:00Z" },
      ]);

      const preview = await prepareIssueOperation(
        { operation: "comment", identifier: "github:#3", body: "sensitive-comment-body" },
        { cwd: repository, fetcher },
      );
      expect(preview).toMatchObject({ providerAlias: "github", operation: "comment" });
      expect(preview.target?.identifier).toBe("#3");

      const result = await applyIssueOperation(preview.token, { cwd: repository, fetcher });
      expect(result.identifier).toBe("#3");
      const calls = (fetcher as unknown as ReturnType<typeof mock>).mock.calls;
      expect(calls.filter(([url]) => String(url).endsWith("/user"))).toHaveLength(2);
      await expect(
        applyIssueOperation(preview.token, { cwd: repository, fetcher }),
      ).rejects.toThrow("not found");
      const audit = await readFile(getPaths().auditFile, "utf8");
      expect(audit).toContain('"outcome":"success"');
      expect(audit).not.toContain("sensitive-comment-body");
    });
  });

  test("rejects fields the selected provider would silently ignore", async () => {
    await withFixture(async (repository) => {
      const fetcher = mockFetch([{ id: 1, login: "example-user" }]);

      await expect(
        prepareIssueOperation(
          { operation: "create", input: { title: "Example", priority: "high" } },
          { cwd: repository, fetcher },
        ),
      ).rejects.toThrow("not supported for github");
    });
  });

  test("preserves indeterminate state when a successful provider write cannot be audited", async () => {
    await withFixture(async (repository) => {
      const fetcher = mockFetch([
        { id: 1, login: "example-user" },
        issue,
        { id: 1, login: "example-user" },
        issue,
        {},
        { ...issue, updated_at: "2026-07-18T10:01:00Z" },
      ]);
      const preview = await prepareIssueOperation(
        { operation: "comment", identifier: "github:#3", body: "comment" },
        { cwd: repository, fetcher },
      );
      await mkdir(getPaths().auditFile);

      await expect(
        applyIssueOperation(preview.token, { cwd: repository, fetcher }),
      ).rejects.toThrow("regular mode-0600 file");
      await expect(
        applyIssueOperation(preview.token, { cwd: repository, fetcher }),
      ).rejects.toThrow("indeterminate");
    });
  });
});
