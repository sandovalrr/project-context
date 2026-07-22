import { describe, expect, test } from "bun:test";
import type {
  GitHubProjectProvider,
  GitHubProviderProfile,
  JiraProjectProvider,
  JiraProviderProfile,
  LinearProjectProvider,
  LinearProviderProfile,
} from "../src/core/types.ts";
import { assertExpectedIdentity } from "../src/providers/factory.ts";
import { GitHubIssuesAdapter } from "../src/providers/github.ts";
import { JiraCloudIssuesAdapter } from "../src/providers/jira.ts";
import { LinearIssuesAdapter } from "../src/providers/linear.ts";

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

const githubProfile: GitHubProviderProfile = {
  type: "github",
  credential: "github-personal",
  expected_identity: { login: "example-user", host: "github.com" },
};
const githubTarget: GitHubProjectProvider["target"] = { repository: "inherit" };

const linearProfile: LinearProviderProfile = {
  type: "linear",
  credential: "linear-work",
  expected_identity: { workspace: { id: "workspace-1", name: "Workspace" } },
};
const linearTarget: LinearProjectProvider["target"] = {
  team: { id: "team-1", name: "Engineering" },
  project: "none",
};
const linearTeamTarget: LinearProjectProvider["target"] = {
  team: { id: "team-1", name: "Engineering" },
  project: "any",
};
const linearMultiProjectTarget: LinearProjectProvider["target"] = {
  team: { id: "team-1", name: "Engineering" },
  project: {
    include: [
      { id: "project-1", name: "Payments" },
      { id: "project-2", name: "Billing" },
    ],
    create_in: "project-2",
  },
};

function linearIssue(teamId: string, projectId?: string) {
  return {
    id: "issue-1",
    identifier: "ENG-1",
    title: "Targeted issue",
    description: "Details",
    url: "https://linear.app/workspace/issue/ENG-1",
    updatedAt: "2026-07-18T10:00:00Z",
    createdAt: "2026-07-17T10:00:00Z",
    dueDate: "2026-07-31",
    priority: 2,
    priorityLabel: "High",
    assignee: {
      id: "user-2",
      name: "Richard Sandoval",
      email: "richard@example.com",
      active: true,
    },
    creator: { id: "user-1", name: "John Smith", email: "john.smith@example.com" },
    state: { id: "state-1", name: "Backlog" },
    labels: { nodes: [] },
    team: { id: teamId },
    project: projectId ? { id: projectId } : null,
  };
}

const jiraProfile: JiraProviderProfile = {
  type: "jira-cloud",
  credential: "jira-work",
  expected_identity: { site: "example.atlassian.net", account_id: "account-1" },
};
const jiraTarget: JiraProjectProvider["target"] = {
  project: { id: "10000", name: "OPS" },
};

