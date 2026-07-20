import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  applyIssueOperation,
  getIssueCapabilities,
  listIssueComments,
  listIssues,
  listUsers,
  prepareIssueOperation,
  searchIssueOptions,
  searchUsers,
} from "../src/core/operations.ts";
import { getPaths } from "../src/core/paths.ts";
import { setupHostConfiguration } from "../src/core/setup.ts";
import { withTemporaryDirectory } from "./helpers/temporary.ts";

afterEach(async () => {
  delete process.env.PROJECT_CONTEXT_CONFIG_DIR;
  delete process.env.PROJECT_CONTEXT_STATE_DIR;
  delete process.env.TEST_GITHUB_TOKEN;
  delete process.env.TEST_LINEAR_TOKEN;
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

async function withLinearFixture<T>(work: (repository: string) => Promise<T>): Promise<T> {
  return withTemporaryDirectory("project-context-linear-operations-", async (directory) => {
    process.env.PROJECT_CONTEXT_CONFIG_DIR = join(directory, "config");
    process.env.PROJECT_CONTEXT_STATE_DIR = join(directory, "state");
    process.env.TEST_LINEAR_TOKEN = "token";
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
      `version: 2
providers:
  linear-example:
    type: linear
    credential: linear-example
    expected_identity:
      workspace:
        id: workspace-1
        name: Workspace
projects:
  github.com/example/example-repository:
    issues:
      default: linear
      providers:
        linear:
          type: linear
          profile: linear-example
          identifiers: ['^ENG-[0-9]+$']
          target:
            team:
              id: team-1
              name: Engineering
            project: none
`,
    );
    await writeFile(
      getPaths().credentialsFile,
      `version: 1
credentials:
  linear-example:
    fields:
      token:
        source: environment
        variable: TEST_LINEAR_TOKEN
`,
    );
    return work(repository);
  });
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
      `version: 2
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
              open:
                state: open
                match:
                  state: open
                  labels_none: [in-progress]
              in_progress:
                state: open
                add_labels: [in-progress]
                match:
                  state: open
                  labels_all: [in-progress]
              done: closed
          create:
            required: [title, description]
            defaults:
              labels: [triage]
            presets:
              bug:
                labels: [bug]
                template: bug-report
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

describe("issue listing", () => {
  test("lists by canonical status and returns normalized status with truncation metadata", async () => {
    await withFixture(async (repository) => {
      const inProgress = { ...issue, labels: [{ name: "in-progress" }] };
      const fetcher = mockFetch([
        { id: 1, login: "example-user" },
        { total_count: 2, items: [inProgress] },
      ]);

      const result = await listIssues({
        cwd: repository,
        statuses: ["in_progress"],
        limit: 1,
        fetcher,
      });

      expect(result).toEqual([
        {
          providerAlias: "github",
          truncated: true,
          issues: [expect.objectContaining({ identifier: "#3", canonicalStatus: "in_progress" })],
        },
      ]);
      expect(String((fetcher as unknown as ReturnType<typeof mock>).mock.calls[1]?.[0])).toContain(
        "label%3A%22in-progress%22",
      );
    });
  });

  test("lists all statuses when no filter is supplied and returns canonical classification", async () => {
    await withFixture(async (repository) => {
      const fetcher = mockFetch([
        { id: 1, login: "example-user" },
        { total_count: 1, items: [{ ...issue, state: "closed" }] },
      ]);

      const result = await listIssues({ cwd: repository, fetcher });

      expect(result[0]?.issues[0]).toMatchObject({ status: "closed", canonicalStatus: "done" });
      expect(result[0]?.truncated).toBe(false);
    });
  });

  test("rejects conflicting all-provider and explicit-provider routing", async () => {
    await expect(listIssues({ all: true, provider: "github" })).rejects.toMatchObject({
      code: "ROUTING_CONFLICT",
    });
  });
});

describe("assignable user discovery", () => {
  test("lists normalized users from the routed provider", async () => {
    await withFixture(async (repository) => {
      const fetcher = mockFetch([
        { id: 1, login: "example-user" },
        [
          { id: 1, login: "johnsmith" },
          { id: 2, login: "richard" },
        ],
      ]);

      expect(await listUsers({ cwd: repository, limit: 1, fetcher })).toEqual([
        {
          providerAlias: "github",
          users: [expect.objectContaining({ assignee: "johnsmith", provider: "github" })],
          truncated: true,
        },
      ]);
    });
  });

  test("searches assignable users without guessing a single match", async () => {
    await withFixture(async (repository) => {
      const fetcher = mockFetch([
        { id: 1, login: "example-user" },
        [
          { id: 1, login: "johnsmith" },
          { id: 2, login: "johnstone" },
        ],
      ]);

      const result = await searchUsers("john", { cwd: repository, fetcher });

      expect(result[0]?.users).toHaveLength(2);
    });
  });

  test("rejects conflicting routing and invalid limits", async () => {
    await expect(listUsers({ all: true, provider: "github" })).rejects.toMatchObject({
      code: "ROUTING_CONFLICT",
    });
    await expect(searchUsers("john", { limit: 0 })).rejects.toMatchObject({
      code: "LIMIT_INVALID",
    });
  });
});

describe("issue capabilities", () => {
  test("combines provider options with configured statuses and create policy", async () => {
    await withFixture(async (repository) => {
      const fetcher = mockFetch([
        { id: 1, login: "example-user" },
        [
          { id: 1, name: "bug" },
          { id: 2, name: "triage" },
        ],
      ]);

      const result = await getIssueCapabilities({ cwd: repository, fetcher });

      expect(result).toMatchObject([
        {
          providerAlias: "github",
          providerType: "github",
          canonicalStatuses: ["open", "in_progress", "done"],
          create: {
            required: ["title", "description"],
            defaults: { labels: ["triage"] },
            presets: [{ name: "bug", fields: { labels: ["bug"] }, template: "bug-report" }],
          },
        },
      ]);
      const fields = result[0]?.fields ?? [];
      expect(fields.find(({ field }) => field === "description")?.requiredOnCreate).toBe(true);
      expect(fields.find(({ field }) => field === "labels")?.options).toEqual([
        { value: "bug", label: "bug" },
        { value: "triage", label: "triage" },
      ]);
    });
  });

  test("rejects conflicting provider routing", async () => {
    await expect(getIssueCapabilities({ all: true, provider: "github" })).rejects.toMatchObject({
      code: "ROUTING_CONFLICT",
    });
  });
});

describe("issue option discovery", () => {
  test("searches normalized options through the routed provider", async () => {
    await withFixture(async (repository) => {
      const fetcher = mockFetch([
        { id: 1, login: "example-user" },
        [
          { id: 1, name: "triage" },
          { id: 2, name: "triage-needed" },
        ],
      ]);

      expect(
        await searchIssueOptions("labels", "triage", {
          cwd: repository,
          limit: 1,
          fetcher,
        }),
      ).toEqual([
        {
          providerAlias: "github",
          providerType: "github",
          field: "labels",
          options: [{ value: "triage", label: "triage" }],
          truncated: true,
        },
      ]);
    });
  });

  test("rejects empty queries, conflicting routing, and invalid limits", async () => {
    await expect(searchIssueOptions("labels", "  ")).rejects.toMatchObject({
      code: "ISSUE_OPTION_QUERY_REQUIRED",
    });
    await expect(
      searchIssueOptions("labels", "bug", { all: true, provider: "github" }),
    ).rejects.toMatchObject({ code: "ROUTING_CONFLICT" });
    await expect(searchIssueOptions("labels", "bug", { limit: 101 })).rejects.toMatchObject({
      code: "LIMIT_INVALID",
    });
  });
});

describe("issue comment reading", () => {
  test("routes a reference and returns normalized target-scoped comments", async () => {
    await withFixture(async (repository) => {
      const commentedIssue = { ...issue, comments: 1 };
      const fetcher = mockFetch([
        { id: 1, login: "example-user" },
        commentedIssue,
        [
          {
            id: 80,
            body: "A useful comment",
            user: { id: 2, login: "johnsmith" },
            created_at: "2026-07-18T11:00:00Z",
            updated_at: "2026-07-18T11:30:00Z",
            html_url: "https://github.com/example/example-repository/issues/3#issuecomment-80",
          },
        ],
        commentedIssue,
      ]);

      expect(
        await listIssueComments("github:#3", {
          cwd: repository,
          limit: 1,
          fetcher,
        }),
      ).toMatchObject({
        providerAlias: "github",
        providerType: "github",
        issueIdentifier: "#3",
        comments: [{ id: "80", body: "A useful comment", author: { username: "johnsmith" } }],
        truncated: false,
      });
      await expect(readFile(getPaths().auditFile, "utf8")).rejects.toThrow();
    });
  });

  test("rejects invalid comment limits before provider access", async () => {
    await expect(listIssueComments("#3", { limit: 0 })).rejects.toMatchObject({
      code: "LIMIT_INVALID",
    });
    await expect(listIssueComments("#3", { limit: 101 })).rejects.toMatchObject({
      code: "LIMIT_INVALID",
    });
  });
});

const linearIdentity = {
  data: {
    viewer: { id: "user-1", name: "R", email: "r@example.com" },
    organization: { id: "workspace-1", name: "Workspace" },
  },
};

function linearIssue(projectId?: string) {
  return {
    data: {
      issue: {
        id: "issue-1",
        identifier: "ENG-1",
        title: "Example issue",
        description: "Description",
        url: "https://linear.app/workspace/issue/ENG-1",
        updatedAt: "2026-07-18T10:00:00Z",
        state: { id: "state-1", name: "Backlog" },
        labels: { nodes: [] },
        team: { id: "team-1" },
        project: projectId ? { id: projectId } : null,
      },
    },
  };
}

describe("issue write workflow", () => {
  test("refuses to prepare a Linear mutation outside the configured target", async () => {
    await withLinearFixture(async (repository) => {
      const fetcher = mockFetch([linearIdentity, linearIssue("project-1")]);

      await expect(
        prepareIssueOperation(
          { operation: "comment", identifier: "linear:ENG-1", body: "comment" },
          { cwd: repository, fetcher },
        ),
      ).rejects.toMatchObject({ code: "ISSUE_OUTSIDE_TARGET" });
    });
  });

  test("refuses to apply a Linear mutation after the issue leaves the target", async () => {
    await withLinearFixture(async (repository) => {
      const fetcher = mockFetch([
        linearIdentity,
        linearIssue(),
        linearIdentity,
        linearIssue("project-1"),
      ]);
      const preview = await prepareIssueOperation(
        { operation: "comment", identifier: "linear:ENG-1", body: "comment" },
        { cwd: repository, fetcher },
      );

      await expect(
        applyIssueOperation(preview.token, { cwd: repository, fetcher }),
      ).rejects.toMatchObject({ code: "ISSUE_OUTSIDE_TARGET" });
      expect((fetcher as unknown as ReturnType<typeof mock>).mock.calls).toHaveLength(4);
    });
  });

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
          {
            operation: "create",
            input: { title: "Example", description: "Details", priority: "high" },
          },
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
