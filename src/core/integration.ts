import { PACKAGE_NAME, PACKAGE_VERSION } from "../metadata.ts";
import { absolutePath } from "./paths.ts";

export const integrationClients = ["codex", "claude", "zed", "vscode"] as const;

export type IntegrationClient = (typeof integrationClients)[number];

interface ClientManifest {
  client: IntegrationClient;
  format: "json" | "toml";
  configuration: Record<string, unknown> | string;
}

function packageArguments(): string[] {
  return ["-y", `--package=${PACKAGE_NAME}@${PACKAGE_VERSION}`, "project-context-mcp"];
}

function stdioCommand() {
  return {
    command: "npx",
    args: packageArguments(),
  };
}

function codexConfiguration(): string {
  const args = packageArguments()
    .map((argument) => JSON.stringify(argument))
    .join(", ");

  return [
    "[mcp_servers.project_issues]",
    "enabled = true",
    "required = true",
    'command = "npx"',
    `args = [${args}]`,
    "startup_timeout_sec = 20",
    "tool_timeout_sec = 60",
  ].join("\n");
}

function jsonConfiguration(client: Exclude<IntegrationClient, "codex">) {
  const command = stdioCommand();

  if (client === "claude") {
    return { mcpServers: { project_issues: command } };
  }
  if (client === "zed") {
    return { context_servers: { project_issues: { ...command, env: {} } } };
  }
  return { servers: { project_issues: { type: "stdio", ...command } } };
}

export function genericIntegrationManifest() {
  return {
    mcp: {
      name: "project_issues",
      ...stdioCommand(),
      transport: "stdio",
    },
    skill: absolutePath("~/.agents/skills/project-issues"),
  };
}

export function clientIntegrationManifest(client: IntegrationClient): ClientManifest {
  if (client === "codex") {
    return { client, format: "toml", configuration: codexConfiguration() };
  }

  return { client, format: "json", configuration: jsonConfiguration(client) };
}
