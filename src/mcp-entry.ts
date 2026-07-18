#!/usr/bin/env node
import { startProjectIssuesStdioServer } from "./mcp.ts";

startProjectIssuesStdioServer().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
