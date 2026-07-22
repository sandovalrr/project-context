import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { lstat, mkdir, open, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ProjectContextError } from "./errors.ts";
import { getPaths } from "./paths.ts";

export type IssueOperationRequest =
  | { operation: "create"; input: Record<string, unknown>; preset?: string }
  | { operation: "update"; identifier: string; input: Record<string, unknown> }
  | {
      operation: "comment";
      identifier: string;
      body: string;
      commentId?: string;
      parentCommentId?: string;
    }
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

interface EncryptedPendingChange {
  version: 2;
  token: string;
  expiresAt: string;
  nonce: string;
  authenticationTag: string;
  ciphertext: string;
}

const ENCRYPTION_ALGORITHM = "aes-256-gcm";
const NONCE_BYTES = 12;
const KEY_BYTES = 32;

function assertToken(token: string): string {
  if (!/^[0-9a-f-]{36}$/.test(token)) {
    throw new ProjectContextError("PREVIEW_TOKEN_INVALID", "Invalid issue preview token");
  }
  return token;
}

function preparedPath(token: string): string {
  return join(getPaths().pendingDirectory, `${assertToken(token)}.json`);
}

function applyingPath(token: string): string {
  return join(getPaths().pendingDirectory, `${assertToken(token)}.applying`);
}

function indeterminatePath(token: string): string {
  return join(getPaths().pendingDirectory, `${assertToken(token)}.indeterminate.json`);
}

function authenticatedMetadata(
  envelope: Pick<EncryptedPendingChange, "version" | "token" | "expiresAt">,
) {
  return Buffer.from(
    JSON.stringify({
      version: envelope.version,
      token: envelope.token,
      expiresAt: envelope.expiresAt,
    }),
  );
}

async function previewKey(): Promise<Buffer> {
  const paths = getPaths();
  await mkdir(paths.stateDirectory, { recursive: true, mode: 0o700 });
  try {
    await writeFile(paths.previewKeyFile, randomBytes(KEY_BYTES), { mode: 0o600, flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }

  const metadata = await lstat(paths.previewKeyFile);
  if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0) {
    throw new ProjectContextError(
      "PREVIEW_KEY_UNSAFE",
      `Preview encryption key ${paths.previewKeyFile} must be a regular mode-0600 file`,
    );
  }

  const key = await readFile(paths.previewKeyFile);
  if (key.length !== KEY_BYTES) {
    throw new ProjectContextError(
      "PREVIEW_KEY_INVALID",
      `Preview encryption key ${paths.previewKeyFile} must contain ${KEY_BYTES} bytes`,
    );
  }
  return key;
}

function assertPendingChange(value: unknown): asserts value is PendingChange {
  if (!value || typeof value !== "object") {
    throw new ProjectContextError("PREVIEW_INVALID", "Stored issue preview is invalid");
  }
  const record = value as Partial<PendingChange>;
  if (
    record.version !== 1 ||
    typeof record.token !== "string" ||
    typeof record.createdAt !== "string" ||
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

function assertEnvelope(value: unknown, token: string): asserts value is EncryptedPendingChange {
  if (!value || typeof value !== "object") {
    throw new ProjectContextError("PREVIEW_INVALID", "Stored issue preview is invalid");
  }
  const envelope = value as Partial<EncryptedPendingChange>;
  if (
    envelope.version !== 2 ||
    envelope.token !== token ||
    typeof envelope.expiresAt !== "string" ||
    typeof envelope.nonce !== "string" ||
    typeof envelope.authenticationTag !== "string" ||
    typeof envelope.ciphertext !== "string"
  ) {
    throw new ProjectContextError("PREVIEW_INVALID", "Stored issue preview is invalid");
  }
}

async function encryptPendingChange(pending: PendingChange): Promise<EncryptedPendingChange> {
  const nonce = randomBytes(NONCE_BYTES);
  const envelopeMetadata = {
    version: 2 as const,
    token: pending.token,
    expiresAt: pending.expiresAt,
  };
  const cipher = createCipheriv(ENCRYPTION_ALGORITHM, await previewKey(), nonce);
  cipher.setAAD(authenticatedMetadata(envelopeMetadata));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(pending), "utf8"),
    cipher.final(),
  ]);

  return {
    ...envelopeMetadata,
    nonce: nonce.toString("base64"),
    authenticationTag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

async function decryptPendingChange(
  envelope: EncryptedPendingChange,
  path: string,
): Promise<PendingChange> {
  try {
    const decipher = createDecipheriv(
      ENCRYPTION_ALGORITHM,
      await previewKey(),
      Buffer.from(envelope.nonce, "base64"),
    );
    decipher.setAAD(authenticatedMetadata(envelope));
    decipher.setAuthTag(Buffer.from(envelope.authenticationTag, "base64"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, "base64")),
      decipher.final(),
    ]).toString("utf8");
    const pending: unknown = JSON.parse(plaintext);
    assertPendingChange(pending);
    if (pending.token !== envelope.token || pending.expiresAt !== envelope.expiresAt) {
      throw new Error("authenticated metadata does not match payload");
    }
    return pending;
  } catch (error) {
    await rm(path, { force: true });
    if (error instanceof ProjectContextError) throw error;
    throw new ProjectContextError(
      "PREVIEW_TAMPERED",
      "Stored issue preview failed its integrity check and was invalidated",
    );
  }
}

