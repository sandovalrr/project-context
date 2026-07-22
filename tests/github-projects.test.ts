import { describe, expect, test } from "bun:test";
import type { GitHubProjectProvider, GitHubProviderProfile } from "../src/core/types.ts";
import { GitHubIssuesAdapter } from "../src/providers/github.ts";

function mockFetch(responses: unknown[]) {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(url), ...(init ? { init } : {}) });
    const response = responses.shift();
    if (response === undefined) throw new Error("unexpected request");

    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  return { fetcher, requests };
}

const profile: GitHubProviderProfile = {
  type: "github",
  credential: "github-example",
  expected_identity: { login: "example-user", host: "github.com" },
};

const target = {
  repository: "inherit",
  project: {
    id: "PVT_project",
    owner: "acme",
    number: 9,
    name: "UI Team",
    status_field: { id: "PVTSSF_status", name: "Status" },
  },
} as GitHubProjectProvider["target"];

const restIssue = {
  id: 20,
  node_id: "I_issue_12",
  number: 12,
  title: "Scoped issue",
  body: "Details",
  state: "open",
  state_reason: null,
  labels: [{ name: "feature" }],
  html_url: "https://github.com/acme/payments/issues/12",
  updated_at: "2026-07-20T10:00:00Z",
  created_at: "2026-07-19T10:00:00Z",
  assignee: { id: 2, login: "richard" },
  user: { id: 1, login: "johnsmith" },
};

const projectIssue = {
  __typename: "Issue",
  id: "I_issue_12",
  databaseId: 20,
  number: 12,
  title: "Scoped issue",
  body: "Details",
  state: "OPEN",
  stateReason: null,
  url: "https://github.com/acme/payments/issues/12",
  updatedAt: "2026-07-20T10:00:00Z",
  createdAt: "2026-07-19T10:00:00Z",
  repository: { nameWithOwner: "acme/payments" },
  author: { login: "johnsmith", databaseId: 1 },
  assignees: { nodes: [{ login: "richard", databaseId: 2 }] },
  labels: { nodes: [{ name: "feature" }] },
};

function projectItem(
  content: Record<string, unknown>,
  status = "In Development",
  optionId = "option-in-development",
) {
  return {
    id: "PVTI_item_12",
    content,
    fieldValueByName: { name: status, optionId, field: { id: "PVTSSF_status" } },
  };
}