describe("GitHub Issues adapter", () => {
  test("authenticates, excludes pull requests from search, and creates issues", async () => {
    const issue = {
      id: 20,
      number: 12,
      title: "Broken build",
      body: "Details",
      state: "open",
      labels: [{ name: "bug" }],
      html_url: "https://github.com/acme/payments/issues/12",
      updated_at: "2026-07-18T10:00:00Z",
      created_at: "2026-07-17T10:00:00Z",
      assignee: { id: 2, login: "richard" },
      user: { id: 1, login: "johnsmith" },
    };
    const { fetcher, requests } = mockFetch([
      { id: 1, login: "example-user" },
      { items: [issue, { ...issue, number: 13, pull_request: {} }] },
      issue,
    ]);
    const adapter = new GitHubIssuesAdapter(
      githubProfile,
      githubTarget,
      { token: "secret" },
      fetcher,
      { owner: "acme", name: "payments" },
    );

    expect((await adapter.identity()).principalName).toBe("example-user");
    expect((await adapter.search("broken"))[0]).toMatchObject({
      assignee: { assignee: "richard", displayName: "richard" },
      creator: { id: "1", displayName: "johnsmith" },
      priority: null,
      issueType: null,
      createdAt: "2026-07-17T10:00:00Z",
      dueDate: null,
    });
    expect(
      (await adapter.create({ title: "Broken build", description: "Details" })).identifier,
    ).toBe("#12");
    expect(requests[0]?.init?.headers).toMatchObject({ Authorization: "Bearer secret" });
    expect(requests[1]?.url).toContain("is%3Aissue");
    expect(JSON.parse(String(requests[2]?.init?.body))).toMatchObject({
      title: "Broken build",
      body: "Details",
    });
  });

  test("lists matching statuses in updated order and reports truncation", async () => {
    const issue = {
      id: 20,
      number: 12,
      title: "Active work",
      body: "Details",
      state: "open",
      labels: [{ name: "in-progress" }],
      html_url: "https://github.com/acme/payments/issues/12",
      updated_at: "2026-07-18T10:00:00Z",
    };
    const { fetcher, requests } = mockFetch([{ total_count: 2, items: [issue] }]);
    const adapter = new GitHubIssuesAdapter(
      githubProfile,
      githubTarget,
      { token: "secret" },
      fetcher,
      { owner: "acme", name: "payments" },
    );

    const result = await adapter.list({
      matches: [{ states: ["open", "closed"], labelsAll: ["in-progress"], labelsNone: ["paused"] }],
      limit: 1,
    });

    expect(result).toMatchObject({ truncated: true, issues: [{ identifier: "#12" }] });
    const query = decodeURIComponent(requests[0]?.url ?? "");
    expect(query).toContain("repo:acme/payments");
    expect(query).toContain("is:issue");
    expect(query).toContain("is:open");
    expect(query).toContain("is:closed");
    expect(query).toContain('label:"in-progress"');
    expect(query).toContain('-label:"paused"');
    expect(query).toContain("sort=updated");
    expect(query).toContain("order=desc");
  });

  test("lists and searches repository-assignable users", async () => {
    const users = [
      { id: 1, login: "johnsmith" },
      { id: 2, login: "richard" },
      { id: 3, login: "someone-else" },
    ];
    const { fetcher, requests } = mockFetch([users, users]);
    const adapter = new GitHubIssuesAdapter(
      githubProfile,
      githubTarget,
      { token: "secret" },
      fetcher,
      { owner: "acme", name: "payments" },
    );

    expect(await adapter.listUsers(2)).toEqual({
      users: [
        {
          provider: "github",
          assignee: "johnsmith",
          displayName: "johnsmith",
          username: "johnsmith",
          email: null,
          active: true,
        },
        {
          provider: "github",
          assignee: "richard",
          displayName: "richard",
          username: "richard",
          email: null,
          active: true,
        },
      ],
      truncated: true,
    });
    expect(await adapter.searchUsers("JOHN", 2)).toMatchObject({
      users: [{ assignee: "johnsmith" }],
      truncated: false,
    });
    expect(requests.map(({ url }) => decodeURIComponent(url))).toEqual([
      "https://api.github.com/repos/acme/payments/assignees?per_page=3&page=1",
      "https://api.github.com/repos/acme/payments/assignees?per_page=100&page=1",
    ]);
  });

  test("reports repository-scoped field capabilities", async () => {
    const { fetcher, requests } = mockFetch([
      [
        { id: 1, name: "bug" },
        { id: 2, name: "enhancement" },
      ],
    ]);
    const adapter = new GitHubIssuesAdapter(
      githubProfile,
      githubTarget,
      { token: "secret" },
      fetcher,
      { owner: "acme", name: "payments" },
    );

    expect(await adapter.capabilities()).toMatchObject({
      fields: [
        { field: "title", operations: ["create", "update"], requiredOnCreate: true },
        { field: "description", operations: ["create", "update"] },
        {
          field: "labels",
          operations: ["create", "update"],
          acceptsCustomValues: false,
          discoveryTool: "search_issue_options",
          optionsTruncated: false,
          options: [
            { value: "bug", label: "bug" },
            { value: "enhancement", label: "enhancement" },
          ],
        },
        {
          field: "assignee",
          operations: ["create", "update"],
          clearable: true,
          discoveryTool: "search_users",
        },
        { field: "priority", operations: [] },
        { field: "issueType", operations: [] },
      ],
    });
    expect(decodeURIComponent(requests[0]?.url ?? "")).toBe(
      "https://api.github.com/repos/acme/payments/labels?per_page=100&page=1",
    );
  });

  test("searches repository labels with bounded pagination", async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      id: index,
      name: `label-${index}`,
    }));
    const { fetcher, requests } = mockFetch([
      firstPage,
      [
        { id: 101, name: "security" },
        { id: 102, name: "security-review" },
      ],
    ]);
    const adapter = new GitHubIssuesAdapter(
      githubProfile,
      githubTarget,
      { token: "secret" },
      fetcher,
      { owner: "acme", name: "payments" },
    );

    expect(await adapter.searchOptions("labels", "SECURITY", 1)).toEqual({
      options: [{ value: "security", label: "security" }],
      truncated: true,
    });
    expect(requests.map(({ url }) => decodeURIComponent(url))).toEqual([
      "https://api.github.com/repos/acme/payments/labels?per_page=100&page=1",
      "https://api.github.com/repos/acme/payments/labels?per_page=100&page=2",
    ]);
    await expect(adapter.searchOptions("priority", "high", 10)).rejects.toMatchObject({
      code: "ISSUE_OPTION_FIELD_UNSUPPORTED",
    });
  });

  test("marks repository label search incomplete at the page bound", async () => {
    const page = Array.from({ length: 100 }, (_, index) => ({
      id: index,
      name: `label-${index}`,
    }));
    const { fetcher, requests } = mockFetch(Array.from({ length: 10 }, () => page));
    const adapter = new GitHubIssuesAdapter(
      githubProfile,
      githubTarget,
      { token: "secret" },
      fetcher,
      { owner: "acme", name: "payments" },
    );

    expect(await adapter.searchOptions("labels", "absent", 10)).toEqual({
      options: [],
      truncated: true,
    });
    expect(requests).toHaveLength(10);
  });
});

