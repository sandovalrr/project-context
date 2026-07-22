#!/usr/bin/env node
import { stat } from "node:fs/promises";
import chalk, { Chalk } from "chalk";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { listAuditEvents, purgeAuditEvents } from "./core/audit.ts";
import {
  loadCredentialConfig,
  loadProjectsConfig,
  validateRegistryReferences,
} from "./core/config.ts";
import { resolveProjectContext } from "./core/context.ts";
import { addFileCredential, resolveCredentialAlias } from "./core/credentials.ts";
import { errorMessage, ProjectContextError } from "./core/errors.ts";
import {
  clientIntegrationManifest,
  genericIntegrationManifest,
  integrationClients,
} from "./core/integration.ts";
import { migrateHostConfiguration } from "./core/migrations.ts";
import {
  applyIssueOperation,
  getIssue,
  getIssueCapabilities,
  listIssueComments,
  listIssues,
  listUsers,
  prepareIssueOperation,
  searchIssueOptions,
  searchIssues,
  searchUsers,
} from "./core/operations.ts";
import { getPaths } from "./core/paths.ts";
import type { IssueOperationRequest } from "./core/pending.ts";
import { promptHidden } from "./core/prompt.ts";
import { guidedSetup, setupHostConfiguration } from "./core/setup.ts";
import { installProjectIssuesSkill, projectIssuesSkillStatus } from "./core/skill.ts";
import { statusFilterWarnings } from "./core/status.ts";
import { CANONICAL_STATUSES, type CanonicalStatus } from "./core/types.ts";
import { startProjectIssuesStdioServer } from "./mcp.ts";
import { PACKAGE_VERSION } from "./metadata.ts";

