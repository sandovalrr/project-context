import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getPaths } from "./paths.ts";

const PROJECTS_STARTER = `# project-context host-local project registry
# Copy a project entry from the shipped example, then run "project-context config validate".
version: 1
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

async function createFile(path: string, content: string, created: string[]): Promise<void> {
  try {
    await writeFile(path, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
    created.push(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}

export async function setupHostConfiguration(): Promise<{ created: string[] }> {
  const paths = getPaths();
  const created: string[] = [];
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

  await createFile(paths.projectsFile, PROJECTS_STARTER, created);
  await createFile(paths.credentialsFile, CREDENTIALS_STARTER, created);
  await createFile(join(paths.templatesDirectory, "bug-report.md"), BUG_TEMPLATE, created);
  await createFile(join(paths.templatesDirectory, "feature-request.md"), FEATURE_TEMPLATE, created);

  return { created };
}
