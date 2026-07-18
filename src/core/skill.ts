import { cp, lstat, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PACKAGE_VERSION } from "../metadata.ts";
import { ProjectContextError } from "./errors.ts";
import { absolutePath, getPaths } from "./paths.ts";

interface SkillPaths {
  source?: string;
  target?: string;
}

interface InstallSkillOptions extends SkillPaths {
  replace?: boolean;
}

const VERSION_FILE = ".project-context-version";

async function exists(path: string): Promise<boolean> {
  return stat(path)
    .then(() => true)
    .catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    });
}

async function firstExistingPath(candidates: string[]): Promise<string> {
  const [candidate, ...remaining] = candidates;
  if (!candidate) {
    throw new ProjectContextError(
      "SKILL_SOURCE_NOT_FOUND",
      "The packaged project-issues skill could not be found",
    );
  }
  return (await exists(candidate)) ? candidate : firstExistingPath(remaining);
}

async function sourcePath(explicit?: string): Promise<string> {
  if (explicit) return explicit;
  return firstExistingPath([
    fileURLToPath(new URL("../skills/project-issues", import.meta.url)),
    fileURLToPath(new URL("../../skills/project-issues", import.meta.url)),
  ]);
}

function targetPath(explicit?: string): string {
  return explicit ?? absolutePath("~/.agents/skills/project-issues");
}

function timestamp(): string {
  return new Date().toISOString().replaceAll(":", "-");
}

async function assertSkillDirectory(path: string, description: string): Promise<void> {
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new ProjectContextError(
      "SKILL_DIRECTORY_UNSAFE",
      `${description} ${path} must be a directory and not a symbolic link`,
    );
  }
}

export async function projectIssuesSkillStatus(options: SkillPaths = {}): Promise<{
  status: "absent" | "current" | "outdated" | "unmanaged";
  target: string;
  packageVersion: string;
  installedVersion?: string;
}> {
  const target = targetPath(options.target);
  if (!(await exists(target))) return { status: "absent", target, packageVersion: PACKAGE_VERSION };

  await assertSkillDirectory(target, "Installed skill");
  const installedVersion = await readFile(join(target, VERSION_FILE), "utf8")
    .then((value) => value.trim())
    .catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    });
  if (!installedVersion) return { status: "unmanaged", target, packageVersion: PACKAGE_VERSION };
  return {
    status: installedVersion === PACKAGE_VERSION ? "current" : "outdated",
    target,
    packageVersion: PACKAGE_VERSION,
    installedVersion,
  };
}

export async function installProjectIssuesSkill(options: InstallSkillOptions = {}): Promise<{
  target: string;
  version: string;
  replaced: boolean;
  backup?: string;
}> {
  const source = await sourcePath(options.source);
  const target = targetPath(options.target);
  const targetExists = await exists(target);
  await assertSkillDirectory(source, "Packaged skill");
  if (targetExists) await assertSkillDirectory(target, "Existing skill");
  if (targetExists && !options.replace) {
    throw new ProjectContextError(
      "SKILL_EXISTS",
      `Skill already exists at ${target}; run skill status, then pass --replace to back it up and replace it`,
    );
  }

  const parent = dirname(target);
  const temporary = join(parent, `.project-issues.${crypto.randomUUID()}.tmp`);
  const backup = targetExists
    ? join(getPaths().backupsDirectory, `skill-project-issues-${timestamp()}`)
    : undefined;
  await mkdir(parent, { recursive: true, mode: 0o700 });
  await cp(source, temporary, { recursive: true, errorOnExist: true });
  await writeFile(join(temporary, VERSION_FILE), `${PACKAGE_VERSION}\n`, {
    mode: 0o600,
    flag: "wx",
  });
  if (backup) {
    await mkdir(dirname(backup), { recursive: true, mode: 0o700 });
    await rename(target, backup);
  }
  try {
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    if (backup) await rename(backup, target);
    throw error;
  }

  return {
    target,
    version: PACKAGE_VERSION,
    replaced: targetExists,
    ...(backup ? { backup } : {}),
  };
}
