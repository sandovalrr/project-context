import { appendFile, lstat, mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { PACKAGE_VERSION } from "../metadata.ts";
import { ProjectContextError } from "./errors.ts";
import { getPaths } from "./paths.ts";

export interface AuditEvent {
  operation: string;
  outcome: "success" | "failure";
  repositoryId: string;
  providerAlias: string;
  providerType: string;
  identityId: string;
  issueIdentifier?: string;
  issueId?: string;
  errorCode?: string;
}

export interface StoredAuditEvent extends AuditEvent {
  timestamp: string;
  packageVersion: string;
}

export const AUDIT_MAX_BYTES = 10 * 1024 * 1024;
export const AUDIT_RETAINED_FILES = 5;

function rotationPath(index: number): string {
  return `${getPaths().auditFile}.${index}`;
}

async function fileSize(path: string): Promise<number> {
  return stat(path)
    .then((metadata) => metadata.size)
    .catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
      throw error;
    });
}

async function assertAuditFileSafe(path: string): Promise<void> {
  const metadata = await lstat(path).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  });
  if (!metadata) return;
  if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0) {
    throw new ProjectContextError(
      "AUDIT_FILE_UNSAFE",
      `Audit file ${path} must be a regular mode-0600 file`,
    );
  }
}

async function renameIfPresent(source: string, destination: string): Promise<void> {
  await rename(source, destination).catch((error) => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  });
}

async function shiftRotations(index: number): Promise<void> {
  if (index === 0) {
    await renameIfPresent(getPaths().auditFile, rotationPath(1));
    return;
  }
  await renameIfPresent(rotationPath(index), rotationPath(index + 1));
  await shiftRotations(index - 1);
}

async function rotateAudit(): Promise<void> {
  await Promise.all([
    assertAuditFileSafe(getPaths().auditFile),
    ...Array.from({ length: AUDIT_RETAINED_FILES }, (_, offset) =>
      assertAuditFileSafe(rotationPath(offset + 1)),
    ),
  ]);
  await rm(rotationPath(AUDIT_RETAINED_FILES), { force: true });
  await shiftRotations(AUDIT_RETAINED_FILES - 1);
}

export async function appendAuditEvent(event: AuditEvent): Promise<void> {
  const path = getPaths().auditFile;
  const line = `${JSON.stringify({
    timestamp: new Date().toISOString(),
    packageVersion: PACKAGE_VERSION,
    ...event,
  })}\n`;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await assertAuditFileSafe(path);
  if ((await fileSize(path)) + Buffer.byteLength(line) > AUDIT_MAX_BYTES) await rotateAudit();
  await appendFile(path, line, { mode: 0o600 });
}

async function readAuditFile(path: string): Promise<StoredAuditEvent[]> {
  await assertAuditFileSafe(path);
  const content = await readFile(path, "utf8").catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  });
  return content
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as StoredAuditEvent);
}

export async function listAuditEvents(limit = 100): Promise<StoredAuditEvent[]> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 10_000) {
    throw new ProjectContextError("AUDIT_LIMIT_INVALID", "Audit limit must be from 1 to 10000");
  }
  const paths = [
    ...Array.from({ length: AUDIT_RETAINED_FILES }, (_, offset) =>
      rotationPath(AUDIT_RETAINED_FILES - offset),
    ),
    getPaths().auditFile,
  ];
  const events = (await Promise.all(paths.map(readAuditFile))).flat();
  return events.slice(-limit);
}

export async function purgeAuditEvents(): Promise<{ removed: number }> {
  const paths = [
    getPaths().auditFile,
    ...Array.from({ length: AUDIT_RETAINED_FILES }, (_, offset) => rotationPath(offset + 1)),
  ];
  const removed = await Promise.all(
    paths.map(async (path) => {
      const present = await exists(path);
      await rm(path, { force: true });
      return present;
    }),
  );
  return { removed: removed.filter(Boolean).length };
}

async function exists(path: string): Promise<boolean> {
  return lstat(path)
    .then(() => true)
    .catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    });
}
