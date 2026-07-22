import { describe, expect, mock, test } from "bun:test";
import { HostedLinearMcpConnector } from "../src/providers/linear-mcp.ts";

const toolProperties = {
  get_issue: ["id", "includeRelations"],
  get_user: ["query"],
  list_comments: ["issueId", "limit", "cursor", "orderBy"],
  list_cycles: ["teamId", "type"],
  list_issue_labels: ["team", "name", "limit", "cursor"],
  list_issue_statuses: ["team"],
  list_issues: [
    "team",
    "project",
    "query",
    "limit",
    "cursor",
    "orderBy",
    "includeArchived",
    "parentId",
  ],
  list_milestones: ["project"],
  list_users: ["team", "query", "limit", "cursor"],
  save_comment: ["id", "issueId", "parentId", "body"],
  save_issue: [
    "id",
    "title",
    "description",
    "team",
    "project",
    "state",
    "assignee",
    "priority",
    "labels",
    "cycle",
    "milestone",
    "dueDate",
    "parentId",
    "estimate",
    "blocks",
    "blockedBy",
    "relatedTo",
    "duplicateOf",
    "removeBlocks",
    "removeBlockedBy",
    "removeRelatedTo",
  ],
} as const;

function response(id: unknown, result: unknown): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function tools(missingProperty?: string) {
  return Object.entries(toolProperties).map(([name, properties]) => ({
    name,
    inputSchema: {
      type: "object",
      properties: Object.fromEntries(
        properties
          .filter((property) => `${name}.${property}` !== missingProperty)
          .map((property) => [property, {}]),
      ),
    },
  }));
}

function protocolFetch(options: { missingProperty?: string; toolError?: boolean } = {}) {
  return mock(async (url: string | URL | Request, init?: RequestInit) => {
    expect(String(url)).toBe("https://mcp.linear.app/mcp");
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer secret");
    expect(init?.redirect).toBe("error");

    const request = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (request?.method === "notifications/initialized") {
      return new Response(null, { status: 202 });
    }
    if (request?.method === "initialize") {
      return response(request.id, {
        protocolVersion: request.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "Linear MCP", version: "1.0.0" },
      });
    }
    if (request?.method === "tools/list") {
      return response(request.id, { tools: tools(options.missingProperty) });
    }
    if (request?.method === "tools/call") {
      return response(request.id, {
        isError: options.toolError,
        content: [
          {
            type: "text",
            text: options.toolError
              ? "provider leaked secret-value"
              : JSON.stringify({ id: "ENG-1" }),
          },
        ],
      });
    }

    throw new Error(`unexpected request ${JSON.stringify(request)}`);
  }) as unknown as typeof fetch;
}

describe("hosted Linear MCP connector", () => {
  test("connects with bearer authentication and calls only the typed tool interface", async () => {
    const fetcher = protocolFetch();
    const connector = new HostedLinearMcpConnector("secret", fetcher);

    expect(
      await connector.withSession((session) => session.call("get_issue", { id: "ENG-1" })),
    ).toEqual({ id: "ENG-1" });
  });

  test("fails closed when an allowlisted upstream tool contract changes", async () => {
    const connector = new HostedLinearMcpConnector(
      "secret",
      protocolFetch({ missingProperty: "save_issue.project" }),
    );

    await expect(
      connector.withSession((session) => session.call("get_issue", { id: "ENG-1" })),
    ).rejects.toMatchObject({ code: "LINEAR_MCP_CAPABILITY_MISMATCH" });
  });

  test("redacts upstream tool error content", async () => {
    const connector = new HostedLinearMcpConnector("secret", protocolFetch({ toolError: true }));

    try {
      await connector.withSession((session) => session.call("get_issue", { id: "ENG-1" }));
      throw new Error("expected tool error");
    } catch (error) {
      expect(error).toMatchObject({ code: "LINEAR_MCP_TOOL_ERROR" });
      expect(String(error)).not.toContain("secret-value");
    }
  });

  test("rejects non-allowlisted tool inputs such as SLA fields before transport", async () => {
    const fetcher = protocolFetch();
    const connector = new HostedLinearMcpConnector("secret", fetcher);

    await expect(
      connector.withSession((session) =>
        session.call("save_issue", {
          id: "ENG-1",
          slaBreachesAt: "2026-08-01T00:00:00Z",
        }),
      ),
    ).rejects.toMatchObject({ code: "LINEAR_MCP_INPUT_UNSAFE" });
    const calls = (fetcher as unknown as ReturnType<typeof mock>).mock.calls;
    expect(
      calls.filter(([, init]) => String(init?.body ?? "").includes('"method":"tools/call"')),
    ).toHaveLength(0);
  });

  test("rejects declared responses above the provider response limit", async () => {
    const oversizedFetch = mock(
      async () =>
        new Response("{}", {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "Content-Length": String(2 * 1024 * 1024 + 1),
          },
        }),
    ) as unknown as typeof fetch;
    const connector = new HostedLinearMcpConnector("secret", oversizedFetch);

    await expect(
      connector.withSession((session) => session.call("get_issue", { id: "ENG-1" })),
    ).rejects.toMatchObject({ code: "PROVIDER_RESPONSE_TOO_LARGE" });
  });
});