async function readEncryptedPendingChange(path: string, token: string): Promise<PendingChange> {
  const metadata = await lstat(path).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ProjectContextError("PREVIEW_NOT_FOUND", `Issue preview ${token} was not found`);
    }
    throw error;
  });
  if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0) {
    throw new ProjectContextError(
      "PREVIEW_FILE_UNSAFE",
      `Issue preview ${token} must be stored in a regular mode-0600 file`,
    );
  }
  const content = await readFile(path, "utf8");
  const value = await Promise.resolve(content)
    .then((serialized): EncryptedPendingChange => {
      const parsed: unknown = JSON.parse(serialized);
      assertEnvelope(parsed, token);
      return parsed;
    })
    .catch(async () => {
      await rm(path, { force: true });
      throw new ProjectContextError(
        "PREVIEW_TAMPERED",
        "Stored issue preview has an invalid envelope and was invalidated",
      );
    });
  return decryptPendingChange(value, path);
}

async function exists(path: string): Promise<boolean> {
  return lstat(path)
    .then(() => true)
    .catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    });
}

async function removePendingChange(token: string): Promise<void> {
  await Promise.all([
    rm(preparedPath(token), { force: true }),
    rm(applyingPath(token), { force: true }),
    rm(indeterminatePath(token), { force: true }),
  ]);
}

export async function purgeExpiredPendingChanges(now = new Date()): Promise<number> {
  const directory = getPaths().pendingDirectory;
  const entries = await readdir(directory).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  });
  const candidates = entries.filter((entry) => entry.endsWith(".json"));
  const removed = await Promise.all(
    candidates.map(async (entry) => {
      const path = join(directory, entry);
      const expiresAt = await readFile(path, "utf8")
        .then((content) => JSON.parse(content) as { expiresAt?: unknown })
        .then((value) => value.expiresAt)
        .catch(() => undefined);
      if (typeof expiresAt === "string" && new Date(expiresAt).getTime() > now.getTime()) return 0;
      await rm(path, { force: true });
      if (!entry.endsWith(".indeterminate.json")) {
        await rm(join(directory, `${entry.slice(0, -".json".length)}.applying`), { force: true });
      }
      return 1;
    }),
  );
  return removed.filter((value) => value === 1).length;
}

export async function createPendingChange(
  input: Omit<PendingChange, "version" | "token" | "createdAt" | "expiresAt">,
  now = new Date(),
): Promise<PendingChange> {
  await purgeExpiredPendingChanges(now);
  const token = crypto.randomUUID();
  const pending: PendingChange = {
    version: 1,
    token,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 10 * 60 * 1000).toISOString(),
    ...input,
  };
  await mkdir(getPaths().pendingDirectory, { recursive: true, mode: 0o700 });
  await writeFile(preparedPath(token), `${JSON.stringify(await encryptPendingChange(pending))}\n`, {
    mode: 0o600,
    flag: "wx",
  });
  return pending;
}

export async function readPendingChange(token: string): Promise<PendingChange> {
  if (await exists(indeterminatePath(token))) {
    throw new ProjectContextError(
      "PREVIEW_INDETERMINATE",
      `Issue preview ${token} has an indeterminate provider outcome and cannot be replayed`,
    );
  }
  if (await exists(applyingPath(token))) {
    throw new ProjectContextError(
      "PREVIEW_ALREADY_APPLYING",
      `Issue preview ${token} is already being applied`,
    );
  }
  return readEncryptedPendingChange(preparedPath(token), token);
}

export async function claimPendingChange(token: string): Promise<PendingChange> {
  if (await exists(indeterminatePath(token))) {
    throw new ProjectContextError(
      "PREVIEW_INDETERMINATE",
      `Issue preview ${token} has an indeterminate provider outcome and cannot be replayed`,
    );
  }
  const claim = await open(applyingPath(token), "wx", 0o600).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new ProjectContextError(
        "PREVIEW_ALREADY_APPLYING",
        `Issue preview ${token} is already being applied`,
      );
    }
    throw error;
  });
  await claim.writeFile(`${new Date().toISOString()}\n`);
  await claim.close();
  try {
    return await readEncryptedPendingChange(preparedPath(token), token);
  } catch (error) {
    await rm(applyingPath(token), { force: true });
    throw error;
  }
}

export async function markPendingChangeIndeterminate(token: string): Promise<void> {
  await rename(preparedPath(token), indeterminatePath(token)).catch((error) => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  });
  await rm(applyingPath(token), { force: true });
}

export async function validatePendingChange(
  pending: PendingChange,
  current: PendingContext,
  now = new Date(),
): Promise<void> {
  const invalidate = async (code: string, message: string) => {
    await removePendingChange(pending.token);
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
  await rm(applyingPath(token), { force: true });
  await rm(preparedPath(token), { force: true });
}
