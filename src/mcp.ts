import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { resolveProjectContext } from "./core/context.ts";
import { errorMessage, ProjectContextError } from "./core/errors.ts";
import {
  applyIssueOperation,
  getIssue,
  prepareIssueOperation,
  searchIssues,
} from "./core/operations.ts";
import type { IssueOperationRequest } from "./core/pending.ts";

function result(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    structuredContent: { result: value },
  };
}

function errorResult(error: unknown) {
  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({
          error: error instanceof ProjectContextError ? error.code : "UNEXPECTED",
          message: errorMessage(error),
        }),
      },
    ],
  };
}

async function safely<T>(work: () => Promise<T>) {
  try {
    return result(await work());
  } catch (error) {
    return errorResult(error);
  }
}

const cwdSchema = z
  .string()
  .min(1)
  .optional()
  .describe("Git working directory; defaults to the server process cwd");
const providerSchema = z.string().min(1).optional().describe("Explicit configured provider alias");

function requestFromTool(input: {
  operation: "create" | "update" | "comment" | "transition" | "close" | "reopen" | "link";
  identifier?: string | undefined;
  fields?: Record<string, unknown> | undefined;
  body?: string | undefined;
  status?: string | undefined;
  target_url?: string | undefined;
  preset?: string | undefined;
}): IssueOperationRequest {
  if (input.operation === "create") {
    return {
      operation: "create",
      input: input.fields ?? {},
      ...(input.preset ? { preset: input.preset } : {}),
    };
  }
  if (!input.identifier) {
    throw new ProjectContextError("ARGUMENT_REQUIRED", `${input.operation} requires identifier`);
  }
  if (input.operation === "update") {
    return { operation: "update", identifier: input.identifier, input: input.fields ?? {} };
  }
  if (input.operation === "comment") {
    if (!input.body) throw new ProjectContextError("ARGUMENT_REQUIRED", "comment requires body");
    return { operation: "comment", identifier: input.identifier, body: input.body };
  }
  if (input.operation === "transition") {
    if (!input.status)
      throw new ProjectContextError("ARGUMENT_REQUIRED", "transition requires status");
    return { operation: "transition", identifier: input.identifier, status: input.status };
  }
  if (input.operation === "link") {
    if (!input.target_url)
      throw new ProjectContextError("ARGUMENT_REQUIRED", "link requires target_url");
    return { operation: "link", identifier: input.identifier, targetUrl: input.target_url };
  }
  return { operation: input.operation, identifier: input.identifier };
}

export function createProjectIssuesServer(): McpServer {
  const server = new McpServer(
    { name: "project-issues", version: "0.1.0" },
    {
      instructions:
        "Resolve repository context before issue work. Reads are provider-routed. External writes require prepare_issue_change followed by apply_issue_change using the returned short-lived token.",
    },
  );

  server.registerTool(
    "resolve_project_context",
    {
      title: "Resolve project issue context",
      description: "Resolve the configured issue providers for the current Git repository.",
      inputSchema: { cwd: cwdSchema },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    ({ cwd }) => safely(() => resolveProjectContext(cwd)),
  );

  server.registerTool(
    "search_issues",
    {
      title: "Search issues",
      description: "Search the default or explicitly selected configured issue provider.",
      inputSchema: {
        query: z.string().min(1),
        cwd: cwdSchema,
        provider: providerSchema,
        all: z
          .boolean()
          .optional()
          .describe("Search all configured providers only when explicitly true"),
        limit: z.number().int().min(1).max(100).optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    ({ query, cwd, provider, all, limit }) =>
      safely(() =>
        searchIssues(query, {
          ...(cwd ? { cwd } : {}),
          ...(provider ? { provider } : {}),
          ...(all === undefined ? {} : { all }),
          ...(limit === undefined ? {} : { limit }),
        }),
      ),
  );

  server.registerTool(
    "get_issue",
    {
      title: "Get issue",
      description:
        "Get one issue using deterministic URL, qualified-reference, or identifier routing.",
      inputSchema: { reference: z.string().min(1), cwd: cwdSchema, provider: providerSchema },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    ({ reference, cwd, provider }) =>
      safely(() =>
        getIssue(reference, {
          ...(cwd ? { cwd } : {}),
          ...(provider ? { provider } : {}),
        }),
      ),
  );

  server.registerTool(
    "prepare_issue_change",
    {
      title: "Preview issue change",
      description:
        "Resolve, validate, and preview an issue write. Returns a token valid for ten minutes; does not change the external provider.",
      inputSchema: {
        operation: z.enum(["create", "update", "comment", "transition", "close", "reopen", "link"]),
        identifier: z.string().min(1).optional(),
        fields: z.record(z.string(), z.unknown()).optional(),
        body: z.string().min(1).optional(),
        status: z.enum(["open", "in_progress", "done", "canceled"]).optional(),
        target_url: z.string().url().optional(),
        preset: z.string().min(1).optional(),
        cwd: cwdSchema,
        provider: providerSchema,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    ({ cwd, provider, ...input }) =>
      safely(() =>
        prepareIssueOperation(requestFromTool(input), {
          ...(cwd ? { cwd } : {}),
          ...(provider ? { provider } : {}),
        }),
      ),
  );

  server.registerTool(
    "apply_issue_change",
    {
      title: "Apply previewed issue change",
      description:
        "Apply a previously previewed external issue change after revalidating repository, config, identity, and issue version.",
      inputSchema: { token: z.string().uuid(), cwd: cwdSchema },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    ({ token, cwd }) => safely(() => applyIssueOperation(token, { ...(cwd ? { cwd } : {}) })),
  );

  return server;
}

export async function startProjectIssuesStdioServer(): Promise<void> {
  await createProjectIssuesServer().connect(new StdioServerTransport());
}
