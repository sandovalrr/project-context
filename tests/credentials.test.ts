import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCredentialConfig } from "../src/core/config.ts";
import {
  addFileCredential,
  resolveCredential,
  resolveCredentialField,
} from "../src/core/credentials.ts";
import { getPaths } from "../src/core/paths.ts";
import { setupHostConfiguration } from "../src/core/setup.ts";
import type { CredentialDefinition, CredentialsConfig } from "../src/core/types.ts";
import { withTemporaryDirectory } from "./helpers/temporary.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  delete process.env.PROJECT_CONTEXT_CONFIG_DIR;
  delete process.env.PROJECT_CONTEXT_STATE_DIR;
  delete process.env.TEST_PROJECT_CONTEXT_TOKEN;
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("credential resolution", () => {
  test("resolves file, environment, and shell-free command fields", async () => {
    const directory = await mkdtemp(join(tmpdir(), "project-context-credentials-"));
    temporaryDirectories.push(directory);
    const secretFile = join(directory, "token");
    await writeFile(secretFile, "file-secret\n", { mode: 0o600 });
    process.env.TEST_PROJECT_CONTEXT_TOKEN = "environment-secret";

    const credential: CredentialDefinition = {
      fields: {
        file: { source: "file", path: secretFile },
        environment: { source: "environment", variable: "TEST_PROJECT_CONTEXT_TOKEN" },
        command: {
          source: "command",
          command: ["printf", "%s\\n", "command-secret"],
        },
      },
    };

    expect(await resolveCredential(credential)).toEqual({
      file: "file-secret",
      environment: "environment-secret",
      command: "command-secret",
    });
  });

  test("rejects literal credentials in host configuration", async () => {
    await withTemporaryDirectory("project-context-credentials-", async (directory) => {
      const path = join(directory, "credentials.yaml");
      await writeFile(
        path,
        `version: 1
credentials:
  unsafe:
    fields:
      token:
        source: literal
        value: plaintext-secret
`,
      );

      await expect(loadCredentialConfig(path)).rejects.toThrow("Invalid credential registry");
    });
  });

  test("rejects a secret file readable by group or others", async () => {
    const directory = await mkdtemp(join(tmpdir(), "project-context-credentials-"));
    temporaryDirectories.push(directory);
    const secretFile = join(directory, "token");
    await writeFile(secretFile, "secret", { mode: 0o600 });
    await chmod(secretFile, 0o644);

    await expect(resolveCredentialField({ source: "file", path: secretFile })).rejects.toThrow(
      "permissions",
    );
  });

  test("redacts command output from failures", async () => {
    const source = {
      source: "command" as const,
      command: ["sh", "-c", "printf leaked-secret >&2; exit 7"],
    };

    try {
      await resolveCredentialField(source);
      throw new Error("expected failure");
    } catch (error) {
      expect(String(error)).not.toContain("leaked-secret");
      expect(String(error)).toContain("credential command failed");
    }
  });
});

describe("credential onboarding", () => {
  test("stores a secret with mode 0600 and updates credentials.yaml", async () => {
    const directory = await mkdtemp(join(tmpdir(), "project-context-home-"));
    temporaryDirectories.push(directory);
    process.env.PROJECT_CONTEXT_CONFIG_DIR = join(directory, "config");
    process.env.PROJECT_CONTEXT_STATE_DIR = join(directory, "state");
    await setupHostConfiguration();

    await addFileCredential("linear-work", "token", "super-secret");

    const paths = getPaths();
    const secretPath = join(paths.secretsDirectory, "linear-work-token");
    expect(await readFile(secretPath, "utf8")).toBe("super-secret\n");
    expect((await stat(secretPath)).mode & 0o777).toBe(0o600);
    const config = await loadCredentialConfig(paths.credentialsFile);
    expect(config.credentials["linear-work"]?.fields.token).toEqual({
      source: "file",
      path: secretPath,
    });
  });

  test("requires explicit replacement and preserves the previous secret", async () => {
    const directory = await mkdtemp(join(tmpdir(), "project-context-home-"));
    temporaryDirectories.push(directory);
    process.env.PROJECT_CONTEXT_CONFIG_DIR = join(directory, "config");
    process.env.PROJECT_CONTEXT_STATE_DIR = join(directory, "state");
    await setupHostConfiguration();
    await addFileCredential("github-personal", "token", "first");

    await expect(addFileCredential("github-personal", "token", "second")).rejects.toThrow(
      "already exists",
    );
    expect(
      await resolveCredential(
        (await loadCredentialConfig(getPaths().credentialsFile)).credentials[
          "github-personal"
        ] as CredentialDefinition,
      ),
    ).toEqual({ token: "first" });

    await addFileCredential("github-personal", "token", "second", { replace: true });
    const config = (await loadCredentialConfig(getPaths().credentialsFile)) as CredentialsConfig;
    expect(
      await resolveCredential(config.credentials["github-personal"] as CredentialDefinition),
    ).toEqual({ token: "second" });
  });
});