describe("target-scoped issue comment reads", () => {
  test("lists the newest GitHub issue comments with bounded tail pagination", async () => {
    const issue = {
      id: 20,
      number: 12,
      title: "Commented issue",
      body: null,
      state: "open",
      html_url: "https://github.com/acme/payments/issues/12",
      updated_at: "2026-07-18T10:00:00Z",
      comments: 102,
    };
    const githubComment = (id: number, createdAt: string) => ({
      id,
      body: `comment-${id}`,
      user: id === 100 ? null : { id, login: `user-${id}` },
      created_at: createdAt,
      updated_at: createdAt,
      html_url: `https://github.com/acme/payments/issues/12#issuecomment-${id}`,
    });
    const { fetcher, requests } = mockFetch([
      issue,
      [githubComment(101, "2026-07-18T11:00:00Z"), githubComment(102, "2026-07-18T12:00:00Z")],
      [githubComment(100, "2026-07-18T10:00:00Z")],
      issue,
    ]);
    const adapter = new GitHubIssuesAdapter(
      githubProfile,
      githubTarget,
      { token: "secret" },
      fetcher,
      { owner: "acme", name: "payments" },
    );

    const result = await adapter.listComments("#12", 3);

    expect(result.truncated).toBe(true);
    expect(result.comments.map(({ id }) => id)).toEqual(["102", "101", "100"]);
    expect(result.comments[0]).toMatchObject({ id: "102", body: "comment-102" });
    expect(result.comments[1]?.author).toMatchObject({ username: "user-101" });
    expect(result.comments[2]?.author).toBeNull();
    expect(requests.map(({ url }) => decodeURIComponent(url))).toEqual([
      "https://api.github.com/repos/acme/payments/issues/12",
      "https://api.github.com/repos/acme/payments/issues/12/comments?per_page=100&page=2",
      "https://api.github.com/repos/acme/payments/issues/12/comments?per_page=100&page=1",
      "https://api.github.com/repos/acme/payments/issues/12",
    ]);
  });

  test("rejects GitHub pull requests before reading their issue-shaped comments", async () => {
    const { fetcher, requests } = mockFetch([
      {
        id: 20,
        number: 12,
        title: "Pull request",
        body: null,
        state: "open",
        html_url: "https://github.com/acme/payments/pull/12",
        updated_at: "2026-07-18T10:00:00Z",
        comments: 1,
        pull_request: {},
      },
    ]);
    const adapter = new GitHubIssuesAdapter(
      githubProfile,
      githubTarget,
      { token: "secret" },
      fetcher,
      { owner: "acme", name: "payments" },
    );

    await expect(adapter.listComments("#12")).rejects.toMatchObject({
      code: "ISSUE_PULL_REQUEST_UNSUPPORTED",
    });
    expect(requests).toHaveLength(1);
  });

  test("atomically validates the Linear target before returning newest-first comments", async () => {
    const { fetcher } = mockFetch([
      {
        data: {
          issue: {
            id: "issue-1",
            identifier: "ENG-1",
            team: { id: "team-1" },
            project: null,
            comments: {
              nodes: [
                {
                  id: "comment-1",
                  body: "Earlier",
                  createdAt: "2026-07-18T10:00:00Z",
                  updatedAt: "2026-07-18T10:00:00Z",
                  url: "https://linear.app/comment/comment-1",
                  user: { id: "user-1", name: "John Smith", email: "john.smith@example.com" },
                },
                {
                  id: "comment-2",
                  body: "Later",
                  createdAt: "2026-07-18T11:00:00Z",
                  updatedAt: "2026-07-18T11:00:00Z",
                  url: "https://linear.app/comment/comment-2",
                  user: null,
                },
              ],
              pageInfo: { hasPreviousPage: true },
            },
          },
        },
      },
    ]);
    const adapter = new LinearIssuesAdapter(
      linearProfile,
      linearTarget,
      { token: "secret" },
      fetcher,
    );

    const result = await adapter.listComments("ENG-1", 2);

    expect(result.truncated).toBe(true);
    expect(result.comments.map(({ id }) => id)).toEqual(["comment-2", "comment-1"]);
    expect(result.comments[0]).toMatchObject({ body: "Later", author: null });
    expect(result.comments[1]?.author).toMatchObject({ displayName: "John Smith" });
  });

  test("does not expose Linear comment bodies when target validation fails", async () => {
    const sensitiveBody = "never-return-this-comment";
    const { fetcher } = mockFetch([
      {
        data: {
          issue: {
            id: "issue-2",
            identifier: "OTHER-2",
            team: { id: "other-team" },
            project: null,
            comments: {
              nodes: [
                {
                  id: "comment-sensitive",
                  body: sensitiveBody,
                  createdAt: "2026-07-18T11:00:00Z",
                  updatedAt: "2026-07-18T11:00:00Z",
                },
              ],
              pageInfo: { hasPreviousPage: false },
            },
          },
        },
      },
    ]);
    const adapter = new LinearIssuesAdapter(
      linearProfile,
      linearTarget,
      { token: "secret" },
      fetcher,
    );

    try {
      await adapter.listComments("OTHER-2");
      throw new Error("expected target validation failure");
    } catch (error) {
      expect(error).toMatchObject({ code: "ISSUE_OUTSIDE_TARGET" });
      expect(String(error)).not.toContain(sensitiveBody);
    }
  });

  test("revalidates Jira project scope after fetching the newest comment page", async () => {
    const issue = {
      id: "10001",
      key: "OPS-4",
      self: "https://example.atlassian.net/rest/api/3/issue/10001",
      fields: {
        summary: "Commented issue",
        status: { name: "To Do" },
        project: { id: "10000" },
        updated: "2026-07-18T10:00:00.000+0000",
      },
    };
    const jiraComment = (id: string, body: string, created: string) => ({
      id,
      body: {
        type: "doc",
        version: 1,
        content: [{ type: "paragraph", content: [{ type: "text", text: body }] }],
      },
      author: { accountId: `account-${id}`, displayName: `User ${id}` },
      created,
      updated: created,
    });
    const { fetcher, requests } = mockFetch([
      issue,
      {
        comments: [
          jiraComment("1", "Oldest", "2026-07-18T10:00:00.000+0000"),
          jiraComment("2", "Middle", "2026-07-18T11:00:00.000+0000"),
        ],
        total: 3,
      },
      {
        comments: [
          jiraComment("2", "Middle", "2026-07-18T11:00:00.000+0000"),
          jiraComment("3", "Newest", "2026-07-18T12:00:00.000+0000"),
        ],
        total: 3,
      },
      issue,
    ]);
    const adapter = new JiraCloudIssuesAdapter(
      jiraProfile,
      jiraTarget,
      { email: "r@example.com", token: "secret" },
      fetcher,
    );

    expect(await adapter.listComments("OPS-4", 2)).toEqual({
      comments: [
        expect.objectContaining({ id: "3", body: "Newest" }),
        expect.objectContaining({ id: "2", body: "Middle" }),
      ],
      truncated: true,
    });
    expect(requests.map(({ url }) => decodeURIComponent(url))).toEqual([
      expect.stringContaining("/rest/api/3/issue/OPS-4?fields="),
      "https://example.atlassian.net/rest/api/3/issue/OPS-4/comment?startAt=0&maxResults=2",
      "https://example.atlassian.net/rest/api/3/issue/OPS-4/comment?startAt=1&maxResults=2",
      expect.stringContaining("/rest/api/3/issue/OPS-4?fields="),
    ]);
  });

  test("withholds Jira comment bodies when post-fetch target revalidation fails", async () => {
    const targetedIssue = {
      id: "10001",
      key: "OPS-4",
      self: "https://example.atlassian.net/rest/api/3/issue/10001",
      fields: {
        summary: "Moved issue",
        status: { name: "To Do" },
        project: { id: "10000" },
        updated: "2026-07-18T10:00:00.000+0000",
      },
    };
    const outsideIssue = {
      ...targetedIssue,
      fields: { ...targetedIssue.fields, project: { id: "20000" } },
    };
    const sensitiveBody = "jira-comment-must-not-escape";
    const { fetcher } = mockFetch([
      targetedIssue,
      {
        comments: [
          {
            id: "1",
            body: {
              type: "doc",
              version: 1,
              content: [{ type: "paragraph", content: [{ type: "text", text: sensitiveBody }] }],
            },
            created: "2026-07-18T10:00:00.000+0000",
            updated: "2026-07-18T10:00:00.000+0000",
          },
        ],
        total: 1,
      },
      outsideIssue,
    ]);
    const adapter = new JiraCloudIssuesAdapter(
      jiraProfile,
      jiraTarget,
      { email: "r@example.com", token: "secret" },
      fetcher,
    );

    try {
      await adapter.listComments("OPS-4");
      throw new Error("expected target validation failure");
    } catch (error) {
      expect(error).toMatchObject({ code: "ISSUE_OUTSIDE_TARGET" });
      expect(String(error)).not.toContain(sensitiveBody);
    }
  });
});

