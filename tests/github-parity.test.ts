import { describe, expect, mock, test } from "bun:test";
import type { GitHubProjectProvider, GitHubProviderProfile } from "../src/core/types.ts";
import { GitHubIssuesAdapter } from "../src/providers/github.ts";

const profile: GitHubProviderProfile = {
  type: "github",
  credential: "github-example",
  expected_identity: { login: "example-user", host: "github.com" },
};

const target: GitHubProjectProvider["target"] = { repository: "inherit" };
const repository = { owner: "acme", name: "payments" };
const repositoryUrl = "https://api.github.com/repos/acme/payments";

function issue(number: number, overrides: Record<string, unknown> = {}) {
  return {
    id: 100 + number,
    node_id: `I_issue_${number}`,
    number,
    title: `Issue ${number}`,
    body: null,
    state: "open",
    state_reason: null,
    html_url: `https://github.com/acme/payments/issues/${number}`,
    repository_url: repositoryUrl,
    updated_at: "2026-07-22T10:00:00Z",
    created_at: "2026-07-21T10:00:00Z",
    labels: [],
    ...overrides,
  };
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

type TestFetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

function adapter(fetcher: TestFetcher): GitHubIssuesAdapter {
  return new GitHubIssuesAdapter(
    profile,
    target,
    { token: "secret" },
    fetcher as unknown as typeof fetch,
    repository,
  );
}

describe("GitHub issue metadata parity", () => {
  test("discovers issue types and milestones as target-scoped options", async () => {
    const fetcher = mock(async (input: string | URL | Request) => {
      const url = new URL(String(input));

      if (url.pathname.endsWith("/labels")) return json([{ id: 1, name: "bug" }]);
      if (url.pathname.endsWith("/issue-types")) {
        return json([
          { id: 410, name: "Task" },
          { id: 411, name: "Bug" },
        ]);
      }
      if (url.pathname.endsWith("/milestones")) {
        return json([
          { id: 501, number: 3, title: "v1.0", state: "open" },
          { id: 502, number: 4, title: "v2.0", state: "closed" },
        ]);
      }

      throw new Error(`unexpected request ${url}`);
    });

    const capabilities = await adapter(fetcher).capabilities();

    expect(capabilities.fields.find(({ field }) => field === "issueType")).toMatchObject({
      operations: ["create", "update"],
      clearable: true,
      discoveryTool: "search_issue_options",
      options: [
        { value: "Task", label: "Task" },
        { value: "Bug", label: "Bug" },
      ],
    });
    expect(capabilities.fields.find(({ field }) => field === "milestone")).toMatchObject({
      operations: ["create", "update"],
      clearable: true,
      discoveryTool: "search_issue_options",
      options: [
        { value: "3", label: "v1.0" },
        { value: "4", label: "v2.0" },
      ],
    });
    expect(await adapter(fetcher).searchOptions("issueType", "bug", 10)).toEqual({
      options: [{ value: "Bug", label: "Bug" }],
      truncated: false,
    });
    expect(await adapter(fetcher).searchOptions("milestone", "v2", 10)).toEqual({
      options: [{ value: "4", label: "v2.0" }],
      truncated: false,
    });
  });

  test("creates a typed milestone issue and attaches it to a validated parent", async () => {
    const created = issue(12, {
      type: { id: 410, name: "Task" },
      milestone: { id: 501, number: 3, title: "v1.0" },
    });
    const fetcher = mock(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";

      if (url.pathname.endsWith("/issue-types")) return json([{ id: 410, name: "Task" }]);
      if (url.pathname.endsWith("/milestones")) {
        return json([{ id: 501, number: 3, title: "v1.0", state: "open" }]);
      }
      if (url.pathname.endsWith("/issues/10") && method === "GET") return json(issue(10));
      if (url.pathname.endsWith("/issues") && method === "POST") return json(created, 201);
      if (url.pathname.endsWith("/issues/10/sub_issues") && method === "POST") {
        expect(JSON.parse(String(init?.body))).toEqual({ sub_issue_id: 112 });
        return json(issue(10));
      }
      if (url.pathname.endsWith("/issues/12") && method === "GET") return json(created);

      throw new Error(`unexpected request ${method} ${url}`);
    });

    const result = await adapter(fetcher).create({
      title: "Typed child",
      issueType: "Task",
      milestone: "v1.0",
      parent: "#10",
    });
    const createCall = fetcher.mock.calls.find(([input, init]) => {
      const url = new URL(String(input));

      return url.pathname.endsWith("/issues") && init?.method === "POST";
    });

    expect(result).toMatchObject({
      identifier: "#12",
      issueType: { value: "Task", label: "Task" },
      milestone: { value: "3", label: "v1.0" },
    });
    expect(JSON.parse(String(createCall?.[1]?.body))).toMatchObject({
      title: "Typed child",
      type: "Task",
      milestone: 3,
    });
    expect(createCall?.[1]?.headers).toMatchObject({ "X-GitHub-Api-Version": "2026-03-10" });
  });

  test("updates and clears repository issue metadata", async () => {
    const updated = issue(12, { type: { id: 411, name: "Bug" }, milestone: null });
    const fetcher = mock(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";

      if (url.pathname.endsWith("/issues/12") && method === "GET") return json(updated);
      if (url.pathname.endsWith("/issue-types")) return json([{ id: 411, name: "Bug" }]);
      if (url.pathname.endsWith("/issues/12") && method === "PATCH") {
        expect(JSON.parse(String(init?.body))).toEqual({ type: "Bug", milestone: null });
        return json(updated);
      }

      throw new Error(`unexpected request ${method} ${url}`);
    });

    expect(
      await adapter(fetcher).update("#12", { issueType: "Bug", milestone: null }),
    ).toMatchObject({
      issueType: { value: "Bug", label: "Bug" },
      milestone: null,
    });
  });

  test("marks issue types unsupported when the repository endpoint is unavailable", async () => {
    const fetcher = mock(async (input: string | URL | Request) => {
      const url = new URL(String(input));

      if (url.pathname.endsWith("/labels")) return json([]);
      if (url.pathname.endsWith("/issue-types")) return json({ message: "Not Found" }, 404);
      if (url.pathname.endsWith("/milestones")) return json([]);

      throw new Error(`unexpected request ${url}`);
    });

    const capabilities = await adapter(fetcher).capabilities();

    expect(capabilities.fields.find(({ field }) => field === "issueType")).toMatchObject({
      operations: [],
      clearable: false,
      discoveryTool: null,
    });
  });
});

