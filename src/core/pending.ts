import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ProjectContextError } from "./errors.ts";
import { getPaths } from "./paths.ts";

export type IssueOperationRequest =
  | { operation: "create"; input: Record<string, unknown>; preset?: string }
  | { operation: "update"; identifier: string; input: Record<string, unknown> }
  | { operation: "comment"; identifier: string; body: string }
  | { operation: "transition"; identifier: string; status: string }
  | { operation: "close"; identifier: string }
  | { operation: "reopen"; identifier: string }
  | { operation: "link"; identifier: string; targetUrl: string };

export interface PendingChange {
  version: 1;
  token: string;
  createdAt: string;
  expiresAt: string;
  repositoryId: string;
  gitRoot: string;
  configHash: string;
  providerAlias: string;
  identityHash: string;
  expectedIssueVersion?: string;
  request: IssueOperationRequest;
}

export interface PendingContext {
  repositoryId: string;
  gitRoot: string;
  configHash: string;
  providerAlias: string;
  identityHash: string;
  issueVersion?: string;
}

function pendingPath(token: string): string {
  if (!/^[0-9a-f-]{36}$/.test(token)) {
    throw new ProjectContextError("PREVIEW_TOKEN_INVALID", "Invalid issue preview token");
  }
  return join(getPaths().pendingDirectory, `${token}.json`);
}

async function previewKey(): Promise<Buffer> {
  const paths = getPaths();
  await mkdir(paths.stateDirectory, { recursive: true, mode: 0o700 });
  try {
    await writeFile(paths.previewKeyFile, randomBytes(32), { mode: 0o600, flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const metadata = await lstat(paths.previewKeyFile);
  if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0) {
    throw new ProjectContextError(
      "PREVIEW_KEY_UNSAFE",
      `Preview signing key ${paths.previewKeyFile} must be a regular mode-0600 file`,
    );
  }
  return readFile(paths.previewKeyFile);
}

async function signPendingChange(payload: PendingChange): Promise<string> {
  return createHmac("sha256", await previewKey())
    .update(JSON.stringify(payload))
    .digest("hex");
}

function assertPendingChange(value: unknown): asserts value is PendingChange {
  if (!value || typeof value !== "object") {
    throw new ProjectContextError("PREVIEW_INVALID", "Stored issue preview is invalid");
  }
  const record = value as Partial<PendingChange>;
  if (
    record.version !== 1 ||
    typeof record.token !== "string" ||
    typeof record.expiresAt !== "string" ||
    typeof record.repositoryId !== "string" ||
    typeof record.gitRoot !== "string" ||
    typeof record.configHash !== "string" ||
    typeof record.providerAlias !== "string" ||
    typeof record.identityHash !== "string" ||
    !record.request ||
    typeof record.request.operation !== "string"
  ) {
    throw new ProjectContextError("PREVIEW_INVALID", "Stored issue preview is invalid");
  }
}

export async function createPendingChange(
  input: Omit<PendingChange, "version" | "token" | "createdAt" | "expiresAt">,
  now = new Date(),
): Promise<PendingChange> {
  const token = crypto.randomUUID();
  const pending: PendingChange = {
    version: 1,
    token,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 10 * 60 * 1000).toISOString(),
    ...input,
  };
  await mkdir(getPaths().pendingDirectory, { recursive: true, mode: 0o700 });
  await writeFile(
    pendingPath(token),
    `${JSON.stringify({ payload: pending, signature: await signPendingChange(pending) })}\n`,
    { mode: 0o600, flag: "wx" },
  );
  return pending;
}

export async function readPendingChange(token: string): Promise<PendingChange> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(pendingPath(token), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ProjectContextError("PREVIEW_NOT_FOUND", `Issue preview ${token} was not found`);
    }
    throw error;
  }
  if (!value || typeof value !== "object") {
    throw new ProjectContextError("PREVIEW_INVALID", "Stored issue preview is invalid");
  }
  const wrapper = value as { payload?: unknown; signature?: unknown };
  assertPendingChange(wrapper.payload);
  if (typeof wrapper.signature !== "string" || !/^[0-9a-f]{64}$/.test(wrapper.signature)) {
    throw new ProjectContextError("PREVIEW_INVALID", "Stored issue preview signature is invalid");
  }
  const expected = Buffer.from(await signPendingChange(wrapper.payload), "hex");
  const actual = Buffer.from(wrapper.signature, "hex");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    await rm(pendingPath(token), { force: true });
    throw new ProjectContextError(
      "PREVIEW_TAMPERED",
      "Stored issue preview failed its integrity check and was invalidated",
    );
  }
  if (wrapper.payload.token !== token) {
    throw new ProjectContextError("PREVIEW_INVALID", "Stored issue preview token does not match");
  }
  return wrapper.payload;
}

export async function validatePendingChange(
  pending: PendingChange,
  current: PendingContext,
  now = new Date(),
): Promise<void> {
  const invalidate = async (code: string, message: string) => {
    await rm(pendingPath(pending.token), { force: true });
    throw new ProjectContextError(code, message);
  };
  if (new Date(pending.expiresAt).getTime() <= now.getTime()) {
    await invalidate("PREVIEW_EXPIRED", `Issue preview ${pending.token} expired`);
  }
  for (const [name, expected, actual] of [
    ["repository", pending.repositoryId, current.repositoryId],
    ["Git root", pending.gitRoot, current.gitRoot],
    ["configuration", pending.configHash, current.configHash],
    ["provider", pending.providerAlias, current.providerAlias],
    ["credential identity", pending.identityHash, current.identityHash],
  ] as const) {
    if (expected !== actual) {
      await invalidate("PREVIEW_STALE", `Issue preview is stale because ${name} changed`);
    }
  }
  if (
    pending.expectedIssueVersion !== undefined &&
    pending.expectedIssueVersion !== current.issueVersion
  ) {
    await invalidate("ISSUE_CHANGED", "Issue changed after the preview was created");
  }
}

export async function consumePendingChange(token: string): Promise<void> {
  await rm(pendingPath(token), { force: true });
}