describe("Linear adapter", () => {
  test("accepts an issue in the configured explicit project", async () => {
    const target: LinearProjectProvider["target"] = {
      team: { id: "team-1", name: "Engineering" },
      project: { id: "project-1", name: "Payments" },
    };
    const { fetcher, requests } = mockFetch([
      { data: { issue: linearIssue("team-1", "project-1") } },
    ]);
    const adapter = new LinearIssuesAdapter(linearProfile, target, { token: "secret" }, fetcher);

    expect(await adapter.get("ENG-1")).toMatchObject({
      identifier: "ENG-1",
      assignee: { assignee: "user-2", displayName: "Richard Sandoval" },
      creator: { id: "user-1", displayName: "John Smith" },
      priority: { value: 2, label: "High" },
      issueType: null,
      createdAt: "2026-07-17T10:00:00Z",
      dueDate: "2026-07-31",
    });
    expect(JSON.parse(String(requests[0]?.init?.body)).query).toContain("team { id }");
    expect(JSON.parse(String(requests[0]?.init?.body)).query).toContain("project { id }");
  });

  test("rejects an issue in a different explicit project", async () => {
    const target: LinearProjectProvider["target"] = {
      team: { id: "team-1", name: "Engineering" },
      project: { id: "project-1", name: "Payments" },
    };
    const { fetcher } = mockFetch([{ data: { issue: linearIssue("team-1", "project-2") } }]);
    const adapter = new LinearIssuesAdapter(linearProfile, target, { token: "secret" }, fetcher);

    await expect(adapter.get("ENG-1")).rejects.toMatchObject({ code: "ISSUE_OUTSIDE_TARGET" });
  });

  test("accepts an unprojected issue for a no-project target", async () => {
    const { fetcher } = mockFetch([{ data: { issue: linearIssue("team-1") } }]);
    const adapter = new LinearIssuesAdapter(
      linearProfile,
      linearTarget,
      { token: "secret" },
      fetcher,
    );

    expect((await adapter.get("ENG-1")).identifier).toBe("ENG-1");
  });

  test("rejects a projected issue for a no-project target", async () => {
    const { fetcher } = mockFetch([{ data: { issue: linearIssue("team-1", "project-1") } }]);
    const adapter = new LinearIssuesAdapter(
      linearProfile,
      linearTarget,
      { token: "secret" },
      fetcher,
    );

    await expect(adapter.get("ENG-1")).rejects.toMatchObject({ code: "ISSUE_OUTSIDE_TARGET" });
  });

  test("accepts projected and unprojected issues in a team-wide target", async () => {
    const { fetcher } = mockFetch([
      { data: { issue: linearIssue("team-1", "project-1") } },
      { data: { issue: linearIssue("team-1") } },
      { data: { issue: linearIssue("team-2", "project-1") } },
    ]);
    const adapter = new LinearIssuesAdapter(
      linearProfile,
      linearTeamTarget,
      { token: "secret" },
      fetcher,
    );

    expect((await adapter.get("ENG-1")).identifier).toBe("ENG-1");
    expect((await adapter.get("ENG-2")).identifier).toBe("ENG-1");
    await expect(adapter.get("OTHER-1")).rejects.toMatchObject({
      code: "ISSUE_OUTSIDE_TARGET",
    });
  });

  test("accepts only issues in the selected Linear projects", async () => {
    const { fetcher } = mockFetch([
      { data: { issue: linearIssue("team-1", "project-1") } },
      { data: { issue: linearIssue("team-1", "project-2") } },
      { data: { issue: linearIssue("team-1", "project-3") } },
      { data: { issue: linearIssue("team-1") } },
      { data: { issue: linearIssue("team-2", "project-1") } },
    ]);
    const adapter = new LinearIssuesAdapter(
      linearProfile,
      linearMultiProjectTarget,
      { token: "secret" },
      fetcher,
    );

    expect((await adapter.get("ENG-1")).identifier).toBe("ENG-1");
    expect((await adapter.get("ENG-2")).identifier).toBe("ENG-1");
    await expect(adapter.get("ENG-3")).rejects.toMatchObject({ code: "ISSUE_OUTSIDE_TARGET" });
    await expect(adapter.get("ENG-4")).rejects.toMatchObject({ code: "ISSUE_OUTSIDE_TARGET" });
    await expect(adapter.get("OTHER-1")).rejects.toMatchObject({
      code: "ISSUE_OUTSIDE_TARGET",
    });
  });

  test("rejects an issue in a different team", async () => {
    const { fetcher } = mockFetch([{ data: { issue: linearIssue("team-2") } }]);
    const adapter = new LinearIssuesAdapter(
      linearProfile,
      linearTarget,
      { token: "secret" },
      fetcher,
    );

    await expect(adapter.get("ENG-1")).rejects.toMatchObject({ code: "ISSUE_OUTSIDE_TARGET" });
  });

  test("searches through the supported issues filter within the configured target", async () => {
    const issue = {
      id: "issue-1",
      identifier: "ENG-1",
      title: "Widget bug",
      description: "Details",
      url: "https://linear.app/workspace/issue/ENG-1",
      updatedAt: "2026-07-18T10:00:00Z",
      state: { id: "state-1", name: "Backlog" },
      labels: { nodes: [] },
      team: { id: "team-1" },
      project: { id: "project-1" },
    };
    const target: LinearProjectProvider["target"] = {
      team: { id: "team-1", name: "Engineering" },
      project: { id: "project-1", name: "Widget" },
    };
    const { fetcher, requests } = mockFetch([{ data: { issues: { nodes: [issue] } } }]);
    const adapter = new LinearIssuesAdapter(linearProfile, target, { token: "secret" }, fetcher);

    expect((await adapter.search("widget", 1))[0]?.identifier).toBe("ENG-1");
    const body = JSON.parse(String(requests[0]?.init?.body));
    expect(body.query).toContain("issues(filter: $filter");
    expect(body.query).not.toContain("issueSearch");
    expect(body.variables).toEqual({
      first: 1,
      filter: {
        team: { id: { eq: "team-1" } },
        project: { id: { eq: "project-1" } },
        or: [
          { title: { containsIgnoreCase: "widget" } },
          { description: { containsIgnoreCase: "widget" } },
        ],
      },
    });
  });

  test("omits the project filter when searching a team-wide target", async () => {
    const { fetcher, requests } = mockFetch([
      { data: { issues: { nodes: [linearIssue("team-1", "project-1")] } } },
    ]);
    const adapter = new LinearIssuesAdapter(
      linearProfile,
      linearTeamTarget,
      { token: "secret" },
      fetcher,
    );

    expect((await adapter.search("targeted", 1))[0]?.identifier).toBe("ENG-1");
    const body = JSON.parse(String(requests[0]?.init?.body));
    expect(body.variables.filter).toMatchObject({ team: { id: { eq: "team-1" } } });
    expect(body.variables.filter).not.toHaveProperty("project");
  });

  test("searches only the selected Linear projects", async () => {
    const { fetcher, requests } = mockFetch([
      { data: { issues: { nodes: [linearIssue("team-1", "project-1")] } } },
    ]);
    const adapter = new LinearIssuesAdapter(
      linearProfile,
      linearMultiProjectTarget,
      { token: "secret" },
      fetcher,
    );

    expect((await adapter.search("targeted", 1))[0]?.identifier).toBe("ENG-1");
    const body = JSON.parse(String(requests[0]?.init?.body));
    expect(body.variables.filter).toMatchObject({
      team: { id: { eq: "team-1" } },
      project: { id: { in: ["project-1", "project-2"] } },
    });
  });

  test("lists projected and unprojected issues across a team-wide target", async () => {
    const { fetcher, requests } = mockFetch([
      {
        data: {
          issues: {
            nodes: [linearIssue("team-1", "project-1"), linearIssue("team-1")],
            pageInfo: { hasNextPage: false },
          },
        },
      },
    ]);
    const adapter = new LinearIssuesAdapter(
      linearProfile,
      linearTeamTarget,
      { token: "secret" },
      fetcher,
    );

    expect((await adapter.list()).issues).toHaveLength(2);
    const body = JSON.parse(String(requests[0]?.init?.body));
    expect(body.variables.filter).toEqual({ team: { id: { eq: "team-1" } } });
  });

  test("lists only issues in the selected Linear projects", async () => {
    const { fetcher, requests } = mockFetch([
      {
        data: {
          issues: {
            nodes: [linearIssue("team-1", "project-1"), linearIssue("team-1", "project-2")],
            pageInfo: { hasNextPage: false },
          },
        },
      },
    ]);
    const adapter = new LinearIssuesAdapter(
      linearProfile,
      linearMultiProjectTarget,
      { token: "secret" },
      fetcher,
    );

    expect((await adapter.list()).issues).toHaveLength(2);
    const body = JSON.parse(String(requests[0]?.init?.body));
    expect(body.variables.filter).toEqual({
      team: { id: { eq: "team-1" } },
      project: { id: { in: ["project-1", "project-2"] } },
    });
  });

  test("lists status matches inside the configured target in updated order", async () => {
    const issue = {
      ...linearIssue("team-1"),
      state: { id: "state-2", name: "In Progress" },
      labels: { nodes: [{ name: "doing" }] },
    };
    const { fetcher, requests } = mockFetch([
      { data: { issues: { nodes: [issue], pageInfo: { hasNextPage: true } } } },
    ]);
    const adapter = new LinearIssuesAdapter(
      linearProfile,
      linearTarget,
      { token: "secret" },
      fetcher,
    );

    const result = await adapter.list({
      matches: [
        {
          states: ["In Progress", "In Review"],
          labelsAll: ["doing"],
          labelsNone: ["paused"],
        },
      ],
      limit: 1,
    });

    expect(result).toMatchObject({ truncated: true, issues: [{ identifier: "ENG-1" }] });
    const body = JSON.parse(String(requests[0]?.init?.body));
    expect(body.query).toContain("orderBy: updatedAt");
    expect(body.query).toContain("pageInfo { hasNextPage }");
    expect(body.variables.filter).toMatchObject({
      team: { id: { eq: "team-1" } },
      project: { null: true },
    });
    expect(JSON.stringify(body.variables.filter)).toContain("In Progress");
    expect(JSON.stringify(body.variables.filter)).toContain("In Review");
    expect(JSON.stringify(body.variables.filter)).toContain("doing");
    expect(JSON.stringify(body.variables.filter)).toContain("paused");
  });

  test("uses the configured team and explicit no-project target", async () => {
    const issue = {
      id: "issue-1",
      identifier: "ENG-1",
      title: "Broken build",
      description: "Details",
      url: "https://linear.app/workspace/issue/ENG-1",
      updatedAt: "2026-07-18T10:00:00Z",
      state: { id: "state-1", name: "Backlog" },
      labels: { nodes: [] },
    };
    const { fetcher, requests } = mockFetch([
      {
        data: {
          viewer: { id: "user-1", name: "R", email: "r@example.com" },
          organization: { id: "workspace-1", name: "Workspace" },
        },
      },
      { data: { issueCreate: { success: true, issue } } },
    ]);
    const adapter = new LinearIssuesAdapter(
      linearProfile,
      linearTarget,
      { token: "secret" },
      fetcher,
    );

    expect((await adapter.identity()).scopeId).toBe("workspace-1");
    expect((await adapter.create({ title: "Broken build" })).identifier).toBe("ENG-1");
    const body = JSON.parse(String(requests[1]?.init?.body));
    expect(body.variables.input).toMatchObject({ title: "Broken build", teamId: "team-1" });
    expect(body.variables.input).not.toHaveProperty("projectId");
  });

  test("creates an unprojected issue for a team-wide target", async () => {
    const issue = linearIssue("team-1");
    const { fetcher, requests } = mockFetch([{ data: { issueCreate: { success: true, issue } } }]);
    const adapter = new LinearIssuesAdapter(
      linearProfile,
      linearTeamTarget,
      { token: "secret" },
      fetcher,
    );

    expect((await adapter.create({ title: "Broken build" })).identifier).toBe("ENG-1");
    const body = JSON.parse(String(requests[0]?.init?.body));
    expect(body.variables.input).toMatchObject({ title: "Broken build", teamId: "team-1" });
    expect(body.variables.input).not.toHaveProperty("projectId");
  });

  test("creates a Linear issue in the explicit multi-project creation target", async () => {
    const issue = linearIssue("team-1", "project-2");
    const { fetcher, requests } = mockFetch([{ data: { issueCreate: { success: true, issue } } }]);
    const adapter = new LinearIssuesAdapter(
      linearProfile,
      linearMultiProjectTarget,
      { token: "secret" },
      fetcher,
    );

    expect((await adapter.create({ title: "Broken build" })).identifier).toBe("ENG-1");
    const body = JSON.parse(String(requests[0]?.init?.body));
    expect(body.variables.input).toMatchObject({
      title: "Broken build",
      teamId: "team-1",
      projectId: "project-2",
    });
  });

  test("resolves label names and canonical priority before creation", async () => {
    const issue = {
      id: "issue-2",
      identifier: "ENG-2",
      title: "Labeled issue",
      description: null,
      url: "https://linear.app/workspace/issue/ENG-2",
      updatedAt: "2026-07-18T10:00:00Z",
      state: { id: "state-1", name: "Backlog" },
      labels: { nodes: [{ name: "bug" }] },
    };
    const { fetcher, requests } = mockFetch([
      { data: { issueLabels: { nodes: [{ id: "label-1", name: "bug" }] } } },
      { data: { issueCreate: { success: true, issue } } },
    ]);
    const adapter = new LinearIssuesAdapter(
      linearProfile,
      linearTarget,
      { token: "secret" },
      fetcher,
    );

    await adapter.create({ title: "Labeled issue", labels: ["bug"], priority: "high" });
    const body = JSON.parse(String(requests[1]?.init?.body));
    expect(body.variables.input).toMatchObject({ priority: 2, labelIds: ["label-1"] });
  });

  test("lists and searches active members of the configured team", async () => {
    const users = [
      { id: "user-1", name: "John Smith", email: "john.smith@example.com", active: true },
      { id: "user-2", name: "Richard Sandoval", email: "richard@example.com", active: true },
      { id: "user-3", name: "Former User", email: "former@example.com", active: false },
    ];
    const page = {
      data: { team: { members: { nodes: users, pageInfo: { hasNextPage: false } } } },
    };
    const { fetcher, requests } = mockFetch([page, page]);
    const adapter = new LinearIssuesAdapter(
      linearProfile,
      linearTarget,
      { token: "secret" },
      fetcher,
    );

    expect(await adapter.listUsers(1)).toEqual({
      users: [
        {
          provider: "linear",
          assignee: "user-1",
          displayName: "John Smith",
          username: null,
          email: "john.smith@example.com",
          active: true,
        },
      ],
      truncated: true,
    });
    expect(await adapter.searchUsers("richard@example", 10)).toMatchObject({
      users: [{ assignee: "user-2", displayName: "Richard Sandoval" }],
      truncated: false,
    });
    const bodies = requests.map(({ init }) => JSON.parse(String(init?.body)));
    expect(bodies[0]?.query).toContain("team(id: $teamId)");
    expect(bodies[0]?.query).toContain("members(first: $first");
    expect(bodies[0]?.variables).toMatchObject({ teamId: "team-1", first: 2 });
  });

  test("reports team-scoped labels and Linear priority capabilities", async () => {
    const { fetcher, requests } = mockFetch([
      {
        data: {
          issueLabels: {
            nodes: [
              { id: "label-1", name: "Bug" },
              { id: "label-2", name: "Feature" },
            ],
            pageInfo: { hasNextPage: true },
          },
        },
      },
    ]);
    const adapter = new LinearIssuesAdapter(
      linearProfile,
      linearTarget,
      { token: "secret" },
      fetcher,
    );

    const result = await adapter.capabilities();

    expect(result.fields.find(({ field }) => field === "labels")).toMatchObject({
      acceptsCustomValues: false,
      discoveryTool: "search_issue_options",
      optionsTruncated: true,
      options: [
        { value: "Bug", label: "Bug" },
        { value: "Feature", label: "Feature" },
      ],
    });
    expect(result.fields.find(({ field }) => field === "priority")?.options).toEqual([
      { value: 0, label: "No priority" },
      { value: 1, label: "Urgent" },
      { value: 2, label: "High" },
      { value: 3, label: "Medium" },
      { value: 4, label: "Low" },
    ]);
    expect(result.fields.find(({ field }) => field === "priority")?.defaultValue).toBe(0);
    expect(result.fields.find(({ field }) => field === "priority")?.discoveryTool).toBe(
      "search_issue_options",
    );
    expect(result.fields.find(({ field }) => field === "issueType")?.operations).toEqual([]);
    const body = JSON.parse(String(requests[0]?.init?.body));
    expect(body.variables).toEqual({ teamId: "team-1", first: 101 });
  });

  test("searches team labels and the fixed Linear priority catalog", async () => {
    const { fetcher, requests } = mockFetch([
      {
        data: {
          issueLabels: {
            nodes: [{ id: "label-1", name: "Bug" }],
            pageInfo: { hasNextPage: true },
          },
        },
      },
    ]);
    const adapter = new LinearIssuesAdapter(
      linearProfile,
      linearTarget,
      { token: "secret" },
      fetcher,
    );

    expect(await adapter.searchOptions("labels", "bug", 1)).toEqual({
      options: [{ value: "Bug", label: "Bug" }],
      truncated: true,
    });
    expect(await adapter.searchOptions("priority", "hi", 10)).toEqual({
      options: [{ value: 2, label: "High" }],
      truncated: false,
    });
    const body = JSON.parse(String(requests[0]?.init?.body));
    expect(body.variables).toEqual({ teamId: "team-1", query: "bug", first: 2 });
    expect(body.query).toContain("name: { containsIgnoreCase: $query }");
    await expect(adapter.searchOptions("issueType", "bug", 10)).rejects.toMatchObject({
      code: "ISSUE_OPTION_FIELD_UNSUPPORTED",
    });
  });
});

