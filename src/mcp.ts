import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { resolveProjectContext } from "./core/context.ts";
import { errorMessage, ProjectContextError } from "./core/errors.ts";
import { resolveMcpWorkingDirectory } from "./core/mcp-working-directory.ts";
import {
  applyIssueOperation,
  getIssue,
  listIssues,
  prepareIssueOperation,
  searchIssues,
} from "./core/operations.ts";
import type { IssueOperationRequest } from "./core/pending.ts";
import { CANONICAL_STATUSES } from "./core/types.ts";
import { PACKAGE_VERSION, SERVER_NAME, setupCommand } from "./metadata.ts";

const providerTypeSchema = z.enum(["linear", "github", "jira-cloud"]);
const issueSchema = z.object({
  provider: providerTypeSchema,
  id: z.string(),
  identifier: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  status: z.string(),
  labels: z.array(z.string()),
  url: z.string().url(),
  updatedAt: z.string(),
  version: z.string(),
});
const resolveResultSchema = z.object({
  repository: z.object({
    id: z.string(),
    git_root: z.string(),
    origin: z.string().nullable(),
    match_source: z.enum(["origin", "remote-alias", "path-alias"]),
  }),
  issues: z.object({
    default_provider: z.string(),
    configured_providers: z.array(z.string()),
    selected: z.object({
      alias: z.string(),
      type: providerTypeSchema,
      profile: z.string(),
      target: z.record(z.string(), z.unknown()),
      credential_alias: z.string(),
      credential_available: z.boolean(),
    }),
  }),
});
const searchResultSchema = z.array(
  z.object({ providerAlias: z.string(), issues: z.array(issueSchema) }),
);
const canonicalStatusSchema = z.enum(CANONICAL_STATUSES);
const listResultSchema = z.array(
  z.object({
    providerAlias: z.string(),
    issues: z.array(issueSchema.extend({ canonicalStatus: canonicalStatusSchema.nullable() })),
    truncated: z.boolean(),
  }),
);
const getResultSchema = z.object({ providerAlias: z.string(), issue: issueSchema });
const prepareResultSchema = z.object({
  token: z.string().uuid(),
  expiresAt: z.string(),
  repositoryId: z.string(),
  providerAlias: z.string(),
  providerType: providerTypeSchema,
  identity: z.object({ id: z.string(), name: z.string(), scope: z.string() }),
  operation: z.enum(["create", "update", "comment", "transition", "close", "reopen", "link"]),
  target: z.object({ identifier: z.string(), title: z.string(), version: z.string() }).optional(),
  changes: z.record(z.string(), z.unknown()),
});

function resultSchema<T extends z.ZodType>(schema: T) {
  return {
    result: schema.optional(),
    error: z.object({ code: z.string(), message: z.string() }).optional(),
  };
}

function result(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    structuredContent: { result: value },
  };
}

function errorResult(error: unknown) {
  const isMissingConfiguration =
    error instanceof ProjectContextError && error.code === "CONFIG_NOT_FOUND";
  const message = isMissingConfiguration
    ? `${error.message}. Run: ${setupCommand()}`
    : errorMessage(error);
  const structuredError = {
    code: error instanceof ProjectContextError ? error.code : "UNEXPECTED",
    message,
  };

  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ error: structuredError.code, message }),
      },
    ],
    structuredContent: { error: structuredError },
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
    { name: SERVER_NAME, version: PACKAGE_VERSION },
    {
      instructions:
        "Resolve repository context before issue work. Use list_issues for canonical status filters and search_issues only for title or description text. Reads are provider-routed. External writes require prepare_issue_change followed by apply_issue_change using the returned short-lived token.",
    },
  );

  server.registerTool(
    "resolve_project_context",
    {
      title: "Resolve project issue context",
      description: "Resolve the configured issue providers for the current Git repository.",
      inputSchema: { cwd: cwdSchema },
      outputSchema: resultSchema(resolveResultSchema),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    ({ cwd }) =>
      safely(async () => resolveProjectContext(await resolveMcpWorkingDirectory(server, cwd))),
  );

  server.registerTool(
    "list_issues",
    {
      title: "List issues",
      description:
        "List issues ordered by most recently updated, optionally filtered by canonical status in the default, selected, or all configured providers.",
      inputSchema: {
        statuses: z
          .array(canonicalStatusSchema)
          .min(1)
          .max(CANONICAL_STATUSES.length)
          .optional()
          .describe("Unique canonical statuses; omission lists all statuses"),
        cwd: cwdSchema,
        provider: providerSchema,
        all: z
          .boolean()
          .optional()
          .describe("List from all configured providers only when explicitly true"),
        limit: z.number().int().min(1).max(100).optional(),
      },
      outputSchema: resultSchema(listResultSchema),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    ({ statuses, cwd, provider, all, limit }) =>
      safely(async () =>
        listIssues({
          cwd: await resolveMcpWorkingDirectory(server, cwd),
          ...(statuses ? { statuses } : {}),
          ...(provider ? { provider } : {}),
          ...(all === undefined ? {} : { all }),
          ...(limit === undefined ? {} : { limit }),
        }),
      ),
  );

  server.registerTool(
    "search_issues",
    {
      title: "Search issues",
      description:
        "Search issue titles and descriptions in the default or explicitly selected configured provider.",
      inputSchema: {
        query: z
          .string()
          .min(1)
          .describe("Title/description text only; not a status or structured filter"),
        cwd: cwdSchema,
        provider: providerSchema,
        all: z
          .boolean()
          .optional()
          .describe("Search all configured providers only when explicitly true"),
        limit: z.number().int().min(1).max(100).optional(),
      },
      outputSchema: resultSchema(searchResultSchema),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    ({ query, cwd, provider, all, limit }) =>
      safely(async () =>
        searchIssues(query, {
          cwd: await resolveMcpWorkingDirectory(server, cwd),
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
      outputSchema: resultSchema(getResultSchema),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    ({ reference, cwd, provider }) =>
      safely(async () =>
        getIssue(reference, {
          cwd: await resolveMcpWorkingDirectory(server, cwd),
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
      outputSchema: resultSchema(prepareResultSchema),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    ({ cwd, provider, ...input }) =>
      safely(async () =>
        prepareIssueOperation(requestFromTool(input), {
          cwd: await resolveMcpWorkingDirectory(server, cwd),
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
      outputSchema: resultSchema(issueSchema),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    ({ token, cwd }) =>
      safely(async () =>
        applyIssueOperation(token, { cwd: await resolveMcpWorkingDirectory(server, cwd) }),
      ),
  );

  return server;
}

export async function startProjectIssuesStdioServer(): Promise<void> {
  await createProjectIssuesServer().connect(new StdioServerTransport());
}
