import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createProjectIssuesServer } from "../src/mcp.ts";

describe("provider-neutral MCP server", () => {
  test("advertises only issue-context tools with safe annotations", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createProjectIssuesServer();
    const client = new Client({ name: "test-client", version: "1.0.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
      "apply_issue_change",
      "get_issue",
      "prepare_issue_change",
      "resolve_project_context",
      "search_issues",
    ]);
    expect(tools.tools.find((tool) => tool.name === "get_issue")?.annotations?.readOnlyHint).toBe(
      true,
    );
    expect(
      tools.tools.find((tool) => tool.name === "apply_issue_change")?.annotations?.destructiveHint,
    ).toBe(true);

    await client.close();
    await server.close();
  });
});