describe("Jira Cloud adapter", () => {
  test("uses API v3 ADF and retrieves the created issue", async () => {
    const issue = {
      id: "10001",
      key: "OPS-4",
      self: "https://example.atlassian.net/rest/api/3/issue/10001",
      fields: {
        summary: "Broken build",
        description: {
          type: "doc",
          version: 1,
          content: [{ type: "paragraph", content: [{ type: "text", text: "Details" }] }],
        },
        status: { name: "To Do" },
        project: { id: "10000" },
        labels: [],
        updated: "2026-07-18T10:00:00.000+0000",
        created: "2026-07-17T10:00:00.000+0000",
        duedate: "2026-07-31",
        assignee: {
          accountId: "account-richard",
          displayName: "Richard Sandoval",
          emailAddress: "richard@example.com",
          active: true,
        },
        creator: { accountId: "account-john-smith", displayName: "John Smith" },
        priority: { id: "2", name: "High" },
        issuetype: { id: "10001", name: "Bug" },
      },
    };
    const { fetcher, requests } = mockFetch([{ id: "10001", key: "OPS-4" }, issue]);
    const adapter = new JiraCloudIssuesAdapter(
      jiraProfile,
      jiraTarget,
      { email: "r@example.com", token: "secret" },
      fetcher,
    );

    expect(await adapter.create({ title: "Broken build", description: "Details" })).toMatchObject({
      description: "Details",
      assignee: { assignee: "account-richard", displayName: "Richard Sandoval" },
      creator: { id: "account-john-smith", displayName: "John Smith" },
      priority: { value: "High", label: "High" },
      issueType: { value: "Bug", label: "Bug" },
      createdAt: "2026-07-17T10:00:00.000+0000",
      dueDate: "2026-07-31",
    });
    const body = JSON.parse(String(requests[0]?.init?.body));
    expect(body.fields.project).toEqual({ id: "10000" });
    expect(body.fields.description).toMatchObject({ type: "doc", version: 1 });
    expect(requests[1]?.url).toContain("/rest/api/3/issue/OPS-4");
    expect(requests[1]?.url).toContain("project");
  });

  test("keeps searches scoped and requests project data for target validation", async () => {
    const issue = {
      id: "10001",
      key: "OPS-4",
      self: "https://example.atlassian.net/rest/api/3/issue/10001",
      fields: {
        summary: "Targeted issue",
        status: { name: "To Do" },
        project: { id: "10000" },
        labels: [],
        updated: "2026-07-18T10:00:00.000+0000",
      },
    };
    const { fetcher, requests } = mockFetch([{ issues: [issue] }]);
    const adapter = new JiraCloudIssuesAdapter(
      jiraProfile,
      jiraTarget,
      { email: "r@example.com", token: "secret" },
      fetcher,
    );

    expect((await adapter.search("targeted", 1))[0]?.identifier).toBe("OPS-4");
    const body = JSON.parse(String(requests[0]?.init?.body));
    expect(body.jql).toContain('project = "10000"');
    expect(body.fields).toContain("project");
  });

  test("lists matching statuses with constrained JQL and truncation metadata", async () => {
    const issue = {
      id: "10001",
      key: "OPS-4",
      self: "https://example.atlassian.net/rest/api/3/issue/10001",
      fields: {
        summary: "Active work",
        status: { name: "In Progress" },
        project: { id: "10000" },
        labels: ["doing"],
        updated: "2026-07-18T10:00:00.000+0000",
      },
    };
    const { fetcher, requests } = mockFetch([{ issues: [issue], isLast: false }]);
    const adapter = new JiraCloudIssuesAdapter(
      jiraProfile,
      jiraTarget,
      { email: "r@example.com", token: "secret" },
      fetcher,
    );

    const result = await adapter.list({
      matches: [
        {
          states: ["In Progress", "In Review"],
          labelsAll: ["doing"],
          labelsNone: ["paused"],
        },
      ],
      limit: 1,
    });

    expect(result).toMatchObject({ truncated: true, issues: [{ identifier: "OPS-4" }] });
    const body = JSON.parse(String(requests[0]?.init?.body));
    expect(body.jql).toContain('project = "10000"');
    expect(body.jql).toContain('status in ("In Progress", "In Review")');
    expect(body.jql).toContain('labels = "doing"');
    expect(body.jql).toContain('labels != "paused" OR labels is EMPTY');
    expect(body.jql).toContain("ORDER BY updated DESC");
    expect(body.fields).toContain("project");
  });

  test("rejects an issue outside the configured project", async () => {
    const issue = {
      id: "10001",
      key: "OTHER-4",
      self: "https://example.atlassian.net/rest/api/3/issue/10001",
      fields: {
        summary: "Wrong project",
        status: { name: "To Do" },
        project: { id: "20000" },
        labels: [],
        updated: "2026-07-18T10:00:00.000+0000",
      },
    };
    const { fetcher } = mockFetch([issue]);
    const adapter = new JiraCloudIssuesAdapter(
      jiraProfile,
      jiraTarget,
      { email: "r@example.com", token: "secret" },
      fetcher,
    );

    await expect(adapter.get("OTHER-4")).rejects.toMatchObject({
      code: "ISSUE_OUTSIDE_TARGET",
    });
  });

  test("lists and searches users assignable to the configured project", async () => {
    const users = [
      {
        accountId: "account-john-smith",
        displayName: "John Smith",
        emailAddress: "john.smith@example.com",
        active: true,
      },
      {
        accountId: "account-richard",
        displayName: "Richard Sandoval",
        active: true,
      },
    ];
    const { fetcher, requests } = mockFetch([users, [users[1]]]);
    const adapter = new JiraCloudIssuesAdapter(
      jiraProfile,
      jiraTarget,
      { email: "r@example.com", token: "secret" },
      fetcher,
    );

    expect(await adapter.listUsers(1)).toMatchObject({
      users: [
        {
          provider: "jira-cloud",
          assignee: "account-john-smith",
          displayName: "John Smith",
          username: null,
          email: "john.smith@example.com",
          active: true,
        },
      ],
      truncated: true,
    });
    expect(await adapter.searchUsers("Richard", 10)).toMatchObject({
      users: [{ assignee: "account-richard", email: null }],
      truncated: false,
    });
    expect(requests.map(({ url }) => decodeURIComponent(url))).toEqual([
      "https://example.atlassian.net/rest/api/3/user/assignable/search?project=10000&maxResults=2&startAt=0",
      "https://example.atlassian.net/rest/api/3/user/assignable/search?project=10000&query=Richard&maxResults=11&startAt=0",
    ]);
  });

  test("reports project-scoped issue types and priorities", async () => {
    const { fetcher, requests } = mockFetch([
      {
        issueTypes: [
          { id: "10001", name: "Bug", subtask: false },
          { id: "10002", name: "Task", subtask: false },
        ],
        startAt: 0,
        maxResults: 100,
        total: 2,
      },
      {
        values: [
          { id: "1", name: "Highest" },
          { id: "2", name: "High" },
        ],
        isLast: true,
      },
    ]);
    const adapter = new JiraCloudIssuesAdapter(
      jiraProfile,
      jiraTarget,
      { email: "r@example.com", token: "secret" },
      fetcher,
    );

    const result = await adapter.capabilities();

    expect(result.fields.find(({ field }) => field === "labels")).toMatchObject({
      acceptsCustomValues: true,
      options: [],
    });
    expect(result.fields.find(({ field }) => field === "priority")?.options).toEqual([
      { value: "Highest", label: "Highest" },
      { value: "High", label: "High" },
    ]);
    expect(result.fields.find(({ field }) => field === "issueType")).toMatchObject({
      defaultValue: "Task",
      discoveryTool: "search_issue_options",
      optionsTruncated: false,
      options: [
        { value: "Bug", label: "Bug" },
        { value: "Task", label: "Task" },
      ],
    });
    expect(requests.map(({ url }) => decodeURIComponent(url))).toEqual([
      "https://example.atlassian.net/rest/api/3/issue/createmeta/10000/issuetypes?maxResults=100&startAt=0",
      "https://example.atlassian.net/rest/api/3/priority/search?projectId=10000&maxResults=100&startAt=0",
    ]);
  });

  test("searches only project-available priorities and creatable issue types", async () => {
    const { fetcher, requests } = mockFetch([
      {
        values: [
          { id: "1", name: "Highest" },
          { id: "2", name: "High" },
        ],
        isLast: true,
      },
      {
        issueTypes: [
          { id: "10001", name: "Bug", subtask: false },
          { id: "10002", name: "Task", subtask: false },
          { id: "10003", name: "Sub-task", subtask: true },
        ],
        total: 3,
      },
    ]);
    const adapter = new JiraCloudIssuesAdapter(
      jiraProfile,
      jiraTarget,
      { email: "r@example.com", token: "secret" },
      fetcher,
    );

    expect(await adapter.searchOptions("priority", "high", 1)).toEqual({
      options: [{ value: "Highest", label: "Highest" }],
      truncated: true,
    });
    expect(await adapter.searchOptions("issueType", "task", 10)).toEqual({
      options: [{ value: "Task", label: "Task" }],
      truncated: false,
    });
    expect(requests.map(({ url }) => decodeURIComponent(url))).toEqual([
      "https://example.atlassian.net/rest/api/3/priority/search?projectId=10000&maxResults=100&startAt=0",
      "https://example.atlassian.net/rest/api/3/issue/createmeta/10000/issuetypes?maxResults=100&startAt=0",
    ]);
    await expect(adapter.searchOptions("labels", "bug", 10)).rejects.toMatchObject({
      code: "ISSUE_OPTION_FIELD_UNSUPPORTED",
    });
  });
});

test("identity binding rejects a different account", () => {
  expect(() =>
    assertExpectedIdentity(githubProfile, {
      provider: "github",
      principalId: "2",
      principalName: "someone-else",
      scopeId: "github.com",
      scopeName: "github.com",
    }),
  ).toThrow("identity mismatch");
});
