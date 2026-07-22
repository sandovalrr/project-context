import { describe, expect, mock, test } from "bun:test";
import type { LinearProjectProvider, LinearProviderProfile } from "../src/core/types.ts";
import { LinearIssuesAdapter } from "../src/providers/linear.ts";
import type {
  LinearMcpConnector,
  LinearMcpSession,
  LinearMcpToolName,
} from "../src/providers/linear-mcp.ts";

const profile: LinearProviderProfile = {
  type: "linear",
  credential: "linear-work",
  expected_identity: { workspace: { id: "workspace-1", name: "Workspace" } },
};
const noProjectTarget: LinearProjectProvider["target"] = {
  team: { id: "team-1", name: "Engineering" },
  project: "none",
};
const anyProjectTarget: LinearProjectProvider["target"] = {
  team: { id: "team-1", name: "Engineering" },
  project: "any",
};
const multiProjectTarget: LinearProjectProvider["target"] = {
  team: { id: "team-1", name: "Engineering" },
  project: {
    include: [
      { id: "project-1", name: "Payments" },
      { id: "project-2", name: "Billing" },
    ],
    create_in: "project-2",
  },
};

function linearIssue(
  id: string,
  overrides: Partial<{
    teamId: string;
    projectId: string | null;
    status: string;
    labels: string[];
    updatedAt: string;
  }> = {},
) {
  return {
    id,
    title: `Issue ${id}`,
    description: "Details",
    priority: { value: 2, name: "High" },
    url: `https://linear.app/workspace/issue/${id}`,
    createdAt: "2026-07-17T10:00:00Z",
    updatedAt: overrides.updatedAt ?? "2026-07-18T10:00:00Z",
    dueDate: "2026-07-31",
    status: overrides.status ?? "Backlog",
    labels: overrides.labels ?? [],
    assignee: "Richard Sandoval",
    assigneeId: "user-2",
    createdBy: "John Smith",
    createdById: "user-1",
    teamId: overrides.teamId ?? "team-1",
    ...(overrides.projectId ? { project: "Project", projectId: overrides.projectId } : {}),
  };
}

function issuePage(issues: ReturnType<typeof linearIssue>[], hasNextPage = false) {
  return { issues, hasNextPage, ...(hasNextPage ? { cursor: "next-page" } : {}) };
}

function mockConnector(
  implementation: (
    tool: LinearMcpToolName,
    input: Record<string, unknown>,
  ) => unknown | Promise<unknown>,
) {
  const call = mock(async (tool: LinearMcpToolName, input: Record<string, unknown>) =>
    implementation(tool, input),
  );
  const connector: LinearMcpConnector = {
    withSession: async <T>(work: (session: LinearMcpSession) => Promise<T>) => work({ call }),
  };

  return { connector, call };
}

function adapter(
  target: LinearProjectProvider["target"],
  connector: LinearMcpConnector,
  fetcher: typeof fetch = fetch,
) {
  return new LinearIssuesAdapter(profile, target, { token: "secret" }, fetcher, connector);
}

