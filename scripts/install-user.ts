import { chmod, copyFile, lstat, mkdir, readlink, rename, symlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setupHostConfiguration } from "../src/core/setup.ts";

async function setupConfiguration(home: string) {
  const previousConfig = process.env.PROJECT_CONTEXT_CONFIG_DIR;
  const previousState = process.env.PROJECT_CONTEXT_STATE_DIR;

  process.env.PROJECT_CONTEXT_CONFIG_DIR = join(home, ".agents", "config", "project-context");
  process.env.PROJECT_CONTEXT_STATE_DIR = join(home, ".local", "state", "project-context");

  try {
    return await setupHostConfiguration();
  } finally {
    if (previousConfig === undefined) delete process.env.PROJECT_CONTEXT_CONFIG_DIR;
    else process.env.PROJECT_CONTEXT_CONFIG_DIR = previousConfig;

    if (previousState === undefined) delete process.env.PROJECT_CONTEXT_STATE_DIR;
    else process.env.PROJECT_CONTEXT_STATE_DIR = previousState;
  }
}

export async function installUser(
  home = process.env.PROJECT_CONTEXT_INSTALL_HOME ?? homedir(),
  sources: { binary?: string; skill?: string } = {},
) {
  const root = resolve(import.meta.dir, "..");
  const sourceBinary = sources.binary ?? join(root, "dist", "project-context");
  const targetBinary = join(home, ".local", "bin", "project-context");
  const sourceSkill = sources.skill ?? join(root, "skills", "project-issues");
  const targetSkill = join(home, ".agents", "skills", "project-issues");
  await mkdir(dirname(targetBinary), { recursive: true, mode: 0o700 });
  await mkdir(dirname(targetSkill), { recursive: true, mode: 0o700 });

  try {
    const metadata = await lstat(targetSkill);
    if (
      !metadata.isSymbolicLink() ||
      resolve(dirname(targetSkill), await readlink(targetSkill)) !== sourceSkill
    ) {
      throw new Error(`Refusing to replace existing skill at ${targetSkill}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await symlink(sourceSkill, targetSkill, "dir");
  }

  const temporaryBinary = `${targetBinary}.${crypto.randomUUID()}.tmp`;
  await copyFile(sourceBinary, temporaryBinary);
  await chmod(temporaryBinary, 0o755);
  await rename(temporaryBinary, targetBinary);

  const setup = await setupConfiguration(home);

  return {
    executable: targetBinary,
    skill: targetSkill,
    createdConfiguration: setup.created,
    mcp: { name: "project_issues", command: targetBinary, args: ["mcp"] },
  };
}

if (import.meta.main) {
  try {
    console.log(JSON.stringify(await installUser(), null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
