import { afterEach, describe, expect, test } from "bun:test";
import { lstat, mkdtemp, readFile, readlink, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installUser } from "../scripts/install-user.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("user-scoped installation", () => {
  test("installs the executable and shared skill without replacing host config", async () => {
    const directory = await mkdtemp(join(tmpdir(), "project-context-install-"));
    temporaryDirectories.push(directory);
    const sourceBinary = join(directory, "source-binary");
    await writeFile(sourceBinary, "binary");
    const sourceSkill = join(import.meta.dir, "..", "skills", "project-issues");

    const first = await installUser(directory, { binary: sourceBinary, skill: sourceSkill });
    expect(await readFile(first.executable, "utf8")).toBe("binary");
    expect((await stat(first.executable)).mode & 0o777).toBe(0o755);
    expect((await lstat(first.skill)).isSymbolicLink()).toBe(true);
    expect(await readlink(first.skill)).toBe(sourceSkill);

    const projects = join(directory, ".agents", "config", "project-context", "projects.yaml");
    await writeFile(projects, "version: 1\nproviders: {}\nprojects: {}\n# keep-me\n");
    await installUser(directory, { binary: sourceBinary, skill: sourceSkill });
    expect(await readFile(projects, "utf8")).toContain("# keep-me");
  });
});
