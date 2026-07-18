import { spawnSync } from "node:child_process";
import { copyFile, lstat, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { stringify } from "yaml";
import { loadCredentialConfig } from "./config.ts";
import { ProjectContextError } from "./errors.ts";
import { absolutePath, getPaths } from "./paths.ts";
import type { CredentialDefinition, CredentialFieldSource, CredentialsConfig } from "./types.ts";

function requireValue(value: string, description: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new ProjectContextError("CREDENTIAL_EMPTY", `${description} returned an empty value`);
  }
  return trimmed;
}

function runSecretCommand(command: string[]): string {
  const [executable, ...args] = command;
  if (!executable) {
    throw new ProjectContextError("CREDENTIAL_COMMAND_INVALID", "Credential command is empty");
  }
  const result = spawnSync(executable, args, {
    encoding: "utf8",
    env: process.env,
    maxBuffer: 64 * 1024,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 10_000,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    const timedOut = (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
    throw new ProjectContextError(
      timedOut ? "CREDENTIAL_COMMAND_TIMEOUT" : "CREDENTIAL_COMMAND_FAILED",
      timedOut
        ? `credential command timed out: ${basename(executable)} exceeded 10 seconds`
        : `credential command failed: ${basename(executable)} exited with status ${result.status ?? "unknown"}`,
    );
  }
  return requireValue(result.stdout, `Credential command ${basename(executable)}`);
}

async function readSecretFile(path: string): Promise<string> {
  const resolved = absolutePath(path);
  const metadata = await lstat(resolved);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new ProjectContextError(
      "CREDENTIAL_FILE_INVALID",
      `Credential file ${resolved} must be a regular file and not a symbolic link`,
    );
  }
  if ((metadata.mode & 0o077) !== 0) {
    throw new ProjectContextError(
      "CREDENTIAL_FILE_PERMISSIONS",
      `Credential file ${resolved} has unsafe permissions; expected mode 0600 or stricter`,
    );
  }
  return requireValue(await readFile(resolved, "utf8"), `Credential file ${resolved}`);
}

function resolveKeychain(service: string, account: string): string {
  if (process.platform === "darwin") {
    return runSecretCommand([
      "security",
      "find-generic-password",
      "-w",
      "-s",
      service,
      "-a",
      account,
    ]);
  }
  return runSecretCommand(["secret-tool", "lookup", "service", service, "account", account]);
}

export async function resolveCredentialField(source: CredentialFieldSource): Promise<string> {
  switch (source.source) {
    case "file":
      return readSecretFile(source.path);
    case "command":
      return runSecretCommand(source.command);
    case "environment":
      return requireValue(
        process.env[source.variable] ?? "",
        `Environment variable ${source.variable}`,
      );
    case "keychain":
      return resolveKeychain(source.service, source.account);
  }
}

export async function resolveCredential(
  definition: CredentialDefinition,
): Promise<Record<string, string>> {
  const entries = await Promise.all(
    Object.entries(definition.fields).map(async ([name, source]) => [
      name,
      await resolveCredentialField(source),
    ]),
  );
  return Object.fromEntries(entries);
}

export async function resolveCredentialAlias(
  config: CredentialsConfig,
  alias: string,
): Promise<Record<string, string>> {
  const definition = config.credentials[alias];
  if (!definition) {
    throw new ProjectContextError(
      "CREDENTIAL_NOT_CONFIGURED",
      `Credential alias ${alias} is not configured`,
    );
  }
  return resolveCredential(definition);
}

function timestamp(): string {
  return new Date().toISOString().replaceAll(":", "-");
}

async function writeCredentialsAtomically(config: CredentialsConfig): Promise<void> {
  const paths = getPaths();
  const lock = await open(paths.lockFile, "wx", 0o600).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new ProjectContextError(
        "CONFIG_LOCKED",
        `Configuration is locked by another project-context process: ${paths.lockFile}`,
      );
    }
    throw error;
  });
  const temporaryPath = join(paths.configDirectory, `.credentials.${crypto.randomUUID()}.tmp`);
  try {
    await copyFile(
      paths.credentialsFile,
      join(paths.backupsDirectory, `credentials-${timestamp()}.yaml`),
    );
    await writeFile(temporaryPath, stringify(config), { mode: 0o600, flag: "wx" });
    await loadCredentialConfig(temporaryPath);
    await rename(temporaryPath, paths.credentialsFile);
  } finally {
    await rm(temporaryPath, { force: true });
    await lock.close();
    await rm(paths.lockFile, { force: true });
  }
}

function validateCredentialName(alias: string, field: string): void {
  if (!/^[a-z][a-z0-9-]{0,62}$/.test(alias)) {
    throw new ProjectContextError("CREDENTIAL_ALIAS_INVALID", `Invalid credential alias: ${alias}`);
  }
  if (!/^[a-z][a-z0-9_-]{0,62}$/.test(field)) {
    throw new ProjectContextError("CREDENTIAL_FIELD_INVALID", `Invalid credential field: ${field}`);
  }
}

export async function addFileCredential(
  alias: string,
  field: string,
  secret: string,
  options: { replace?: boolean } = {},
): Promise<{ alias: string; field: string; path: string }> {
  validateCredentialName(alias, field);
  const value = requireValue(secret, `Credential ${alias}.${field}`);
  const paths = getPaths();
  const config = await loadCredentialConfig(paths.credentialsFile);
  const existing = config.credentials[alias]?.fields[field];
  if (existing && !options.replace) {
    throw new ProjectContextError(
      "CREDENTIAL_EXISTS",
      `Credential ${alias}.${field} already exists; pass --replace to overwrite it`,
    );
  }

  const secretPath = join(paths.secretsDirectory, `${alias}-${field}`);
  if (!options.replace) {
    try {
      await stat(secretPath);
      throw new ProjectContextError(
        "CREDENTIAL_EXISTS",
        `Credential secret ${secretPath} already exists; pass --replace to overwrite it`,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  const previousSecret = await readFile(secretPath).catch(() => undefined);
  const temporarySecret = join(paths.secretsDirectory, `.${alias}-${field}.${crypto.randomUUID()}`);
  await writeFile(temporarySecret, `${value}\n`, { mode: 0o600, flag: "wx" });
  await rename(temporarySecret, secretPath);

  config.credentials[alias] ??= { fields: {} };
  config.credentials[alias].fields[field] = { source: "file", path: secretPath };
  try {
    await writeCredentialsAtomically(config);
  } catch (error) {
    if (previousSecret === undefined) await rm(secretPath, { force: true });
    else await writeFile(secretPath, previousSecret, { mode: 0o600 });
    throw error;
  }

  return { alias, field, path: secretPath };
}
