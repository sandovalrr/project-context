import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadCredentialConfig,
  loadProjectsConfig,
  validateRegistryReferences,
} from "../src/core/config.ts";
import { getPaths } from "../src/core/paths.ts";
import { setupHostConfiguration } from "../src/core/setup.ts";

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
