#!/usr/bin/env bun
import { stat } from "node:fs/promises";
import {
  loadCredentialConfig,
  loadProjectsConfig,
  validateRegistryReferences,
} from "./core/config.ts";
import { resolveProjectContext } from "./core/context.ts";
import { errorMessage, ProjectContextError } from "./core/errors.ts";
import { getPaths } from "./core/paths.ts";
import { setupHostConfiguration } from "./core/setup.ts";

const HELP = `project-context

Usage:
  project-context setup
  project-context resolve [--cwd <path>]
  project-context explain [--cwd <path>]
  project-context doctor [--cwd <path>]
  project-context config validate
  project-context config migrate
  project-context --help
`;

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
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
