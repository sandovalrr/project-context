#!/usr/bin/env bun
import { stat } from "node:fs/promises";
import chalk, { Chalk } from "chalk";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import {
  loadCredentialConfig,
  loadProjectsConfig,
  validateRegistryReferences,
} from "./core/config.ts";
import { resolveProjectContext } from "./core/context.ts";
import { addFileCredential, resolveCredentialAlias } from "./core/credentials.ts";
import { errorMessage, ProjectContextError } from "./core/errors.ts";
import {
  applyIssueOperation,
  getIssue,
  prepareIssueOperation,
  searchIssues,
} from "./core/operations.ts";
import { absolutePath, getPaths } from "./core/paths.ts";
import type { IssueOperationRequest } from "./core/pending.ts";
import { promptHidden } from "./core/prompt.ts";
import { setupHostConfiguration } from "./core/setup.ts";
import { startProjectIssuesStdioServer } from "./mcp.ts";

interface OutputOptions {
  json?: boolean;
  color?: boolean;
}

function colorizeJson(value: unknown, enabled: boolean): string {
  const text = JSON.stringify(value, null, 2);
  if (!enabled || !process.stdout.isTTY) return text;
  return text.replace(
    /"(?:\\.|[^"\\])*"|\b(?:true|false|null)\b|-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/gi,
    (token, offset) => {
      if (token.startsWith('"')) {
        const rest = text.slice(Number(offset) + token.length);
        return rest.trimStart().startsWith(":") ? chalk.cyan(token) : chalk.green(token);
      }
      if (token === "true" || token === "false") return chalk.yellow(token);
      if (token === "null") return chalk.gray(token);
      return chalk.magenta(token);
    },
  );
}

function print(value: unknown, options: OutputOptions = {}): void {
  console.log(colorizeJson(value, options.color !== false && !options.json));
}

async function validateConfiguration() {
  const paths = getPaths();
  const projects = await loadProjectsConfig(paths.projectsFile);
  const credentials = await loadCredentialConfig(paths.credentialsFile);
  validateRegistryReferences(projects, credentials);
  return {
    valid: true,
    schema_version: projects.version,
    providers: Object.keys(projects.providers).length,
    projects: Object.keys(projects.projects).length,
    credentials: Object.keys(credentials.credentials).length,
  };
}

async function doctor(cwd: string) {
  const paths = getPaths();
  const checks: Array<{ check: string; status: "ok" | "warning" | "error"; detail: string }> = [];
  try {
    const result = await validateConfiguration();
    checks.push({ check: "configuration", status: "ok", detail: JSON.stringify(result) });
  } catch (error) {
    checks.push({ check: "configuration", status: "error", detail: errorMessage(error) });
  }

  for (const path of [
    paths.configDirectory,
    paths.secretsDirectory,
    paths.projectsFile,
    paths.credentialsFile,
  ]) {
    try {
      const metadata = await stat(path);
      const permissions = metadata.mode & 0o777;
      const expected = metadata.isDirectory() ? 0o700 : 0o600;
      checks.push({
        check: `permissions:${path}`,
        status: permissions === expected ? "ok" : "warning",
        detail: `mode=${permissions.toString(8)} expected=${expected.toString(8)}`,
      });
    } catch (error) {
      checks.push({ check: `exists:${path}`, status: "error", detail: errorMessage(error) });
    }
  }

  try {
    const context = await resolveProjectContext(cwd);
    checks.push({
      check: "repository-context",
      status: "ok",
      detail: `${context.repository.id} -> ${context.issues.selected.alias}`,
    });
  } catch (error) {
    checks.push({ check: "repository-context", status: "warning", detail: errorMessage(error) });
  }

  return { ok: !checks.some((check) => check.status === "error"), checks };
}

function issueFields(argv: Record<string, unknown>): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  for (const key of ["title", "description", "assignee", "priority"] as const) {
    if (argv[key] !== undefined) fields[key] = argv[key];
  }
  if (argv.label !== undefined) fields.labels = argv.label;
  if (argv.issueType !== undefined) fields.issueType = argv.issueType;
  if (argv.clearAssignee === true) fields.assignee = null;
  return fields;
}

