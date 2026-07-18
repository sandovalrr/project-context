import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installProjectIssuesSkill, projectIssuesSkillStatus } from "../src/core/skill.ts";
import { PACKAGE_VERSION } from "../src/metadata.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "project-context-skill-"));
  temporaryDirectories.push(directory);
  const source = join(directory, "source");
  const target = join(directory, ".agents", "skills", "project-issues");
  await Bun.write(join(source, "SKILL.md"), "# Project issues\n");
  return { source, target };
}

describe("optional project-issues skill", () => {
  test("installs explicitly and reports the matching package version", async () => {
    const { source, target } = await fixture();
    const installed = await installProjectIssuesSkill({ source, target });

    expect(installed.replaced).toBe(false);
    expect(await readFile(join(target, "SKILL.md"), "utf8")).toContain("Project issues");
    expect(await projectIssuesSkillStatus({ target })).toMatchObject({
      status: "current",
      installedVersion: PACKAGE_VERSION,
      packageVersion: PACKAGE_VERSION,
    });
  });

  test("refuses an existing skill and backs it up only with explicit replacement", async () => {
    const { source, target } = await fixture();
    await installProjectIssuesSkill({ source, target });
    await writeFile(join(target, "SKILL.md"), "# Local changes\n");

    await expect(installProjectIssuesSkill({ source, target })).rejects.toThrow("--replace");
    const replaced = await installProjectIssuesSkill({ source, target, replace: true });

    expect(replaced.replaced).toBe(true);
    expect(replaced.backup).toBeString();
    expect(await readFile(join(replaced.backup as string, "SKILL.md"), "utf8")).toContain(
      "Local changes",
    );
    expect(await readFile(join(target, "SKILL.md"), "utf8")).toContain("Project issues");
  });
});
