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
    expect(await adapter.search("broken")).toHaveLength(1);
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
});

describe("Linear adapter", () => {
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
        labels: [],
        updated: "2026-07-18T10:00:00.000+0000",
      },
    };
    const { fetcher, requests } = mockFetch([{ id: "10001", key: "OPS-4" }, issue]);
    const adapter = new JiraCloudIssuesAdapter(
      jiraProfile,
      jiraTarget,
      { email: "r@example.com", token: "secret" },
      fetcher,
    );

    expect(
      (await adapter.create({ title: "Broken build", description: "Details" })).description,
    ).toBe("Details");
    const body = JSON.parse(String(requests[0]?.init?.body));
    expect(body.fields.project).toEqual({ id: "10000" });
    expect(body.fields.description).toMatchObject({ type: "doc", version: 1 });
    expect(requests[1]?.url).toContain("/rest/api/3/issue/OPS-4");
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