const issueOptionFields = ["labels", "priority", "issueType", "cycle", "milestone"] as const;

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

  try {
    const projects = await loadProjectsConfig(paths.projectsFile);
    const statusChecks = Object.entries(projects.projects).flatMap(([repositoryId, project]) =>
      Object.entries(project.issues.providers).map(([providerAlias, provider]) => {
        const warnings = statusFilterWarnings(provider);

        return {
          check: `status-filter:${repositoryId}:${providerAlias}`,
          status: warnings.length === 0 ? ("ok" as const) : ("warning" as const),
          detail:
            warnings.length === 0 ? "all canonical statuses are listable" : warnings.join("; "),
        };
      }),
    );
    checks.push(...statusChecks);
  } catch {
    // The configuration check above already reports the actionable parse or schema error.
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
  for (const key of [
    "title",
    "description",
    "assignee",
    "priority",
    "dueDate",
    "estimate",
    "cycle",
    "milestone",
    "parent",
    "duplicateOf",
  ] as const) {
    if (argv[key] !== undefined) fields[key] = argv[key];
  }
  if (argv.label !== undefined) fields.labels = argv.label;
  if (argv.issueType !== undefined) fields.issueType = argv.issueType;
  for (const key of [
    "blocks",
    "blockedBy",
    "relatedTo",
    "removeBlocks",
    "removeBlockedBy",
    "removeRelatedTo",
  ] as const) {
    if (argv[key] !== undefined) fields[key] = argv[key];
  }
  if (argv.clearAssignee === true) fields.assignee = null;
  if (argv.clearIssueType === true) fields.issueType = null;
  if (argv.clearDueDate === true) fields.dueDate = null;
  if (argv.clearEstimate === true) fields.estimate = null;
  if (argv.clearCycle === true) fields.cycle = null;
  if (argv.clearMilestone === true) fields.milestone = null;
  if (argv.clearParent === true) fields.parent = null;
  if (argv.clearDuplicateOf === true) fields.duplicateOf = null;
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
    return {
      operation,
      identifier,
      body: argv.body,
      ...(typeof argv.commentId === "string" ? { commentId: argv.commentId } : {}),
      ...(typeof argv.parentCommentId === "string"
        ? { parentCommentId: argv.parentCommentId }
        : {}),
    };
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
  .version(PACKAGE_VERSION)
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
    (command) =>
      command.option("guided", {
        type: "boolean",
        default: false,
        description: "Interactively produce provider and credential configuration snippets",
      }),
    async (argv) => print(argv.guided ? await guidedSetup() : await setupHostConfiguration(), argv),
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
        "Preview schema migration status; --apply performs an available migration",
        (command) =>
          command.option("apply", {
            type: "boolean",
            default: false,
            description: "Apply the previewed migration with backups and atomic replacement",
          }),
        async (argv) => {
          print(await migrateHostConfiguration({ apply: argv.apply }), argv);
        },
      )
      .demandCommand(1, "Choose validate or migrate")
      .strictCommands(),
  )
  .command("audit", "Inspect or purge the local metadata-only mutation audit", (audit) =>
    audit
      .command(
        "list",
        "List recent mutation audit metadata",
        (command) =>
          command.option("limit", {
            type: "number",
            default: 100,
            description: "Maximum events to return (1-10000)",
          }),
        async (argv) => print(await listAuditEvents(argv.limit), argv),
      )
      .command(
        "purge",
        "Delete all local mutation audit files",
        (command) =>
          command.option("yes", {
            type: "boolean",
            default: false,
            description: "Confirm permanent deletion",
          }),
        async (argv) => {
          if (!argv.yes) {
            throw new ProjectContextError("CONFIRMATION_REQUIRED", "Audit purge requires --yes");
          }
          print(await purgeAuditEvents(), argv);
        },
      )
      .demandCommand(1, "Choose list or purge")
      .strictCommands(),
  )
  .command("skill", "Inspect or explicitly install the optional project-issues skill", (skill) =>
    skill
      .command(
        "status",
        "Compare the installed skill with this package version",
        () => {},
        async (argv) => print(await projectIssuesSkillStatus(), argv),
      )
      .command(
        "install",
        "Install the packaged skill without changing MCP configuration",
        (command) =>
          command.option("replace", {
            type: "boolean",
            default: false,
            description: "Back up and replace an existing skill after reviewing skill status",
          }),
        async (argv) => print(await installProjectIssuesSkill({ replace: argv.replace }), argv),
      )
      .demandCommand(1, "Choose status or install")
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
  .command("issue", "List, search, read, preview, and apply issue operations", (issue) =>
    issue
      .option("provider", { type: "string", description: "Explicit configured provider alias" })
      .command(
        "capabilities",
        "Get supported fields, options, statuses, defaults, and creation presets",
        (command) =>
          command
            .option("all", {
              type: "boolean",
              default: false,
              description: "Get capabilities from all configured providers",
            })
            .conflicts("all", "provider"),
        async (argv) =>
          print(
            await getIssueCapabilities({
              cwd: argv.cwd ?? process.cwd(),
              ...(argv.provider ? { provider: argv.provider } : {}),
              all: argv.all,
            }),
            argv,
          ),
      )
      .command("option", "Search reusable issue field options", (option) =>
        option
          .command(
            "search <field> <query>",
            "Search target-scoped labels, priorities, issue types, cycles, or milestones",
            (command) =>
              command
                .positional("field", {
                  type: "string",
                  choices: issueOptionFields,
                  demandOption: true,
                })
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
                await searchIssueOptions(argv.field, argv.query, {
                  cwd: argv.cwd ?? process.cwd(),
                  ...(argv.provider ? { provider: argv.provider } : {}),
                  all: argv.all,
                  limit: argv.limit,
                }),
                argv,
              ),
          )
          .demandCommand(1, "Choose search")
          .strictCommands(),
      )
      .command("user", "List or search users assignable to issues", (user) =>
        user
          .command(
            "list",
            "List active users assignable in the configured provider target",
            (command) =>
              command
                .option("all", {
                  type: "boolean",
                  default: false,
                  description: "List from all configured providers",
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
                await listUsers({
                  cwd: argv.cwd ?? process.cwd(),
                  ...(argv.provider ? { provider: argv.provider } : {}),
                  all: argv.all,
                  limit: argv.limit,
                }),
                argv,
              ),
          )
          .command(
            "search <query>",
            "Search active assignable users by name, username, or email",
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
                await searchUsers(argv.query, {
                  cwd: argv.cwd ?? process.cwd(),
                  ...(argv.provider ? { provider: argv.provider } : {}),
                  all: argv.all,
                  limit: argv.limit,
                }),
                argv,
              ),
          )
          .demandCommand(1, "Choose list or search")
          .strictCommands(),
      )
      .command("comment", "Read issue comments", (comment) =>
        comment
          .command(
            "list <reference>",
            "List target-scoped comments newest first",
            (command) =>
              command
                .positional("reference", { type: "string", demandOption: true })
                .option("limit", {
                  type: "number",
                  default: 30,
                  description: "Maximum comments to return",
                })
                .check((argv) => {
                  if (!Number.isInteger(argv.limit) || argv.limit < 1 || argv.limit > 100) {
                    throw new Error("--limit must be an integer between 1 and 100");
                  }
                  return true;
                }),
            async (argv) =>
              print(
                await listIssueComments(argv.reference, {
                  cwd: argv.cwd ?? process.cwd(),
                  ...(argv.provider ? { provider: argv.provider } : {}),
                  limit: argv.limit,
                }),
                argv,
              ),
          )
          .demandCommand(1, "Choose list")
          .strictCommands(),
      )
      .command(
        "list",
        "List issues by canonical status in the default, selected, or all configured providers",
        (command) =>
          command
            .option("status", {
              type: "string",
              array: true,
              choices: CANONICAL_STATUSES,
              description: "Canonical status; repeat for multiple statuses",
            })
            .option("all", {
              type: "boolean",
              default: false,
              description: "List from all configured providers",
            })
            .option("limit", {
              type: "number",
              default: 30,
              description: "Maximum results per provider",
            })
            .option("include-archived", {
              type: "boolean",
              default: false,
              description: "Include archived issues when the provider supports it",
            })
            .option("parent", {
              type: "string",
              description: "List direct subissues of this target-scoped parent",
            })
            .conflicts("all", "provider")
            .check((argv) => {
              if (!Number.isInteger(argv.limit) || argv.limit < 1 || argv.limit > 100) {
                throw new Error("--limit must be an integer between 1 and 100");
              }
              if (argv.status && new Set(argv.status).size !== argv.status.length) {
                throw new Error("--status values must be unique");
              }
              return true;
            }),
        async (argv) =>
          print(
            await listIssues({
              cwd: argv.cwd ?? process.cwd(),
              ...(argv.provider ? { provider: argv.provider } : {}),
              all: argv.all,
              ...(argv.status ? { statuses: argv.status as CanonicalStatus[] } : {}),
              limit: argv.limit,
              includeArchived: argv.includeArchived,
              ...(argv.parent ? { parent: argv.parent } : {}),
            }),
            argv,
          ),
      )
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
        (command) =>
          command
            .positional("reference", { type: "string", demandOption: true })
            .option("include-relations", {
              type: "boolean",
              default: false,
              description:
                "Include target-validated parent, subissue, blocking, related, and duplicate relations",
            }),
        async (argv) =>
          print(
            await getIssue(argv.reference, {
              cwd: argv.cwd ?? process.cwd(),
              ...(argv.provider ? { provider: argv.provider } : {}),
              includeRelations: argv.includeRelations,
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
            .option("issue-type", {
              type: "string",
              description: "Provider-native issue type",
            })
            .option("clear-issue-type", { type: "boolean", default: false })
            .option("due-date", { type: "string", description: "Due date in YYYY-MM-DD format" })
            .option("estimate", { type: "number", description: "Non-negative issue estimate" })
            .option("cycle", { type: "string", description: "Target-team cycle name or ID" })
            .option("milestone", {
              type: "string",
              description: "Target-project milestone name or ID",
            })
            .option("parent", {
              type: "string",
              description: "Target-scoped parent issue identifier for a subissue",
            })
            .option("blocks", {
              type: "array",
              string: true,
              description: "Target-scoped issue this issue blocks; repeat as needed",
            })
            .option("blocked-by", {
              type: "array",
              string: true,
              description: "Target-scoped blocker issue; repeat as needed",
            })
            .option("related-to", {
              type: "array",
              string: true,
              description: "Target-scoped related issue; repeat as needed",
            })
            .option("duplicate-of", {
              type: "string",
              description: "Target-scoped issue this issue duplicates",
            })
            .option("remove-blocks", { type: "array", string: true })
            .option("remove-blocked-by", { type: "array", string: true })
            .option("remove-related-to", { type: "array", string: true })
            .option("clear-due-date", { type: "boolean", default: false })
            .option("clear-estimate", { type: "boolean", default: false })
            .option("clear-cycle", { type: "boolean", default: false })
            .option("clear-milestone", { type: "boolean", default: false })
            .option("clear-parent", { type: "boolean", default: false })
            .option("clear-duplicate-of", { type: "boolean", default: false })
            .option("preset", { type: "string", description: "Explicit named creation preset" })
            .option("body", { type: "string", description: "Comment body" })
            .option("comment-id", {
              type: "string",
              description: "Existing target-issue comment to edit",
            })
            .option("parent-comment-id", {
              type: "string",
              description: "Existing target-issue comment to reply to",
            })
            .option("status", {
              type: "string",
              choices: ["open", "in_progress", "done", "canceled"] as const,
              description: "Canonical destination status",
            })
            .option("url", { type: "string", description: "Related issue HTTPS URL" })
            .conflicts("assignee", "clear-assignee")
            .conflicts("due-date", "clear-due-date")
            .conflicts("estimate", "clear-estimate")
            .conflicts("cycle", "clear-cycle")
            .conflicts("issue-type", "clear-issue-type")
            .conflicts("milestone", "clear-milestone")
            .conflicts("parent", "clear-parent")
            .conflicts("duplicate-of", "clear-duplicate-of")
            .conflicts("comment-id", "parent-comment-id"),
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
        "Print the generic manifest or native configuration for an MCP client",
        (command) =>
          command.option("client", {
            type: "string",
            choices: integrationClients,
            description: "Emit ready-to-paste configuration for this MCP client",
          }),
        (argv) => {
          if (!argv.client) {
            print(genericIntegrationManifest(), argv);
            return;
          }

          const manifest = clientIntegrationManifest(argv.client);
          if (argv.json) {
            print(manifest, argv);
            return;
          }

          console.log(
            manifest.format === "toml"
              ? manifest.configuration
              : JSON.stringify(manifest.configuration, null, 2),
          );
        },
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