describe("GitHub native issue relations", () => {
  test("expands parent, subissue, dependency, and duplicate relations", async () => {
    const fetcher = mock(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));

      if (url.pathname.endsWith("/issues/12")) return json(issue(12));
      if (url.pathname.endsWith("/issues/12/parent")) return json(issue(10));
      if (url.pathname.endsWith("/issues/12/sub_issues")) return json([issue(13)]);
      if (url.pathname.endsWith("/issues/12/dependencies/blocked_by")) {
        return json([issue(14)]);
      }
      if (url.pathname.endsWith("/issues/12/dependencies/blocking")) return json([issue(15)]);
      if (url.pathname.endsWith("/graphql")) {
        expect(JSON.parse(String(init?.body)).query).toContain("duplicateOf");
        return json({
          data: {
            repository: {
              issue: {
                duplicateOf: {
                  id: "I_issue_16",
                  databaseId: 116,
                  number: 16,
                  title: "Issue 16",
                  url: "https://github.com/acme/payments/issues/16",
                  repository: { nameWithOwner: "acme/payments" },
                },
              },
            },
          },
        });
      }

      throw new Error(`unexpected request ${url}`);
    });

    const result = await adapter(fetcher).get("#12", { includeRelations: true });

    expect(result.relations).toEqual({
      parent: expect.objectContaining({ identifier: "#10" }),
      subIssues: [expect.objectContaining({ identifier: "#13" })],
      blocks: [expect.objectContaining({ identifier: "#15" })],
      blockedBy: [expect.objectContaining({ identifier: "#14" })],
      relatedTo: [],
      duplicateOf: expect.objectContaining({ identifier: "#16" }),
    });
  });

  test("revalidates every dependency before applying relationship mutations", async () => {
    const fetcher = mock(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      const number = Number(url.pathname.match(/\/issues\/(\d+)$/)?.[1]);

      if (method === "GET" && Number.isInteger(number)) return json(issue(number));
      if (method === "PATCH" && url.pathname.endsWith("/issues/12")) return json(issue(12));
      if (method === "POST" || method === "DELETE") return json(issue(12));

      throw new Error(`unexpected request ${method} ${url}`);
    });

    await adapter(fetcher).update("#12", {
      blocks: ["#13"],
      blockedBy: ["#14"],
      duplicateOf: "#15",
      removeBlocks: ["#16"],
      removeBlockedBy: ["#17"],
    });

    const calls = fetcher.mock.calls.map(([input, init]) => ({
      url: new URL(String(input)),
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    }));
    const firstWrite = calls.findIndex(({ method }) => method !== "GET");

    expect(calls.slice(0, firstWrite).filter(({ method }) => method === "GET")).toHaveLength(6);
    expect(calls).toContainEqual(
      expect.objectContaining({
        method: "PATCH",
        body: expect.objectContaining({
          state: "closed",
          state_reason: "duplicate",
          duplicate_issue_id: 115,
        }),
      }),
    );
    expect(calls).toContainEqual(
      expect.objectContaining({
        method: "POST",
        body: { issue_id: 112 },
        url: expect.objectContaining({
          pathname: "/repos/acme/payments/issues/13/dependencies/blocked_by",
        }),
      }),
    );
    expect(calls).toContainEqual(
      expect.objectContaining({
        method: "POST",
        body: { issue_id: 114 },
        url: expect.objectContaining({
          pathname: "/repos/acme/payments/issues/12/dependencies/blocked_by",
        }),
      }),
    );
  });

  test("rejects relation content from another configured repository", async () => {
    const fetcher = mock(async (input: string | URL | Request) => {
      const url = new URL(String(input));

      if (url.pathname.endsWith("/issues/12")) return json(issue(12));
      if (url.pathname.endsWith("/issues/12/parent")) {
        return json(
          issue(10, {
            repository_url: "https://api.github.com/repos/acme/other",
            html_url: "https://github.com/acme/other/issues/10",
          }),
        );
      }

      throw new Error(`unexpected request ${url}`);
    });

    await expect(adapter(fetcher).get("#12", { includeRelations: true })).rejects.toMatchObject({
      code: "ISSUE_OUTSIDE_TARGET",
    });
  });

  test("clears a parent and duplicate relationship with their native operations", async () => {
    const fetcher = mock(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";

      if (url.pathname.endsWith("/issues/12") && method === "GET") return json(issue(12));
      if (url.pathname.endsWith("/issues/12/parent") && method === "GET") {
        return json(issue(10));
      }
      if (url.pathname.endsWith("/issues/10/sub_issue") && method === "DELETE") {
        expect(JSON.parse(String(init?.body))).toEqual({ sub_issue_id: 112 });
        return json(issue(10));
      }
      if (url.pathname.endsWith("/graphql") && method === "POST") {
        const body = JSON.parse(String(init?.body));
        if (String(body.query).includes("unmarkIssueAsDuplicate")) {
          expect(body.variables).toEqual({ canonicalId: "I_issue_16", duplicateId: "I_issue_12" });
          return json({ data: { unmarkIssueAsDuplicate: { duplicate: { id: "I_issue_12" } } } });
        }
        return json({
          data: {
            repository: {
              issue: {
                duplicateOf: {
                  id: "I_issue_16",
                  databaseId: 116,
                  number: 16,
                  title: "Issue 16",
                  url: "https://github.com/acme/payments/issues/16",
                  repository: { nameWithOwner: "acme/payments" },
                },
              },
            },
          },
        });
      }

      throw new Error(`unexpected request ${method} ${url}`);
    });

    await adapter(fetcher).update("#12", { parent: null, duplicateOf: null });
  });

  test("lists direct subissues with target validation and truncation metadata", async () => {
    const fetcher = mock(async (input: string | URL | Request) => {
      const url = new URL(String(input));

      if (url.pathname.endsWith("/issues/12")) return json(issue(12));
      if (url.pathname.endsWith("/issues/12/sub_issues")) {
        return json([issue(13), issue(14)]);
      }

      throw new Error(`unexpected request ${url}`);
    });

    expect(await adapter(fetcher).list({ parent: "#12", limit: 1 })).toMatchObject({
      issues: [{ identifier: "#13" }],
      truncated: true,
    });
  });
});