function issuePrepareRequest(argv: Record<string, unknown>): IssueOperationRequest {
  const operation = String(argv.operation ?? "");
  if (operation === "create") {
    const input = issueFields(argv);
    if (typeof input.title !== "string" || !input.title) {
      throw new ProjectContextError("ARGUMENT_REQUIRED", "create requires --title");
    }
    return {
      operation,
      input,
      ...(typeof argv.preset === "string" ? { preset: argv.preset } : {}),
    };
  }
  const identifier = typeof argv.ref === "string" ? argv.ref : undefined;
  if (!identifier) {
    throw new ProjectContextError("ARGUMENT_REQUIRED", `${operation} requires --ref`);
  }
  if (operation === "update") {
    const input = issueFields(argv);
    if (Object.keys(input).length === 0) {
      throw new ProjectContextError(
        "ARGUMENT_REQUIRED",
        "update requires at least one changed field",
      );
    }
    return { operation, identifier, input };
  }
  if (operation === "comment") {
    if (typeof argv.body !== "string") {
      throw new ProjectContextError("ARGUMENT_REQUIRED", "comment requires --body");
    }
    return { operation, identifier, body: argv.body };
  }
  if (operation === "transition") {
    if (typeof argv.status !== "string") {
      throw new ProjectContextError("ARGUMENT_REQUIRED", "transition requires --status");
    }
    return { operation, identifier, status: argv.status };
  }
  if (operation === "close" || operation === "reopen") return { operation, identifier };
  if (operation === "link") {
    if (typeof argv.url !== "string") {
      throw new ProjectContextError("ARGUMENT_REQUIRED", "link requires --url");
    }
    return { operation, identifier, targetUrl: argv.url };
  }
  throw new ProjectContextError("OPERATION_UNKNOWN", `Unknown issue operation ${operation}`);
}