describe("Linear MCP issue adapter", () => {
  test("combines MCP user identity with the workspace identity security check", async () => {
    const { connector } = mockConnector((tool) => {
      expect(tool).toBe("get_user");
      return {
        id: "user-1",
        name: "Richard",
        displayName: "Richard Sandoval",
        email: "richard@example.com",
        isActive: true,
      };
    });
    const fetcher = mock(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("Authorization")).toBe("secret");
      return new Response(
        JSON.stringify({ data: { organization: { id: "workspace-1", name: "Workspace" } } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    expect(await adapter(noProjectTarget, connector, fetcher).identity()).toMatchObject({
      principalId: "user-1",
      principalName: "richard@example.com",
      scopeId: "workspace-1",
    });
  });

  test("accepts an issue only inside the configured explicit project", async () => {
    const target: LinearProjectProvider["target"] = {
      team: { id: "team-1", name: "Engineering" },
      project: { id: "project-1", name: "Payments" },
    };
    const { connector } = mockConnector((_tool, input) =>
      linearIssue(String(input.id), {
        projectId: String(input.id).endsWith("1") ? "project-1" : "project-2",
      }),
    );
    const issues = adapter(target, connector);

    expect(await issues.get("ENG-1")).toMatchObject({
      identifier: "ENG-1",
      assignee: { assignee: "user-2", displayName: "Richard Sandoval" },
      creator: { id: "user-1", displayName: "John Smith" },
      priority: { value: 2, label: "High" },
    });
    await expect(issues.get("ENG-2")).rejects.toMatchObject({ code: "ISSUE_OUTSIDE_TARGET" });
  });

  test("filters projected issues from a no-project target without returning their content", async () => {
    const sensitiveTitle = "projected issue must not escape";
    const { connector, call } = mockConnector((tool, input) => {
      expect(tool).toBe("list_issues");
      expect(input).not.toHaveProperty("project");
      return issuePage([
        { ...linearIssue("ENG-1", { projectId: "project-1" }), title: sensitiveTitle },
        linearIssue("ENG-2"),
      ]);
    });

    const result = await adapter(noProjectTarget, connector).list();

    expect(result.issues.map(({ identifier }) => identifier)).toEqual(["ENG-2"]);
    expect(JSON.stringify(result)).not.toContain(sensitiveTitle);
    expect(call).toHaveBeenCalledTimes(1);
  });

  test("admits projected and unprojected issues only within a team-wide target", async () => {
    const { connector } = mockConnector((_tool, input) =>
      linearIssue(String(input.id), {
        teamId: String(input.id).startsWith("OTHER") ? "team-2" : "team-1",
        projectId: String(input.id).endsWith("1") ? "project-1" : null,
      }),
    );
    const issues = adapter(anyProjectTarget, connector);

    expect((await issues.get("ENG-1")).identifier).toBe("ENG-1");
    expect((await issues.get("ENG-2")).identifier).toBe("ENG-2");
    await expect(issues.get("OTHER-1")).rejects.toMatchObject({ code: "ISSUE_OUTSIDE_TARGET" });
  });

  test("fans out selected projects and merges their issues in updated order", async () => {
    const { connector, call } = mockConnector((tool, input) => {
      expect(tool).toBe("list_issues");
      return input.project === "project-1"
        ? issuePage([linearIssue("ENG-1", { projectId: "project-1" })])
        : issuePage([
            linearIssue("ENG-2", {
              projectId: "project-2",
              updatedAt: "2026-07-19T10:00:00Z",
            }),
          ]);
    });

    const result = await adapter(multiProjectTarget, connector).list();

    expect(result.issues.map(({ identifier }) => identifier)).toEqual(["ENG-2", "ENG-1"]);
    expect(call.mock.calls.map(([, input]) => input.project).toSorted()).toEqual([
      "project-1",
      "project-2",
    ]);
  });

  test("passes title and description search text through the target-scoped list tool", async () => {
    const { connector, call } = mockConnector((_tool, input) =>
      issuePage([linearIssue("ENG-1", { projectId: String(input.project) })]),
    );

    expect((await adapter(multiProjectTarget, connector).search("widget", 1))[0]?.identifier).toBe(
      "ENG-1",
    );
    expect(call.mock.calls.every(([, input]) => input.query === "widget")).toBe(true);
    expect(call.mock.calls.every(([, input]) => input.includeArchived === false)).toBe(true);
  });

  test("applies canonical state and label matches after target-scoped collection", async () => {
    const { connector } = mockConnector(() =>
      issuePage([
        linearIssue("ENG-1", { status: "In Review", labels: ["doing"] }),
        linearIssue("ENG-2", { status: "Backlog", labels: ["doing"] }),
        linearIssue("ENG-3", { status: "In Progress", labels: ["paused"] }),
      ]),
    );

    const result = await adapter(noProjectTarget, connector).list({
      matches: [
        {
          states: ["In Progress", "In Review"],
          labelsAll: ["doing"],
          labelsNone: ["paused"],
        },
      ],
    });

    expect(result.issues.map(({ identifier }) => identifier)).toEqual(["ENG-1"]);
  });

  test("lists and searches only active users in the configured team", async () => {
    const users = [
      {
        id: "user-1",
        name: "John Smith",
        displayName: "John Smith",
        email: "john@example.com",
        isActive: true,
      },
      {
        id: "user-2",
        name: "Former User",
        displayName: "Former User",
        email: "former@example.com",
        isActive: false,
      },
    ];
    const { connector, call } = mockConnector((tool, input) => {
      expect(tool).toBe("list_users");
      expect(input.team).toBe("team-1");
      return { users, hasNextPage: false };
    });
    const issues = adapter(noProjectTarget, connector);

    expect((await issues.listUsers()).users).toHaveLength(1);
    expect((await issues.searchUsers("john")).users[0]).toMatchObject({ assignee: "user-1" });
    expect(call.mock.calls[1]?.[1]).toMatchObject({ query: "john" });
  });

  test("reports and searches team-scoped labels with fixed Linear priorities", async () => {
    const { connector } = mockConnector((tool, input) => {
      expect(tool).toBe("list_issue_labels");
      const labels = [
        { id: "label-1", name: "bug" },
        { id: "label-2", name: "backend" },
      ].filter(({ name }) => !input.name || name.includes(String(input.name)));
      return { labels, hasNextPage: false };
    });
    const issues = adapter(noProjectTarget, connector);

    expect(await issues.capabilities()).toMatchObject({
      fields: [
        { field: "title" },
        { field: "description" },
        { field: "labels", options: [{ value: "bug" }, { value: "backend" }] },
        { field: "assignee" },
        { field: "priority", defaultValue: 0 },
        { field: "issueType", operations: [] },
      ],
    });
    expect(await issues.searchOptions("labels", "bug", 1)).toMatchObject({
      options: [{ value: "bug", label: "bug" }],
      truncated: false,
    });
    expect((await issues.searchOptions("priority", "high")).options).toEqual([
      { value: 2, label: "High" },
    ]);
  });

  test("validates the issue target before requesting comments", async () => {
    const sensitiveBody = "comment must not escape";
    const { connector, call } = mockConnector((tool) =>
      tool === "get_issue"
        ? linearIssue("OTHER-1", { teamId: "team-2" })
        : {
            comments: [
              {
                id: "comment-1",
                body: sensitiveBody,
                createdAt: "2026-07-18T10:00:00Z",
                updatedAt: "2026-07-18T10:00:00Z",
                author: null,
              },
            ],
            hasNextPage: false,
          },
    );

    try {
      await adapter(noProjectTarget, connector).listComments("OTHER-1");
      throw new Error("expected target rejection");
    } catch (error) {
      expect(error).toMatchObject({ code: "ISSUE_OUTSIDE_TARGET" });
      expect(String(error)).not.toContain(sensitiveBody);
    }
    expect(call).toHaveBeenCalledTimes(1);
  });

  test("returns newest target-scoped comments with truncation metadata", async () => {
    const { connector } = mockConnector((tool) =>
      tool === "get_issue"
        ? linearIssue("ENG-1")
        : {
            comments: [
              {
                id: "comment-1",
                body: "Earlier",
                createdAt: "2026-07-18T10:00:00Z",
                updatedAt: "2026-07-18T10:00:00Z",
                author: { id: "user-1", name: "John Smith" },
              },
              {
                id: "comment-2",
                body: "Later",
                createdAt: "2026-07-18T11:00:00Z",
                updatedAt: "2026-07-18T11:00:00Z",
                author: null,
              },
            ],
            hasNextPage: true,
          },
    );

    expect(await adapter(noProjectTarget, connector).listComments("ENG-1", 1)).toMatchObject({
      comments: [{ id: "comment-2", body: "Later", author: null }],
      truncated: true,
    });
  });

  test("withholds fetched comments when the issue moves outside the target", async () => {
    const sensitiveBody = "fetched but never returned";
    const call = mock(async () => ({}));
    call.mockResolvedValueOnce(linearIssue("ENG-1"));
    call.mockResolvedValueOnce({
      comments: [
        {
          id: "comment-1",
          body: sensitiveBody,
          createdAt: "2026-07-18T10:00:00Z",
          updatedAt: "2026-07-18T10:00:00Z",
          author: null,
        },
      ],
      hasNextPage: false,
    });
    call.mockResolvedValueOnce(linearIssue("ENG-1", { projectId: "project-1" }));
    const connector: LinearMcpConnector = {
      withSession: async <T>(work: (session: LinearMcpSession) => Promise<T>) => work({ call }),
    };

    try {
      await adapter(noProjectTarget, connector).listComments("ENG-1");
      throw new Error("expected target rejection");
    } catch (error) {
      expect(error).toMatchObject({ code: "ISSUE_OUTSIDE_TARGET" });
      expect(String(error)).not.toContain(sensitiveBody);
    }
  });

  test("creates in the configured multi-project creation target and revalidates the result", async () => {
    const { connector, call } = mockConnector((tool, input) => {
      if (tool === "list_issue_labels") {
        return { labels: [{ id: "label-1", name: "bug" }], hasNextPage: false };
      }
      if (tool === "save_issue") return { id: "ENG-2" };
      if (tool === "get_issue") return linearIssue(String(input.id), { projectId: "project-2" });
      throw new Error(`unexpected tool ${tool}`);
    });

    expect(
      await adapter(multiProjectTarget, connector).create({
        title: "Broken build",
        labels: ["bug"],
        priority: "high",
        assignee: "user-2",
      }),
    ).toMatchObject({ identifier: "ENG-2" });
    expect(call.mock.calls.find(([tool]) => tool === "save_issue")?.[1]).toMatchObject({
      title: "Broken build",
      team: "team-1",
      project: "project-2",
      labels: ["bug"],
      priority: 2,
      assignee: "user-2",
    });
  });

  test("revalidates updates and transitions through the existing target", async () => {
    const { connector, call } = mockConnector((tool, input) => {
      if (tool === "get_issue") return linearIssue(String(input.id));
      if (tool === "list_issue_statuses") {
        return [
          { id: "state-1", name: "Backlog", type: "backlog" },
          { id: "state-2", name: "In Progress", type: "started" },
        ];
      }
      if (tool === "save_issue") return { id: String(input.id) };
      throw new Error(`unexpected tool ${tool}`);
    });
    const issues = adapter(noProjectTarget, connector);

    expect((await issues.update("ENG-1", { description: "Updated" })).identifier).toBe("ENG-1");
    expect((await issues.transition("ENG-1", "In Progress")).identifier).toBe("ENG-1");
    expect(call.mock.calls.find(([, input]) => input.state === "state-2")?.[1]).toMatchObject({
      id: "ENG-1",
      state: "state-2",
    });
  });

  test("keeps links inside the approved comment workflow", async () => {
    const { connector, call } = mockConnector((tool, input) =>
      tool === "get_issue" ? linearIssue(String(input.id)) : {},
    );

    await adapter(noProjectTarget, connector).link("ENG-1", "https://example.com/issues/2");

    expect(call.mock.calls.find(([tool]) => tool === "save_comment")?.[1]).toEqual({
      issueId: "ENG-1",
      body: "Related issue: https://example.com/issues/2",
    });
  });

  test("fails closed when Linear MCP response fields drift", async () => {
    const { connector } = mockConnector(() => ({ id: "ENG-1", title: "missing target fields" }));

    await expect(adapter(noProjectTarget, connector).get("ENG-1")).rejects.toMatchObject({
      code: "LINEAR_MCP_RESPONSE_INVALID",
    });
  });
});