describe("GitHub issue comment editing", () => {
  test("edits a comment only after proving it belongs to the target issue", async () => {
    const fetcher = mock(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";

      if (url.pathname.endsWith("/issues/12") && method === "GET") return json(issue(12));
      if (url.pathname.endsWith("/issues/comments/900") && method === "GET") {
        return json({
          id: 900,
          body: "Before",
          issue_url: `${repositoryUrl}/issues/12`,
          user: { id: 1, login: "example-user" },
          created_at: "2026-07-22T10:00:00Z",
          updated_at: "2026-07-22T10:00:00Z",
          html_url: "https://github.com/acme/payments/issues/12#issuecomment-900",
        });
      }
      if (url.pathname.endsWith("/issues/comments/900") && method === "PATCH") {
        expect(JSON.parse(String(init?.body))).toEqual({ body: "After" });
        return json({ id: 900, body: "After" });
      }

      throw new Error(`unexpected request ${method} ${url}`);
    });

    await adapter(fetcher).comment("#12", "After", { commentId: "900" });
  });

  test("rejects editing a comment attached to a different issue", async () => {
    const fetcher = mock(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";

      if (url.pathname.endsWith("/issues/12") && method === "GET") return json(issue(12));
      if (url.pathname.endsWith("/issues/comments/900") && method === "GET") {
        return json({
          id: 900,
          body: "Sensitive",
          issue_url: `${repositoryUrl}/issues/99`,
          user: null,
          created_at: "2026-07-22T10:00:00Z",
          updated_at: "2026-07-22T10:00:00Z",
          html_url: "https://github.com/acme/payments/issues/99#issuecomment-900",
        });
      }

      throw new Error(`unexpected request ${method} ${url}`);
    });

    await expect(
      adapter(fetcher).comment("#12", "Unsafe", { commentId: "900" }),
    ).rejects.toMatchObject({ code: "ISSUE_COMMENT_OUTSIDE_TARGET" });
    expect(fetcher.mock.calls.every(([, init]) => (init?.method ?? "GET") === "GET")).toBe(true);
  });
});
