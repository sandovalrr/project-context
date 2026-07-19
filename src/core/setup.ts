import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ProjectContextError } from "./errors.ts";
import { getPaths } from "./paths.ts";
import { promptVisible } from "./prompt.ts";

type GuidedProvider = "linear" | "github" | "jira-cloud";

interface GuidedSetupAnswers {
  provider: GuidedProvider;
  alias: string;
  credentialVariable: string;
  emailVariable?: string;
  identity: Record<string, unknown>;
}

const PROJECTS_STARTER = `# project-context host-local project registry
# Copy a project entry from the shipped example, then run "project-context config validate".
version: 2
providers: {}
projects: {}
`;

const CREDENTIALS_STARTER = `# project-context host-local credential registry
# Use "project-context credential add <alias>" instead of placing secrets here.
version: 1
credentials: {}
`;

const BUG_TEMPLATE = `## Summary

{{summary}}

## Steps to reproduce

{{steps_to_reproduce}}

## Expected behavior

{{expected_behavior}}

## Actual behavior

{{actual_behavior}}
`;

const FEATURE_TEMPLATE = `## Problem

{{problem}}

## Proposed outcome

{{proposed_outcome}}

## Acceptance criteria

{{acceptance_criteria}}
`;

async function createFile(path: string, content: string): Promise<string | undefined> {
  try {
    await writeFile(path, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
    return path;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return undefined;
  }
}

export async function setupHostConfiguration(): Promise<{ created: string[] }> {
  const paths = getPaths();
  for (const directory of [
    paths.configDirectory,
    paths.templatesDirectory,
    paths.secretsDirectory,
    paths.stateDirectory,
    paths.backupsDirectory,
    paths.pendingDirectory,
  ]) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
  }

  const created = (
    await Promise.all([
      createFile(paths.projectsFile, PROJECTS_STARTER),
      createFile(paths.credentialsFile, CREDENTIALS_STARTER),
      createFile(join(paths.templatesDirectory, "bug-report.md"), BUG_TEMPLATE),
      createFile(join(paths.templatesDirectory, "feature-request.md"), FEATURE_TEMPLATE),
    ])
  ).filter((path): path is string => path !== undefined);

  return { created };
}

function jiraCredentialFields(
  emailVariable: string | undefined,
  token: { source: string; variable: string },
) {
  if (!emailVariable || !/^[A-Z_][A-Z0-9_]*$/.test(emailVariable)) {
    throw new ProjectContextError(
      "CONFIG_ENVIRONMENT_INVALID",
      "Jira email environment variable must use uppercase shell variable syntax",
    );
  }
  return {
    email: { source: "environment", variable: emailVariable },
    token,
  };
}

export function guidedSetupPlan(answers: GuidedSetupAnswers) {
  if (!/^[a-z][a-z0-9-]{0,62}$/.test(answers.alias)) {
    throw new ProjectContextError(
      "CONFIG_ALIAS_INVALID",
      "Provider alias must use lowercase kebab-case",
    );
  }
  if (!/^[A-Z_][A-Z0-9_]*$/.test(answers.credentialVariable)) {
    throw new ProjectContextError(
      "CONFIG_ENVIRONMENT_INVALID",
      "Token environment variable must use uppercase shell variable syntax",
    );
  }
  const providerProfile = {
    type: answers.provider,
    credential: answers.alias,
    expected_identity: answers.identity,
  };
  const token = { source: "environment", variable: answers.credentialVariable };
  const fields =
    answers.provider === "jira-cloud"
      ? jiraCredentialFields(answers.emailVariable, token)
      : { token };
  const credential = { fields };

  return {
    provider_alias: answers.alias,
    provider_profile: providerProfile,
    credential,
    next_steps: [
      "Copy provider_profile into providers in projects.yaml.",
      "Copy credential into credentials in credentials.yaml.",
      "Add a repository entry and provider target using examples/projects.example.yaml.",
      `Export ${answers.credentialVariable} only in the MCP client environment.`,
      "Run project-context config validate and project-context doctor.",
    ],
  };
}

async function guidedProvider(): Promise<GuidedProvider> {
  const provider = await promptVisible("Provider (linear, github, jira-cloud): ");
  if (provider === "linear" || provider === "github" || provider === "jira-cloud") return provider;
  throw new ProjectContextError(
    "CONFIG_PROVIDER_INVALID",
    "Provider must be linear, github, or jira-cloud",
  );
}

async function guidedIdentity(provider: GuidedProvider): Promise<Record<string, unknown>> {
  if (provider === "linear") {
    const id = await promptVisible("Expected Linear workspace ID: ");
    const name = await promptVisible("Expected Linear workspace name: ");
    return { workspace: { id, name } };
  }
  if (provider === "github") {
    const login = await promptVisible("Expected GitHub login: ");
    return { login, host: "github.com" };
  }
  const site = await promptVisible("Expected Jira site (example.atlassian.net): ");
  const accountId = await promptVisible("Expected Jira account ID: ");
  return { site, account_id: accountId };
}

export async function guidedSetup() {
  const setup = await setupHostConfiguration();
  const provider = await guidedProvider();
  const alias = await promptVisible("Provider profile alias: ");
  const credentialVariable = await promptVisible("Token environment variable: ");
  const emailVariable =
    provider === "jira-cloud" ? await promptVisible("Email environment variable: ") : undefined;
  const identity = await guidedIdentity(provider);

  return {
    ...setup,
    guided: guidedSetupPlan({
      provider,
      alias,
      credentialVariable,
      ...(emailVariable ? { emailVariable } : {}),
      identity,
    }),
  };
}
