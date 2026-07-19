import { copyFile, lstat, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseDocument, stringify } from "yaml";
import { validateCredentialConfigValue, validateProjectsConfigValue } from "./config.ts";
import { ProjectContextError } from "./errors.ts";
import { getPaths } from "./paths.ts";

interface RegistryMigration {
  path: string;
  kind: "projects" | "credentials";
  fromVersion: number;
  toVersion: number;
  value: Record<string, unknown>;
}

interface RegistryBackup {
  source: string;
  target: string;
}

export interface ConfigurationMigrationResult {
  needed: boolean;
  applied: boolean;
  files: Array<{ path: string; from_version: number; to_version: number }>;
  backups?: string[];
}

function timestamp(): string {
  return new Date().toISOString().replaceAll(":", "-");
}

async function secureYaml(path: string): Promise<Record<string, unknown>> {
  const metadata = await lstat(path).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ProjectContextError("CONFIG_NOT_FOUND", `Configuration file ${path} was not found`);
    }
    throw error;
  });
  if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0) {
    throw new ProjectContextError(
      "CONFIG_PERMISSIONS_UNSAFE",
      `Host configuration ${path} must be a regular mode-0600 file`,
    );
  }

  const document = parseDocument(await readFile(path, "utf8"), { uniqueKeys: true });
  if (document.errors.length > 0) {
    throw new ProjectContextError(
      "CONFIG_YAML_INVALID",
      `Invalid YAML in ${path}: ${document.errors.map((error) => error.message).join("; ")}`,
    );
  }
  const value: unknown = document.toJS();
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProjectContextError("CONFIG_MIGRATION_INVALID", `${path} must contain a YAML object`);
  }
  return value as Record<string, unknown>;
}

function targetVersion(kind: RegistryMigration["kind"]): number {
  return kind === "projects" ? 2 : 1;
}

function migratedValue(
  path: string,
  kind: RegistryMigration["kind"],
  value: Record<string, unknown>,
): Record<string, unknown> {
  const version = value.version ?? 0;
  const target = targetVersion(kind);
  const supportedSource = kind === "projects" ? version === 0 || version === 1 : version === 0;
  if (version === target) return value;
  if (supportedSource) return { ...value, version: target };
  if (typeof version === "number" && version > target) {
    throw new ProjectContextError(
      "CONFIG_VERSION_NEWER",
      `${path} uses unsupported future schema version ${version}`,
    );
  }
  throw new ProjectContextError(
    "CONFIG_MIGRATION_UNSUPPORTED",
    `${path} uses unsupported schema version ${String(version)}`,
  );
}

async function migration(
  path: string,
  kind: RegistryMigration["kind"],
): Promise<RegistryMigration> {
  const value = await secureYaml(path);
  const version = value.version ?? 0;
  const migrated = migratedValue(path, kind, value);
  const toVersion = targetVersion(kind);
  if (kind === "projects") validateProjectsConfigValue(migrated, path);
  else validateCredentialConfigValue(migrated, path);
  return { path, kind, fromVersion: Number(version), toVersion, value: migrated };
}

function publicFiles(migrations: RegistryMigration[]) {
  return migrations
    .filter((entry) => entry.fromVersion !== entry.toVersion)
    .map((entry) => ({
      path: entry.path,
      from_version: entry.fromVersion,
      to_version: entry.toVersion,
    }));
}

async function writeMigration(entry: RegistryMigration): Promise<string> {
  const temporary = join(
    getPaths().configDirectory,
    `.${entry.kind}.${crypto.randomUUID()}.migration.tmp`,
  );
  await writeFile(temporary, stringify(entry.value), { mode: 0o600, flag: "wx" });
  return temporary;
}

async function replaceFiles(targets: string[], temporaryFiles: string[], index = 0): Promise<void> {
  const target = targets[index];
  const temporary = temporaryFiles[index];
  if (!target || !temporary) return;
  await rename(temporary, target);
  await replaceFiles(targets, temporaryFiles, index + 1);
}

async function restoreBackups(backups: RegistryBackup[]): Promise<void> {
  const temporaryFiles = await Promise.all(
    backups.map(async (backup) => {
      const temporary = join(
        getPaths().configDirectory,
        `.rollback.${crypto.randomUUID()}.migration.tmp`,
      );
      await copyFile(backup.source, temporary);
      return temporary;
    }),
  );
  try {
    await replaceFiles(
      backups.map((backup) => backup.target),
      temporaryFiles,
    );
  } finally {
    await Promise.all(temporaryFiles.map((path) => rm(path, { force: true })));
  }
}

async function applyMigrations(migrations: RegistryMigration[]): Promise<string[]> {
  const paths = getPaths();
  const changed = migrations.filter((entry) => entry.fromVersion !== entry.toVersion);
  if (changed.length === 0) return [];

  await mkdir(paths.backupsDirectory, { recursive: true, mode: 0o700 });
  const suffix = timestamp();
  const backups = await Promise.all(
    changed.map(async (entry) => {
      const backup = join(
        paths.backupsDirectory,
        `${entry.kind}-v${entry.fromVersion}-${suffix}.yaml`,
      );
      await copyFile(entry.path, backup);
      return { source: backup, target: entry.path };
    }),
  );
  const temporaryFiles = await Promise.all(changed.map(writeMigration));
  try {
    await replaceFiles(
      changed.map((entry) => entry.path),
      temporaryFiles,
    );
  } catch (error) {
    await restoreBackups(backups).catch((rollbackError) => {
      throw new ProjectContextError(
        "CONFIG_MIGRATION_ROLLBACK_FAILED",
        "Configuration migration failed and the original registries could not be fully restored",
        { cause: error, rollbackError },
      );
    });
    throw new ProjectContextError(
      "CONFIG_MIGRATION_FAILED",
      "Configuration migration failed; the original registries were restored",
      { cause: error },
    );
  } finally {
    await Promise.all(temporaryFiles.map((path) => rm(path, { force: true })));
  }
  return backups.map((backup) => backup.source);
}

export async function migrateHostConfiguration(
  options: { apply?: boolean } = {},
): Promise<ConfigurationMigrationResult> {
  const paths = getPaths();
  const migrations = await Promise.all([
    migration(paths.projectsFile, "projects"),
    migration(paths.credentialsFile, "credentials"),
  ]);
  const files = publicFiles(migrations);
  if (!options.apply || files.length === 0) {
    return { needed: files.length > 0, applied: false, files };
  }

  await mkdir(paths.stateDirectory, { recursive: true, mode: 0o700 });
  const lock = await open(paths.lockFile, "wx", 0o600).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new ProjectContextError("CONFIG_LOCKED", "Configuration is locked by another process");
    }
    throw error;
  });
  try {
    const currentMigrations = await Promise.all([
      migration(paths.projectsFile, "projects"),
      migration(paths.credentialsFile, "credentials"),
    ]);
    const currentFiles = publicFiles(currentMigrations);
    if (currentFiles.length === 0) return { needed: false, applied: false, files: [] };
    const backups = await applyMigrations(currentMigrations);
    return { needed: true, applied: true, files: currentFiles, backups };
  } finally {
    await lock.close();
    await rm(paths.lockFile, { force: true });
  }
}
