import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeRemoteUrl, resolveRepository } from "../src/core/repository.ts";
import type { ProjectsConfig } from "../src/core/types.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("normalizeRemoteUrl", () => {
  test.each([
    ["git@github.com:Acme/Payments.git", "github.com/Acme/Payments"],
    ["ssh://git@github.com/Acme/Payments.git", "github.com/Acme/Payments"],
    ["https://github.com/Acme/Payments.git", "github.com/Acme/Payments"],
    ["https://user@bitbucket.org/acme/payments/", "bitbucket.org/acme/payments"],
  ])("normalizes %s", (remote, expected) => {
    expect(normalizeRemoteUrl(remote)).toBe(expected);
  });

  test("rejects remotes without host, owner, and repository", () => {
    expect(() => normalizeRemoteUrl("not-a-remote")).toThrow("Unsupported Git remote");
  });
});

describe("resolveRepository", () => {
  test("resolves a repository by normalized origin", async () => {
    const directory = await mkdtemp(join(tmpdir(), "project-context-repo-"));
    temporaryDirectories.push(directory);
    Bun.spawnSync(["git", "init", "-q", directory]);
    Bun.spawnSync([
      "git",
      "-C",
      directory,
      "remote",
      "add",
      "origin",
      "git@github.com:acme/payments.git",
    ]);

    const config = {
      version: 2,
      providers: {},
      projects: {
        "github.com/acme/payments": {
          issues: {
            default: "github",
            providers: {
              github: {
                type: "github",
                profile: "github-acme",
                target: { repository: "inherit" },
              },
            },
          },
        },
      },
    } as unknown as ProjectsConfig;

    const resolved = await resolveRepository(config, directory);

    expect(resolved.repositoryId).toBe("github.com/acme/payments");
    expect(resolved.gitRoot).toBe(await realpath(directory));
    expect(resolved.matchSource).toBe("origin");
  });

  test("fails closed for an unconfigured repository", async () => {
    const directory = await mkdtemp(join(tmpdir(), "project-context-repo-"));
    temporaryDirectories.push(directory);
    Bun.spawnSync(["git", "init", "-q", directory]);
    Bun.spawnSync([
      "git",
      "-C",
      directory,
      "remote",
      "add",
      "origin",
      "git@github.com:acme/unknown.git",
    ]);

    const config = { version: 2, providers: {}, projects: {} } as ProjectsConfig;
    await expect(resolveRepository(config, directory)).rejects.toThrow("is not configured");
  });

  test("resolves a repository without origin through an explicit path alias", async () => {
    const directory = await mkdtemp(join(tmpdir(), "project-context-repo-"));
    temporaryDirectories.push(directory);
    Bun.spawnSync(["git", "init", "-q", directory]);
    const config = {
      version: 2,
      providers: {},
      projects: {
        "github.com/example/local-only": {
          aliases: { paths: [directory] },
          issues: {
            default: "github",
            providers: {
              github: {
                type: "github",
                profile: "github-example",
                target: { repository: "inherit" },
              },
            },
          },
        },
      },
    } as unknown as ProjectsConfig;

    const resolved = await resolveRepository(config, directory);
    expect(resolved.matchSource).toBe("path-alias");
    expect(resolved.normalizedOrigin).toBeUndefined();
  });
});
