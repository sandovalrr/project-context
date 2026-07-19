import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const executeFile = promisify(execFile);
const tarballArgument = process.argv[2];
if (!tarballArgument) throw new Error("Pass the npm tarball path");

const tarball = await realpath(tarballArgument);

const directory = await mkdtemp(join(tmpdir(), "project-context-package-"));
try {
  await executeFile("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball], {
    cwd: directory,
    maxBuffer: 16 * 1024 * 1024,
  });
  const packageRoot = join(directory, "node_modules", "@sandovalrr", "project-context-mcp");
  const metadata = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  if (metadata.dependencies && Object.keys(metadata.dependencies).length > 0) {
    throw new Error("Published package must not install runtime dependencies");
  }
  const expectedBins = {
    "project-context": "dist/project-context.js",
    "project-context-mcp": "dist/project-context-mcp.js",
  };
  if (JSON.stringify(metadata.bin) !== JSON.stringify(expectedBins)) {
    throw new Error(`Published package has invalid command shims: ${JSON.stringify(metadata.bin)}`);
  }

  const cliPath = join(packageRoot, "dist", "project-context.js");
  const mcpPath = join(packageRoot, "dist", "project-context-mcp.js");
  const installedCli = await realpath(join(directory, "node_modules", ".bin", "project-context"));
  const installedMcp = await realpath(
    join(directory, "node_modules", ".bin", "project-context-mcp"),
  );
  if (installedCli !== (await realpath(cliPath)) || installedMcp !== (await realpath(mcpPath))) {
    throw new Error("npm command shims do not resolve to the packaged executables");
  }
  const version = await executeFile(installedCli, ["--version"]);
  if (version.stdout.trim() !== metadata.version)
    throw new Error("CLI version does not match package");

  const client = new Client({ name: "packed-artifact-test", version: "1.0.0" });
  const transport = new StdioClientTransport({ command: process.execPath, args: [mcpPath] });
  await client.connect(transport);
  const tools = await client.listTools();
  const names = tools.tools.map((tool) => tool.name).toSorted();
  const expected = [
    "apply_issue_change",
    "get_issue",
    "list_issues",
    "prepare_issue_change",
    "resolve_project_context",
    "search_issues",
  ];
  if (JSON.stringify(names) !== JSON.stringify(expected)) {
    throw new Error(`Unexpected packed MCP tools: ${names.join(", ")}`);
  }
  if (tools.tools.some((tool) => !tool.outputSchema)) {
    throw new Error("Packed MCP tools must declare output schemas");
  }
  await client.close();
} finally {
  await rm(directory, { recursive: true, force: true });
}
