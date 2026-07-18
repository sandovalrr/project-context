import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packageVersionsFromLockDiff } from "../scripts/check-package-age.mjs";
import { normalizeReleaseType } from "../scripts/release-analyzer.mjs";
import { synchronizeReleaseVersion } from "../scripts/release-prepare.mjs";

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("release policy", () => {
  test("keeps breaking changes pre-1.0 until the explicit 1.0 confirmation", () => {
    expect(normalizeReleaseType("0.4.2", "major", false)).toBe("minor");
    expect(normalizeReleaseType("0.4.2", "major", true)).toBe("major");
    expect(normalizeReleaseType("1.2.3", "major", false)).toBe("major");
  });

  test("audits newly locked direct and transitive package versions", () => {
    const diff = `+    "example": ["example@1.2.3", "", {}],
+    "@scope/example": ["@scope/example@4.5.6", "", {}],
     "unchanged": ["unchanged@7.8.9", "", {}],`;
    expect(packageVersionsFromLockDiff(diff)).toEqual([
      { name: "example", version: "1.2.3" },
      { name: "@scope/example", version: "4.5.6" },
    ]);
  });

  test("synchronizes package and registry versions from one release version", async () => {
    const directory = await mkdtemp(join(tmpdir(), "project-context-release-"));
    temporaryDirectories.push(directory);
    await Promise.all([
      writeFile(join(directory, "package.json"), '{"name":"example","version":"0.0.0"}\n'),
      writeFile(
        join(directory, "server.json"),
        '{"name":"io.github.example/server","version":"0.0.0","packages":[{"version":"0.0.0"}]}\n',
      ),
    ]);

    await synchronizeReleaseVersion("0.1.0", directory);
    expect(JSON.parse(await readFile(join(directory, "package.json"), "utf8")).version).toBe(
      "0.1.0",
    );
    const server = JSON.parse(await readFile(join(directory, "server.json"), "utf8"));
    expect(server.version).toBe("0.1.0");
    expect(server.packages[0].version).toBe("0.1.0");
  });
});
