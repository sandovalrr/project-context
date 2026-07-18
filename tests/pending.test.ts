import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getPaths } from "../src/core/paths.ts";
import {
  claimPendingChange,
  createPendingChange,
  markPendingChangeIndeterminate,
  readPendingChange,
  validatePendingChange,
} from "../src/core/pending.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  delete process.env.PROJECT_CONTEXT_STATE_DIR;
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "project-context-pending-"));
  temporaryDirectories.push(directory);
  process.env.PROJECT_CONTEXT_STATE_DIR = directory;
  return createPendingChange(
    {
      repositoryId: "github.com/example/repository",
      gitRoot: "/work/repository",
      configHash: "config-1",
      providerAlias: "github",
      identityHash: "identity-1",
      expectedIssueVersion: "issue-1:v1",
      request: { operation: "comment", identifier: "#1", body: "A comment" },
    },
    new Date("2026-07-18T10:00:00Z"),
  );
}

describe("two-phase issue changes", () => {
  test("stores a 10-minute, mode-0600 preview", async () => {
    const pending = await fixture();
    expect(pending.expiresAt).toBe("2026-07-18T10:10:00.000Z");
    const path = join(getPaths().pendingDirectory, `${pending.token}.json`);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await readFile(path, "utf8")).not.toContain("A comment");
    expect((await readPendingChange(pending.token)).request).toMatchObject({
      operation: "comment",
      identifier: "#1",
    });
  });

  test("invalidates the preview when configuration changes", async () => {
    const pending = await fixture();
    await expect(
      validatePendingChange(
        pending,
        {
          repositoryId: pending.repositoryId,
          gitRoot: pending.gitRoot,
          configHash: "config-2",
          providerAlias: pending.providerAlias,
          identityHash: pending.identityHash,
          issueVersion: "issue-1:v1",
        },
        new Date("2026-07-18T10:01:00Z"),
      ),
    ).rejects.toThrow("configuration changed");
    await expect(
      readFile(join(getPaths().pendingDirectory, `${pending.token}.json`)),
    ).rejects.toThrow();
  });

  test("invalidates the preview when the issue version changes", async () => {
    const pending = await fixture();
    await expect(
      validatePendingChange(
        pending,
        {
          repositoryId: pending.repositoryId,
          gitRoot: pending.gitRoot,
          configHash: pending.configHash,
          providerAlias: pending.providerAlias,
          identityHash: pending.identityHash,
          issueVersion: "issue-1:v2",
        },
        new Date("2026-07-18T10:01:00Z"),
      ),
    ).rejects.toThrow("Issue changed");
  });

  test("invalidates expired previews", async () => {
    const pending = await fixture();
    await expect(
      validatePendingChange(
        pending,
        {
          repositoryId: pending.repositoryId,
          gitRoot: pending.gitRoot,
          configHash: pending.configHash,
          providerAlias: pending.providerAlias,
          identityHash: pending.identityHash,
          issueVersion: "issue-1:v1",
        },
        new Date("2026-07-18T10:10:00Z"),
      ),
    ).rejects.toThrow("expired");
  });

  test("invalidates a modified preview payload", async () => {
    const pending = await fixture();
    const path = join(getPaths().pendingDirectory, `${pending.token}.json`);
    const stored = JSON.parse(await readFile(path, "utf8"));
    const modified = { ...stored, ciphertext: `${stored.ciphertext.slice(0, -2)}AA` };
    await writeFile(path, JSON.stringify(modified));

    await expect(readPendingChange(pending.token)).rejects.toThrow("integrity check");
    await expect(readFile(path)).rejects.toThrow();
  });

  test("deletes malformed preview envelopes", async () => {
    const pending = await fixture();
    const path = join(getPaths().pendingDirectory, `${pending.token}.json`);
    await writeFile(path, "not-json");

    await expect(readPendingChange(pending.token)).rejects.toThrow("invalid envelope");
    await expect(readFile(path)).rejects.toThrow();
  });

  test("allows only one apply attempt and preserves indeterminate state", async () => {
    const pending = await fixture();
    const claimed = await claimPendingChange(pending.token);
    expect(claimed.request).toMatchObject({ operation: "comment", identifier: "#1" });

    await expect(claimPendingChange(pending.token)).rejects.toThrow("already being applied");
    await markPendingChangeIndeterminate(pending.token);
    await expect(readPendingChange(pending.token)).rejects.toThrow("indeterminate");
  });
});
