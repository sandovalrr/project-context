#!/usr/bin/env bun
import { stat } from "node:fs/promises";
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
import { getPaths } from "./core/paths.ts";
import type { IssueOperationRequest } from "./core/pending.ts";
import { promptHidden } from "./core/prompt.ts";
import { setupHostConfiguration } from "./core/setup.ts";

const HELP = `project-context

Usage:
  project-context setup
  project-context resolve [--cwd <path>]
  project-context explain [--cwd <path>]
  project-context doctor [--cwd <path>]
  project-context config validate
  project-context config migrate
  project-context credential add <alias> [--field <name>] [--replace]
  project-context credential test <alias>
  project-context issue search <query> [--provider <alias> | --all] [--limit <n>]
  project-context issue get <reference> [--provider <alias>]
  project-context issue prepare create --title <title> [--description <text>] [--preset <name>]
  project-context issue prepare update --ref <reference> [--title <title>] [--description <text>]
  project-context issue prepare comment --ref <reference> --body <text>
  project-context issue prepare transition --ref <reference> --status <canonical-status>
  project-context issue prepare close|reopen --ref <reference>
  project-context issue prepare link --ref <reference> --url <issue-url>
  project-context issue apply <preview-token>
  project-context --help
`;

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function requiredOption(args: string[], name: string): string {
  const value = option(args, name);
  if (!value) throw new ProjectContextError("ARGUMENT_REQUIRED", `${name} is required`);
  return value;
}

function issuePrepareRequest(args: string[]): IssueOperationRequest {
  const operation = args[2];
  if (operation === "create") {
    const input: Record<string, unknown> = { title: requiredOption(args, "--title") };
    const description = option(args, "--description");
    const preset = option(args, "--preset");
    if (description !== undefined) input.description = description;
    return {
      operation,
      input,
      ...(preset ? { preset } : {}),
    };
  }
  const identifier = requiredOption(args, "--ref");
  if (operation === "update") {
    const input: Record<string, unknown> = {};
    for (const [flag, field] of [
      ["--title", "title"],
      ["--description", "description"],
    ] as const) {
      const value = option(args, flag);
      if (value !== undefined) input[field] = value;
    }
    if (Object.keys(input).length === 0) {
      throw new ProjectContextError(
        "ARGUMENT_REQUIRED",
        "update requires at least one changed field",
      );
    }
    return { operation, identifier, input };
  }
  if (operation === "comment") {
    return { operation, identifier, body: requiredOption(args, "--body") };
  }
  if (operation === "transition") {
    return { operation, identifier, status: requiredOption(args, "--status") };
  }
  if (operation === "close" || operation === "reopen") return { operation, identifier };
  if (operation === "link") {
    return { operation, identifier, targetUrl: requiredOption(args, "--url") };
  }
  throw new ProjectContextError("OPERATION_UNKNOWN", `Unknown issue operation ${operation ?? ""}`);
}

function print(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
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

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const [command, subcommand] = args;
  if (!command || command === "--help" || command === "help") {
    console.log(HELP);
    return;
  }

  if (command === "setup") {
    print(await setupHostConfiguration());
    return;
  }
  if (command === "resolve" || command === "explain") {
    print(await resolveProjectContext(option(args, "--cwd") ?? process.cwd()));
    return;
  }
  if (command === "doctor") {
    const result = await doctor(option(args, "--cwd") ?? process.cwd());
    print(result);
    if (!result.ok) process.exitCode = 1;
    return;
  }
  if (command === "config" && subcommand === "validate") {
    print(await validateConfiguration());
    return;
  }
  if (command === "config" && subcommand === "migrate") {
    const result = await validateConfiguration();
    print({
      migrated: false,
      reason: `Configuration is already schema version ${result.schema_version}`,
    });
    return;
  }
  if (command === "credential" && subcommand === "add") {
    const alias = args[2];
    if (!alias) {
      throw new ProjectContextError("ARGUMENT_REQUIRED", "credential add requires an alias");
    }
    const field = option(args, "--field") ?? "token";
    const secret = await promptHidden(`Secret for ${alias}.${field}: `);
    print(await addFileCredential(alias, field, secret, { replace: args.includes("--replace") }));
    return;
  }
  if (command === "credential" && subcommand === "test") {
    const alias = args[2];
    if (!alias) {
      throw new ProjectContextError("ARGUMENT_REQUIRED", "credential test requires an alias");
    }
    const credentials = await loadCredentialConfig(getPaths().credentialsFile);
    const resolved = await resolveCredentialAlias(credentials, alias);
    print({ alias, valid: true, fields: Object.keys(resolved).sort() });
    return;
  }
  if (command === "issue" && subcommand === "search") {
    const query = args[2];
    if (!query) throw new ProjectContextError("ARGUMENT_REQUIRED", "issue search requires a query");
    const limitValue = option(args, "--limit");
    const limit = limitValue === undefined ? undefined : Number.parseInt(limitValue, 10);
    const provider = option(args, "--provider");
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 100)) {
      throw new ProjectContextError("ARGUMENT_INVALID", "--limit must be between 1 and 100");
    }
    print(
      await searchIssues(query, {
        cwd: option(args, "--cwd") ?? process.cwd(),
        ...(provider ? { provider } : {}),
        all: args.includes("--all"),
        ...(limit === undefined ? {} : { limit }),
      }),
    );
    return;
  }
  if (command === "issue" && subcommand === "get") {
    const reference = args[2];
    if (!reference)
      throw new ProjectContextError("ARGUMENT_REQUIRED", "issue get requires a reference");
    const provider = option(args, "--provider");
    print(
      await getIssue(reference, {
        cwd: option(args, "--cwd") ?? process.cwd(),
        ...(provider ? { provider } : {}),
      }),
    );
    return;
  }
  if (command === "issue" && subcommand === "prepare") {
    const provider = option(args, "--provider");
    print(
      await prepareIssueOperation(issuePrepareRequest(args), {
        cwd: option(args, "--cwd") ?? process.cwd(),
        ...(provider ? { provider } : {}),
      }),
    );
    return;
  }
  if (command === "issue" && subcommand === "apply") {
    const token = args[2];
    if (!token)
      throw new ProjectContextError("ARGUMENT_REQUIRED", "issue apply requires a preview token");
    print(await applyIssueOperation(token, { cwd: option(args, "--cwd") ?? process.cwd() }));
    return;
  }

  throw new ProjectContextError("COMMAND_UNKNOWN", `Unknown command: ${args.join(" ")}`);
}

try {
  await main();
} catch (error) {
  if (error instanceof ProjectContextError) {
    console.error(JSON.stringify({ error: error.code, message: error.message }, null, 2));
  } else {
    console.error(errorMessage(error));
  }
  process.exitCode = 1;
}
