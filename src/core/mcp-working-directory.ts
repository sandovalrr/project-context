import { realpath } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ProjectContextError } from "./errors.ts";
import { absolutePath } from "./paths.ts";

function contains(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

async function resolvedClientRoots(server: McpServer): Promise<string[] | undefined> {
  if (!server.server.getClientCapabilities()?.roots) return undefined;

  const result = await server.server.listRoots();
  return Promise.all(
    result.roots.map(async (root) => {
      const url = new URL(root.uri);
      if (url.protocol !== "file:") {
        throw new ProjectContextError(
          "CLIENT_ROOT_UNSUPPORTED",
          `Client root ${root.uri} is not a filesystem URI`,
        );
      }
      return realpath(fileURLToPath(url));
    }),
  );
}

function assertAllowedByExactlyOneRoot(candidate: string, roots: string[]): string {
  const matches = roots.filter((root) => contains(root, candidate));
  if (matches.length === 0) {
    throw new ProjectContextError(
      "WORKING_DIRECTORY_OUTSIDE_ROOTS",
      "The requested working directory is outside the client filesystem roots",
    );
  }
  if (matches.length > 1) {
    throw new ProjectContextError(
      "WORKING_DIRECTORY_AMBIGUOUS",
      "The requested working directory belongs to multiple client filesystem roots",
    );
  }
  return candidate;
}

export async function resolveMcpWorkingDirectory(
  server: McpServer,
  explicitCwd?: string,
): Promise<string> {
  const roots = await resolvedClientRoots(server);
  if (explicitCwd) {
    const candidate = await realpath(absolutePath(explicitCwd));
    return roots?.length ? assertAllowedByExactlyOneRoot(candidate, roots) : candidate;
  }
  if (roots?.length === 1 && roots[0]) return roots[0];
  if (roots && roots.length > 1) {
    throw new ProjectContextError(
      "WORKING_DIRECTORY_AMBIGUOUS",
      "The client supplied multiple filesystem roots; pass cwd explicitly",
    );
  }

  return realpath(absolutePath(process.env.PROJECT_CONTEXT_CWD ?? process.cwd()));
}