function membership(status = "In Development", optionId = "option-in-development") {
  return {
    data: {
      node: {
        projectItems: {
          nodes: [
            {
              id: "PVTI_item_12",
              project: { id: "PVT_project" },
              fieldValueByName: {
                name: status,
                optionId,
                field: { id: "PVTSSF_status" },
              },
            },
          ],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    },
  };
}

describe("GitHub Projects v2 issue target", () => {
  test("lists only issue items from the configured project and repository", async () => {
    const { fetcher, requests } = mockFetch([
      {
        data: {
          node: {
            items: {
              nodes: [
                projectItem(projectIssue),
                projectItem({
                  ...projectIssue,
                  id: "I_other",
                  number: 99,
                  repository: { nameWithOwner: "acme/other" },
                }),
                projectItem({ __typename: "PullRequest" }),
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      },
    ]);
    const adapter = new GitHubIssuesAdapter(profile, target, { token: "secret" }, fetcher, {
      owner: "acme",
      name: "payments",
    });

    const result = await adapter.list({
      matches: [
        {
          states: ["In Development", "In Review"],
          labelsAll: [],
          labelsNone: [],
        } as never,
      ],
    });

    expect(result).toMatchObject({
      truncated: false,
      issues: [{ identifier: "#12", status: "In Development" }],
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("https://api.github.com/graphql");
    const query = JSON.parse(String(requests[0]?.init?.body)).query;
    expect(query).toContain("ProjectItems");
    expect(query).toContain("$statusFieldName: String!");
  });

  test("rejects direct issue lookup outside the configured project", async () => {
    const { fetcher } = mockFetch([
      restIssue,
      {
        data: {
          node: {
            projectItems: {
              nodes: [{ id: "PVTI_other", project: { id: "PVT_other" } }],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      },
    ]);
    const adapter = new GitHubIssuesAdapter(profile, target, { token: "secret" }, fetcher, {
      owner: "acme",
      name: "payments",
    });

    await expect(adapter.get("#12")).rejects.toMatchObject({ code: "ISSUE_OUTSIDE_TARGET" });
  });

  test("adds a newly created repository issue to the configured project", async () => {
    const { fetcher, requests } = mockFetch([
      restIssue,
      {
        data: {
          addProjectV2ItemById: {
            item: { id: "PVTI_item_12" },
          },
        },
      },
    ]);
    const adapter = new GitHubIssuesAdapter(profile, target, { token: "secret" }, fetcher, {
      owner: "acme",
      name: "payments",
    });

    expect(await adapter.create({ title: "Scoped issue" })).toMatchObject({
      identifier: "#12",
      status: "No Status",
    });
    expect(requests).toHaveLength(2);
    expect(JSON.parse(String(requests[1]?.init?.body))).toMatchObject({
      variables: { projectId: "PVT_project", contentId: "I_issue_12" },
    });
  });

  test("uses Project status for an in-target direct issue lookup", async () => {
    const { fetcher } = mockFetch([restIssue, membership("Quality Assurance", "option-qa")]);
    const adapter = new GitHubIssuesAdapter(profile, target, { token: "secret" }, fetcher, {
      owner: "acme",
      name: "payments",
    });

    expect(await adapter.get("#12")).toMatchObject({
      identifier: "#12",
      status: "Quality Assurance",
      version: "20:2026-07-20T10:00:00Z:PVTI_item_12:option-qa",
    });
  });

  test("refuses an out-of-target update before sending the mutation", async () => {
    const { fetcher, requests } = mockFetch([
      restIssue,
      {
        data: {
          node: {
            projectItems: {
              nodes: [],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      },
    ]);
    const adapter = new GitHubIssuesAdapter(profile, target, { token: "secret" }, fetcher, {
      owner: "acme",
      name: "payments",
    });

    await expect(adapter.update("#12", { title: "Unsafe" })).rejects.toMatchObject({
      code: "ISSUE_OUTSIDE_TARGET",
    });
    expect(requests).toHaveLength(2);
    expect(
      requests.every(
        (request) => request.init?.method === "GET" || request.url.endsWith("/graphql"),
      ),
    ).toBe(true);
  });

  test("revalidates referenced parents against the configured Project", async () => {
    const parentIssue = {
      ...restIssue,
      id: 21,
      node_id: "I_issue_13",
      number: 13,
      title: "Outside parent",
      html_url: "https://github.com/acme/payments/issues/13",
    };
    const { fetcher, requests } = mockFetch([
      restIssue,
      membership(),
      parentIssue,
      {
        data: {
          node: {
            projectItems: {
              nodes: [],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      },
    ]);
    const adapter = new GitHubIssuesAdapter(profile, target, { token: "secret" }, fetcher, {
      owner: "acme",
      name: "payments",
    });

    await expect(adapter.update("#12", { parent: "#13" })).rejects.toMatchObject({
      code: "ISSUE_OUTSIDE_TARGET",
    });
    expect(
      requests.every(
        (request) => request.init?.method === "GET" || request.url.endsWith("/graphql"),
      ),
    ).toBe(true);
  });

  test("preserves Project status when listing direct subissues", async () => {
    const subIssue = {
      ...restIssue,
      id: 21,
      node_id: "I_issue_13",
      number: 13,
      title: "Scoped subissue",
      html_url: "https://github.com/acme/payments/issues/13",
      repository_url: "https://api.github.com/repos/acme/payments",
    };
    const { fetcher } = mockFetch([
      restIssue,
      membership(),
      [subIssue],
      subIssue,
      membership("Quality Assurance", "option-qa"),
    ]);
    const adapter = new GitHubIssuesAdapter(profile, target, { token: "secret" }, fetcher, {
      owner: "acme",
      name: "payments",
    });

    expect(await adapter.list({ parent: "#12" })).toMatchObject({
      issues: [{ identifier: "#13", status: "Quality Assurance" }],
      truncated: false,
    });
  });

  test("transitions Project status and synchronizes the GitHub issue lifecycle", async () => {
    const closedIssue = {
      ...restIssue,
      state: "closed",
      state_reason: "completed",
      updated_at: "2026-07-22T10:00:00Z",
    };
    const { fetcher, requests } = mockFetch([
      restIssue,
      membership(),
      {
        data: {
          node: {
            field: {
              id: "PVTSSF_status",
              name: "Status",
              options: [{ id: "option-done", name: "Done" }],
            },
          },
        },
      },
      {
        data: {
          updateProjectV2ItemFieldValue: { projectV2Item: { id: "PVTI_item_12" } },
        },
      },
      closedIssue,
    ]);
    const adapter = new GitHubIssuesAdapter(profile, target, { token: "secret" }, fetcher, {
      owner: "acme",
      name: "payments",
    });

    expect(await adapter.transition("#12", "Done", "done")).toMatchObject({
      status: "Done",
      version: "20:2026-07-22T10:00:00Z:PVTI_item_12:option-done",
    });
    expect(JSON.parse(String(requests[3]?.init?.body))).toMatchObject({
      variables: {
        projectId: "PVT_project",
        itemId: "PVTI_item_12",
        fieldId: "PVTSSF_status",
        optionId: "option-done",
      },
    });
    expect(JSON.parse(String(requests[4]?.init?.body))).toEqual({
      state: "closed",
      state_reason: "completed",
    });
  });
});
