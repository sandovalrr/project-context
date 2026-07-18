import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyIssueOperation, prepareIssueOperation } from "../src/core/operations.ts";
import { getPaths } from "../src/core/paths.ts";
import { setupHostConfiguration } from "../src/core/setup.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  delete process.env.PROJECT_CONTEXT_CONFIG_DIR;
  delete process.env.PROJECT_CONTEXT_STATE_DIR;
  delete process.env.TEST_GITHUB_TOKEN;
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

function mockFetch(responses: unknown[]) {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(url), ...(init ? { init } : {}) });
    const body = responses.shift();
    if (body === undefined) throw new Error(`unexpected request ${url}`);
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  return { fetcher, requests };
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "project-context-operations-"));
  temporaryDirectories.push(directory);
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
  return { repository };
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
    const { repository } = await fixture();
    const { fetcher, requests } = mockFetch([
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
    expect(requests.filter((request) => request.url.endsWith("/user"))).toHaveLength(2);
    await expect(applyIssueOperation(preview.token, { cwd: repository, fetcher })).rejects.toThrow(
      "not found",
    );
    const audit = await readFile(getPaths().auditFile, "utf8");
    expect(audit).toContain('"outcome":"success"');
    expect(audit).not.toContain("sensitive-comment-body");
  });

  test("rejects fields the selected provider would silently ignore", async () => {
    const { repository } = await fixture();
    const { fetcher } = mockFetch([{ id: 1, login: "example-user" }]);

    await expect(
      prepareIssueOperation(
        { operation: "create", input: { title: "Example", priority: "high" } },
        { cwd: repository, fetcher },
      ),
    ).rejects.toThrow("not supported for github");
  });
});
