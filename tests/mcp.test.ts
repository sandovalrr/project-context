import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ListRootsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createProjectIssuesServer } from "../src/mcp.ts";
import { withTemporaryDirectory } from "./helpers/temporary.ts";

afterEach(async () => {
  delete process.env.PROJECT_CONTEXT_CONFIG_DIR;
  delete process.env.PROJECT_CONTEXT_STATE_DIR;
});

describe("provider-neutral MCP server", () => {
  test("advertises a versioned project-context server with explicit tool contracts", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createProjectIssuesServer();
    const client = new Client({ name: "test-client", version: "1.0.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    expect(client.getServerVersion()).toMatchObject({ name: "project-context" });

    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name).toSorted()).toEqual([
      "apply_issue_change",
      "get_issue",
      "list_issues",
      "prepare_issue_change",
      "resolve_project_context",
      "search_issues",
    ]);
    expect(tools.tools.every((tool) => tool.outputSchema !== undefined)).toBe(true);
    expect(tools.tools.find((tool) => tool.name === "get_issue")?.outputSchema).toMatchObject({
      properties: {
        result: {
          properties: {
            providerAlias: { type: "string" },
            issue: { type: "object" },
          },
        },
        error: {
          properties: {
            code: { type: "string" },
            message: { type: "string" },
          },
        },
      },
    });
    expect(tools.tools.find((tool) => tool.name === "get_issue")?.annotations?.readOnlyHint).toBe(
      true,
    );
    const searchTool = tools.tools.find((tool) => tool.name === "search_issues");
    expect(searchTool?.description).toContain("titles and descriptions");
    expect(JSON.stringify(searchTool?.inputSchema)).toContain("not a status or structured filter");
    const listTool = tools.tools.find((tool) => tool.name === "list_issues");
    expect(listTool?.description).toContain("canonical status");
    expect(listTool?.inputSchema).toMatchObject({
      properties: {
        statuses: {
          type: "array",
          items: { enum: ["open", "in_progress", "done", "canceled"] },
        },
        all: { type: "boolean" },
        limit: { type: "integer", minimum: 1, maximum: 100 },
      },
    });
    expect(listTool?.annotations?.readOnlyHint).toBe(true);
    expect(
      tools.tools.find((tool) => tool.name === "apply_issue_change")?.annotations?.destructiveHint,
    ).toBe(true);

    await client.close();
    await server.close();
  });

  test("initializes without configuration and returns an actionable setup error", async () => {
    await withTemporaryDirectory("project-context-mcp-", async (directory) => {
      process.env.PROJECT_CONTEXT_CONFIG_DIR = join(directory, "config");
      process.env.PROJECT_CONTEXT_STATE_DIR = join(directory, "state");

      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const server = createProjectIssuesServer();
      const client = new Client({ name: "test-client", version: "1.0.0" });
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      const response = (await client.callTool({
        name: "resolve_project_context",
        arguments: { cwd: directory },
      })) as {
        isError?: boolean;
        content: Array<{ type: string; text?: string }>;
        structuredContent?: { error?: { code?: string } };
      };
      const content = response.content[0];
      if (content?.type !== "text" || !content.text) {
        throw new Error("missing MCP text error");
      }
      const error = JSON.parse(content.text);

      expect(response.isError).toBe(true);
      expect(response.structuredContent?.error?.code).toBe("CONFIG_NOT_FOUND");
      expect(error).toMatchObject({ error: "CONFIG_NOT_FOUND" });
      expect(error.message).toContain("@sandovalrr/project-context-mcp@");
      expect(error.message).toContain("project-context setup");
      await expect(stat(process.env.PROJECT_CONTEXT_CONFIG_DIR)).rejects.toThrow();

      await client.close();
      await server.close();
    });
  });

  test("rejects an explicit working directory outside client filesystem roots", async () => {
    await withTemporaryDirectory("project-context-roots-", async (directory) => {
      const allowed = join(directory, "allowed");
      const outside = join(directory, "outside");
      await Promise.all([mkdir(allowed), mkdir(outside)]);

      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const server = createProjectIssuesServer();
      const client = new Client(
        { name: "test-client", version: "1.0.0" },
        { capabilities: { roots: {} } },
      );
      client.setRequestHandler(ListRootsRequestSchema, () => ({
        roots: [{ uri: pathToFileURL(allowed).href }],
      }));
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      const response = (await client.callTool({
        name: "resolve_project_context",
        arguments: { cwd: outside },
      })) as { isError?: boolean; content: Array<{ type: string; text?: string }> };
      const content = response.content[0];
      if (content?.type !== "text" || !content.text) {
        throw new Error("missing MCP text error");
      }

      expect(response.isError).toBe(true);
      expect(JSON.parse(content.text)).toMatchObject({
        error: "WORKING_DIRECTORY_OUTSIDE_ROOTS",
      });

      await client.close();
      await server.close();
    });
  });
});
