import { afterEach, describe, expect, test } from "bun:test";
import { readFile, stat, truncate } from "node:fs/promises";
import {
  AUDIT_MAX_BYTES,
  appendAuditEvent,
  listAuditEvents,
  purgeAuditEvents,
} from "../src/core/audit.ts";
import { getPaths } from "../src/core/paths.ts";
import { withTemporaryDirectory } from "./helpers/temporary.ts";

afterEach(async () => {
  delete process.env.PROJECT_CONTEXT_STATE_DIR;
});

async function withFixture<T>(work: (event: Parameters<typeof appendAuditEvent>[0]) => Promise<T>) {
  return withTemporaryDirectory("project-context-audit-", async (directory) => {
    process.env.PROJECT_CONTEXT_STATE_DIR = directory;
    const event = {
      operation: "comment",
      outcome: "success" as const,
      repositoryId: "github.com/example/repository",
      providerAlias: "github",
      providerType: "github",
      identityId: "example-user",
      issueIdentifier: "#1",
      issueId: "1",
    };
    return work(event);
  });
}

describe("local mutation audit", () => {
  test("lists metadata-only events and purges them explicitly", async () => {
    await withFixture(async (event) => {
      await appendAuditEvent(event);

      expect((await stat(getPaths().auditFile)).mode & 0o777).toBe(0o600);
      expect(await listAuditEvents()).toEqual([expect.objectContaining(event)]);
      expect((await listAuditEvents())[0]?.packageVersion).toMatch(/^\d+\.\d+\.\d+/);
      expect(await purgeAuditEvents()).toEqual({ removed: 1 });
      expect(await listAuditEvents()).toEqual([]);
    });
  });

  test("rotates the audit before it exceeds the bounded size", async () => {
    await withFixture(async (event) => {
      await appendAuditEvent(event);
      await truncate(getPaths().auditFile, AUDIT_MAX_BYTES);
      await appendAuditEvent({ ...event, issueIdentifier: "#2", issueId: "2" });

      expect(await readFile(`${getPaths().auditFile}.1`, "utf8")).not.toContain("#2");
      expect(await readFile(getPaths().auditFile, "utf8")).toContain('"issueIdentifier":"#2"');
    });
  });
});