const cli = yargs(hideBin(process.argv))
  .scriptName("project-context")
  .usage("$0 <command> [options]")
  .version("0.1.0")
  .option("cwd", {
    type: "string",
    normalize: true,
    global: true,
    description: "Git working directory (defaults to the current directory)",
  })
  .option("json", {
    type: "boolean",
    default: false,
    global: true,
    description: "Force plain machine-readable JSON without terminal styling",
  })
  .option("color", {
    type: "boolean",
    default: true,
    global: true,
    description: "Enable terminal colors; use --no-color to disable",
  })
  .command(
    "setup",
    "Create missing host-local configuration and state files",
    () => {},
    async (argv) => print(await setupHostConfiguration(), argv),
  )
  .command(
    ["resolve", "explain"],
    "Resolve repository identity and configured issue context",
    () => {},
    async (argv) => print(await resolveProjectContext(argv.cwd ?? process.cwd()), argv),
  )
  .command(
    "doctor",
    "Check configuration, permissions, and repository routing",
    () => {},
    async (argv) => {
      const result = await doctor(argv.cwd ?? process.cwd());
      print(result, argv);
      if (!result.ok) process.exitCode = 1;
    },
  )
  .command("config", "Validate or inspect configuration migrations", (config) =>
    config
      .command(
        "validate",
        "Validate both host-local YAML registries",
        () => {},
        async (argv) => print(await validateConfiguration(), argv),
      )
      .command(
        "migrate",
        "Preview schema migration status",
        () => {},
        async (argv) => {
          const result = await validateConfiguration();
          print(
            {
              migrated: false,
              reason: `Configuration is already schema version ${result.schema_version}`,
            },
            argv,
          );
        },
      )
      .demandCommand(1, "Choose validate or migrate")
      .strictCommands(),
  )
  .command("credential", "Add or test credential resolvers", (credential) =>
    credential
      .command(
        "add <alias>",
        "Store one credential field using hidden terminal input",
        (command) =>
          command
            .positional("alias", { type: "string", demandOption: true })
            .option("field", {
              type: "string",
              default: "token",
              description: "Credential field name",
            })
            .option("replace", {
              type: "boolean",
              default: false,
              description: "Replace an existing field",
            }),
        async (argv) => {
          const secret = await promptHidden(`Secret for ${argv.alias}.${argv.field}: `);
          print(
            await addFileCredential(argv.alias, argv.field, secret, { replace: argv.replace }),
            argv,
          );
        },
      )
      .command(
        "test <alias>",
        "Resolve a credential without printing its values",
        (command) => command.positional("alias", { type: "string", demandOption: true }),
        async (argv) => {
          const credentials = await loadCredentialConfig(getPaths().credentialsFile);
          const resolved = await resolveCredentialAlias(credentials, argv.alias);
          print({ alias: argv.alias, valid: true, fields: Object.keys(resolved).sort() }, argv);
        },
      )
      .demandCommand(1, "Choose add or test")
      .strictCommands(),
  )
  .command("issue", "Search, read, preview, and apply issue operations", (issue) =>
    issue
      .option("provider", { type: "string", description: "Explicit configured provider alias" })
      .command(
        "search <query>",
        "Search issues in the default, selected, or all configured providers",
        (command) =>
          command
            .positional("query", { type: "string", demandOption: true })
            .option("all", {
              type: "boolean",
              default: false,
              description: "Search all configured providers",
            })
            .option("limit", {
              type: "number",
              default: 30,
              description: "Maximum results per provider",
            })
            .conflicts("all", "provider")
            .check((argv) => {
              if (!Number.isInteger(argv.limit) || argv.limit < 1 || argv.limit > 100) {
                throw new Error("--limit must be an integer between 1 and 100");
              }
              return true;
            }),
        async (argv) =>
          print(
            await searchIssues(argv.query, {
              cwd: argv.cwd ?? process.cwd(),
              ...(argv.provider ? { provider: argv.provider } : {}),
              all: argv.all,
              limit: argv.limit,
            }),
            argv,
          ),
      )
      .command(
        "get <reference>",
        "Read one issue using deterministic provider routing",
        (command) => command.positional("reference", { type: "string", demandOption: true }),
        async (argv) =>
          print(
            await getIssue(argv.reference, {
              cwd: argv.cwd ?? process.cwd(),
              ...(argv.provider ? { provider: argv.provider } : {}),
            }),
            argv,
          ),
      )
      .command(
        "prepare <operation>",
        "Preview a write and return a short-lived apply token",
        (command) =>
          command
            .positional("operation", {
              type: "string",
              choices: [
                "create",
                "update",
                "comment",
                "transition",
                "close",
                "reopen",
                "link",
              ] as const,
              demandOption: true,
            })
            .option("ref", { type: "string", description: "Target issue reference or URL" })
            .option("title", { type: "string", description: "Issue title" })
            .option("description", { type: "string", description: "Issue description" })
            .option("label", {
              type: "array",
              string: true,
              description: "Issue label; repeat for multiple labels",
            })
            .option("assignee", {
              type: "string",
              description: "Provider-native assignee identifier",
            })
            .option("clear-assignee", {
              type: "boolean",
              default: false,
              description: "Remove the current assignee",
            })
            .option("priority", {
              type: "string",
              description: "Provider-native or canonical priority",
            })
            .option("issue-type", { type: "string", description: "Jira issue type for creation" })
            .option("preset", { type: "string", description: "Explicit named creation preset" })
            .option("body", { type: "string", description: "Comment body" })
            .option("status", {
              type: "string",
              choices: ["open", "in_progress", "done", "canceled"] as const,
              description: "Canonical destination status",
            })
            .option("url", { type: "string", description: "Related issue HTTPS URL" })
            .conflicts("assignee", "clear-assignee"),
        async (argv) =>
          print(
            await prepareIssueOperation(issuePrepareRequest(argv), {
              cwd: argv.cwd ?? process.cwd(),
              ...(argv.provider ? { provider: argv.provider } : {}),
            }),
            argv,
          ),
      )
      .command(
        "apply <token>",
        "Apply a preview after revalidating repository, config, identity, and issue version",
        (command) => command.positional("token", { type: "string", demandOption: true }),
        async (argv) =>
          print(await applyIssueOperation(argv.token, { cwd: argv.cwd ?? process.cwd() }), argv),
      )
      .demandCommand(1, "Choose search, get, prepare, or apply")
      .strictCommands(),
  )
  .command("integration", "Print client-neutral integration information", (integration) =>
    integration
      .command(
        "manifest",
        "Print the stdio MCP manifest and shared skill path",
        () => {},
        (argv) =>
          print(
            {
              mcp: {
                name: "project_issues",
                command: absolutePath("~/.local/bin/project-context"),
                args: ["mcp"],
                transport: "stdio",
              },
              skill: absolutePath("~/.agents/skills/project-issues"),
            },
            argv,
          ),
      )
      .demandCommand(1, "Choose manifest")
      .strictCommands(),
  )
  .command(
    "mcp",
    "Run the provider-neutral stdio MCP server",
    () => {},
    async () => startProjectIssuesStdioServer(),
  )
  .completion("completion", "Generate a shell completion script")
  .recommendCommands()
  .strict()
  .demandCommand(1, "Choose a command")
  .help()
  .alias("help", "h")
  .showHelpOnFail(Boolean(process.stderr.isTTY), "Run with --help for usage.")
  .exitProcess(false)
  .wrap(Math.min(110, yargs().terminalWidth()))
  .fail((message, error) => {
    throw error ?? new ProjectContextError("CLI_USAGE", message);
  });

try {
  await cli.parseAsync();
} catch (error) {
  const code = error instanceof ProjectContextError ? error.code : "CLI_ERROR";
  const message = errorMessage(error);
  if (process.stderr.isTTY) {
    const noColor = process.argv.includes("--no-color") || process.argv.includes("--json");
    const paint = noColor ? new Chalk({ level: 0 }) : chalk;
    console.error(`${paint.red.bold("Error:")} ${message}`);
  } else {
    console.error(JSON.stringify({ error: code, message }, null, 2));
  }
  process.exitCode = 1;
}
