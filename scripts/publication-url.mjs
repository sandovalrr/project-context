const NPM_PACKAGE = "@sandovalrr/project-context-mcp";
const MCP_SERVER = "io.github.sandovalrr/project-context";

export function publicationUrl(version, target) {
  if (target === "npm") {
    return `https://registry.npmjs.org/${encodeURIComponent(NPM_PACKAGE)}/${version}`;
  }

  return `https://registry.modelcontextprotocol.io/v0.1/servers/${encodeURIComponent(MCP_SERVER)}/versions/${version}`;
}
