import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ProjectContextError } from "../core/errors.ts";

const LINEAR_MCP_URL = new URL("https://mcp.linear.app/mcp");
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

const linearMcpToolProperties = {
  get_issue: ["id"],
  get_user: ["query"],
  list_comments: ["issueId", "limit", "cursor", "orderBy"],
  list_issue_labels: ["team", "name", "limit", "cursor"],
  list_issue_statuses: ["team"],
  list_issues: ["team", "project", "query", "limit", "cursor", "orderBy", "includeArchived"],
  list_users: ["team", "query", "limit", "cursor"],
  save_comment: ["issueId", "body"],
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
  ],
} as const;

export type LinearMcpToolName = keyof typeof linearMcpToolProperties;

export interface LinearMcpSession {
  call(tool: LinearMcpToolName, input: Record<string, unknown>): Promise<unknown>;
}

export interface LinearMcpConnector {
  withSession<T>(work: (session: LinearMcpSession) => Promise<T>): Promise<T>;
}

interface ToolDefinition {
  name: string;
  inputSchema?:
    | {
        properties?: Record<string, object> | undefined;
      }
    | undefined;
}

async function readBoundedBody(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  chunks: Uint8Array[] = [],
  total = 0,
): Promise<Uint8Array> {
  const next = await reader.read();
  if (next.done) return Buffer.concat(chunks, total);

  const nextTotal = total + next.value.byteLength;
  if (nextTotal > MAX_RESPONSE_BYTES) {
    await reader.cancel();
    throw new ProjectContextError(
      "PROVIDER_RESPONSE_TOO_LARGE",
      `Linear MCP response exceeded ${MAX_RESPONSE_BYTES} bytes`,
    );
  }

  return readBoundedBody(reader, [...chunks, next.value], nextTotal);
}

async function boundedResponse(response: Response): Promise<Response> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new ProjectContextError(
      "PROVIDER_RESPONSE_TOO_LARGE",
      `Linear MCP response exceeded ${MAX_RESPONSE_BYTES} bytes`,
    );
  }
  if (!response.body) return response;

  const body = await readBoundedBody(response.body.getReader());
  const responseBody = body.buffer.slice(
    body.byteOffset,
    body.byteOffset + body.byteLength,
  ) as ArrayBuffer;

  return new Response(responseBody, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function guardedLinearMcpFetch(fetcher: typeof fetch): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const target = new URL(input instanceof Request ? input.url : input);
    if (
      target.protocol !== "https:" ||
      target.origin !== LINEAR_MCP_URL.origin ||
      target.pathname !== LINEAR_MCP_URL.pathname
    ) {
      throw new ProjectContextError(
        "PROVIDER_ORIGIN_UNSAFE",
        "Linear MCP credentials may only be sent to the approved HTTPS endpoint",
      );
    }

    const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const signal = init?.signal ? AbortSignal.any([init.signal, timeoutSignal]) : timeoutSignal;
    const response = await fetcher(target, { ...init, redirect: "error", signal }).catch(
      (error) => {
        throw new ProjectContextError(
          timeoutSignal.aborted ? "PROVIDER_TIMEOUT" : "PROVIDER_NETWORK_ERROR",
          timeoutSignal.aborted
            ? "Linear MCP request exceeded 20 seconds"
            : "Linear MCP request failed",
          { cause: error },
        );
      },
    );

    return boundedResponse(response);
  }) as typeof fetch;
}

function assertToolContract(tools: ToolDefinition[]): void {
  const byName = new Map(tools.map((tool) => [tool.name, tool]));

  for (const [name, requiredProperties] of Object.entries(linearMcpToolProperties)) {
    const tool = byName.get(name);
    const properties = tool?.inputSchema?.properties;
    const missingProperties = requiredProperties.filter(
      (property) => !Object.hasOwn(properties ?? {}, property),
    );

    if (!tool || missingProperties.length > 0) {
      throw new ProjectContextError(
        "LINEAR_MCP_CAPABILITY_MISMATCH",
        `Linear MCP tool contract is incompatible with project-context at ${name}`,
      );
    }
  }
}

function parsedToolContent(result: unknown): unknown {
  if (!result || typeof result !== "object") {
    throw new ProjectContextError(
      "LINEAR_MCP_RESPONSE_INVALID",
      "Linear MCP returned an invalid tool result",
    );
  }

  const toolResult = result as { isError?: boolean; content?: unknown };
  if (toolResult.isError) {
    throw new ProjectContextError(
      "LINEAR_MCP_TOOL_ERROR",
      "Linear MCP tool execution failed; provider details were redacted",
    );
  }

  const content = Array.isArray(toolResult.content) ? toolResult.content : [];
  const textItem = content.find((item): item is { type: "text"; text: string } =>
    Boolean(
      item &&
        typeof item === "object" &&
        (item as { type?: unknown }).type === "text" &&
        typeof (item as { text?: unknown }).text === "string",
    ),
  );
  const text = textItem?.text;
  if (!text) {
    throw new ProjectContextError(
      "LINEAR_MCP_RESPONSE_INVALID",
      "Linear MCP returned no JSON tool result",
    );
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new ProjectContextError(
      "LINEAR_MCP_RESPONSE_INVALID",
      "Linear MCP returned an invalid JSON tool result",
    );
  }
}

export class HostedLinearMcpConnector implements LinearMcpConnector {
  constructor(
    private readonly token: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async withSession<T>(work: (session: LinearMcpSession) => Promise<T>): Promise<T> {
    const client = new Client({ name: "project-context", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(LINEAR_MCP_URL, {
      fetch: guardedLinearMcpFetch(this.fetcher),
      requestInit: { headers: { Authorization: `Bearer ${this.token}` } },
    });

    try {
      await client.connect(transport as Parameters<Client["connect"]>[0]);
      const tools = await client.listTools();
      assertToolContract(tools.tools);

      return await work({
        call: async (tool, input) =>
          parsedToolContent(await client.callTool({ name: tool, arguments: input })),
      });
    } catch (error) {
      if (error instanceof ProjectContextError) throw error;
      throw new ProjectContextError(
        "LINEAR_MCP_ERROR",
        "Linear MCP request failed; provider details were redacted",
        { cause: error },
      );
    } finally {
      await client.close().catch(() => undefined);
    }
  }
}
