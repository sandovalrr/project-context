import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadCredentialConfig,
  loadProjectsConfig,
  validateRegistryReferences,
} from "../src/core/config.ts";
import { migrateHostConfiguration } from "../src/core/migrations.ts";
import { getPaths } from "../src/core/paths.ts";
import { guidedSetupPlan, setupHostConfiguration } from "../src/core/setup.ts";
import { withTemporaryDirectory } from "./helpers/temporary.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  delete process.env.PROJECT_CONTEXT_CONFIG_DIR;
  delete process.env.PROJECT_CONTEXT_STATE_DIR;
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("configuration", () => {
  test("loads the shipped examples and validates their references", async () => {
    const projects = await loadProjectsConfig("examples/projects.example.yaml");
    const credentials = await loadCredentialConfig("examples/credentials.example.yaml");

    expect(projects.version).toBe(1);
    expect(credentials.version).toBe(1);
    expect(() => validateRegistryReferences(projects, credentials)).not.toThrow();
  });

  test("rejects a default provider that is missing from the project", async () => {
    const directory = await mkdtemp(join(tmpdir(), "project-context-config-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "projects.yaml");
    await writeFile(
      path,
      [
        "version: 1",
        "providers:",
        "  github-acme:",
        "    type: github",
        "    credential: github-acme",
        "    expected_identity:",
        "      login: acme-bot",
        "      host: github.com",
        "projects:",
        "  github.com/acme/payments:",
        "    issues:",
        "      default: linear",
        "      providers:",
        "        github:",
        "          type: github",
        "          profile: github-acme",
        "          target:",
        "            repository: inherit",
        "",
      ].join("\n"),
    );

    await expect(loadProjectsConfig(path)).rejects.toThrow("default provider");
  });

  test("rejects a project provider whose profile has a different type", async () => {
    const projects = await loadProjectsConfig("examples/projects.example.yaml");
    const credentials = await loadCredentialConfig("examples/credentials.example.yaml");
    const provider =
      projects.projects["github.com/example/example-repository"]?.issues.providers.linear;
    if (!provider) throw new Error("test fixture missing provider");
    provider.profile = "github-example";

    expect(() => validateRegistryReferences(projects, credentials)).toThrow("type does not match");
  });
});

describe("setupHostConfiguration", () => {
  test("creates secure starter configuration without overwriting it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "project-context-home-"));
    temporaryDirectories.push(directory);
    process.env.PROJECT_CONTEXT_CONFIG_DIR = join(directory, "config");
    process.env.PROJECT_CONTEXT_STATE_DIR = join(directory, "state");

    const first = await setupHostConfiguration();
    expect(first.created).toContain(getPaths().projectsFile);

    await writeFile(
      getPaths().projectsFile,
      "version: 1\nproviders: {}\nprojects: {}\n# keep-me\n",
    );
    const second = await setupHostConfiguration();

    expect(second.created).toHaveLength(0);
    expect(await readFile(getPaths().projectsFile, "utf8")).toContain("# keep-me");
  });

  test("host configuration fails closed when group or world readable", async () => {
    const directory = await mkdtemp(join(tmpdir(), "project-context-home-"));
    temporaryDirectories.push(directory);
    process.env.PROJECT_CONTEXT_CONFIG_DIR = join(directory, "config");
    process.env.PROJECT_CONTEXT_STATE_DIR = join(directory, "state");
    await setupHostConfiguration();
    await chmod(getPaths().credentialsFile, 0o644);

    await expect(loadCredentialConfig(getPaths().credentialsFile)).rejects.toThrow("mode-0600");
  });
});

describe("guidedSetupPlan", () => {
  test("produces non-secret provider and credential snippets", () => {
    const plan = guidedSetupPlan({
      provider: "github",
      alias: "github-example",
      credentialVariable: "GITHUB_EXAMPLE_TOKEN",
      identity: { login: "example-user", host: "github.com" },
    });

    expect(plan.provider_profile).toEqual({
      type: "github",
      credential: "github-example",
      expected_identity: { login: "example-user", host: "github.com" },
    });
    expect(plan.credential).toEqual({
      fields: { token: { source: "environment", variable: "GITHUB_EXAMPLE_TOKEN" } },
    });
    expect(JSON.stringify(plan)).not.toContain("secret");
  });
});

describe("configuration migrations", () => {
  test("previews and explicitly applies an unversioned v0 registry with backups", async () => {
    await withTemporaryDirectory("project-context-migration-", async (directory) => {
      process.env.PROJECT_CONTEXT_CONFIG_DIR = join(directory, "config");
      process.env.PROJECT_CONTEXT_STATE_DIR = join(directory, "state");
      await mkdir(process.env.PROJECT_CONTEXT_CONFIG_DIR, { recursive: true, mode: 0o700 });
      await Promise.all([
        writeFile(
          join(process.env.PROJECT_CONTEXT_CONFIG_DIR, "projects.yaml"),
          "providers: {}\nprojects: {}\n",
          { mode: 0o600 },
        ),
        writeFile(
          join(process.env.PROJECT_CONTEXT_CONFIG_DIR, "credentials.yaml"),
          "credentials: {}\n",
          { mode: 0o600 },
        ),
      ]);

      const preview = await migrateHostConfiguration();
      expect(preview).toMatchObject({ needed: true, applied: false });
      expect(preview.files).toHaveLength(2);
      expect(await readFile(getPaths().projectsFile, "utf8")).not.toContain("version:");

      const applied = await migrateHostConfiguration({ apply: true });
      expect(applied).toMatchObject({ needed: true, applied: true });
      expect(applied.backups).toHaveLength(2);
      expect((await loadProjectsConfig(getPaths().projectsFile)).version).toBe(1);
      expect((await loadCredentialConfig(getPaths().credentialsFile)).version).toBe(1);
      const backupMetadata = await Promise.all((applied.backups ?? []).map((path) => stat(path)));
      expect(backupMetadata.every((metadata) => metadata.isFile())).toBe(true);
    });
  });

  test("rejects configuration created by a newer schema", async () => {
    await withTemporaryDirectory("project-context-migration-", async (directory) => {
      process.env.PROJECT_CONTEXT_CONFIG_DIR = join(directory, "config");
      process.env.PROJECT_CONTEXT_STATE_DIR = join(directory, "state");
      await mkdir(process.env.PROJECT_CONTEXT_CONFIG_DIR, { recursive: true, mode: 0o700 });
      await Promise.all([
        writeFile(
          join(process.env.PROJECT_CONTEXT_CONFIG_DIR, "projects.yaml"),
          "version: 2\nproviders: {}\nprojects: {}\n",
          { mode: 0o600 },
        ),
        writeFile(
          join(process.env.PROJECT_CONTEXT_CONFIG_DIR, "credentials.yaml"),
          "version: 1\ncredentials: {}\n",
          { mode: 0o600 },
        ),
      ]);

      await expect(migrateHostConfiguration()).rejects.toThrow("future schema version 2");
    });
  });
});
