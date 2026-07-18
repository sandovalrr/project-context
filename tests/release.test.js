import { describe, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import { packageVersionsFromLockDiff } from "../scripts/check-package-age.mjs";
import { normalizeReleaseType } from "../scripts/release-analyzer.mjs";
import { cycloneDxInvocation, synchronizeReleaseVersion } from "../scripts/release-prepare.mjs";
import { withTemporaryDirectory } from "./helpers/temporary.ts";

describe("release policy", () => {
  test("limits release writes to the short-lived GitHub App token", async () => {
    const workflow = parse(
      await readFile(join(process.cwd(), ".github/workflows/prepare-release.yml"), "utf8"),
    );
    const steps = workflow.jobs.prepare.steps;
    const tokenStep = steps.find(({ id }) => id === "release-app");
    const checkoutStep = steps.find(
      ({ name }) => name === "Check out main with release credentials",
    );
    const releaseStep = steps.find(
      ({ name }) => name === "Prepare the release commit, tag, artifacts, and draft",
    );
    const appClientIdExpression = `\${{ vars.RELEASE_APP_CLIENT_ID }}`;
    const privateKeyExpression = `\${{ secrets.RELEASE_APP_PRIVATE_KEY }}`;
    const releaseTokenExpression = `\${{ steps.release-app.outputs.token }}`;

    expect(workflow.permissions.contents).toBe("read");
    expect(tokenStep.uses).toMatch(/^actions\/create-github-app-token@[0-9a-f]{40}$/);
    expect(tokenStep.with).toEqual({
      "client-id": appClientIdExpression,
      "private-key": privateKeyExpression,
      repositories: "project-context",
      "permission-contents": "write",
    });
    expect(checkoutStep.with.token).toBe(releaseTokenExpression);
    expect(releaseStep.env.GITHUB_TOKEN).toBe(releaseTokenExpression);
  });

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
    await withTemporaryDirectory("project-context-release-", async (directory) => {
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

  test("runs CycloneDX through npm when dependencies were installed by Bun", () => {
    expect(cycloneDxInvocation("/tmp/release.sbom.json")).toEqual({
      command: "npm",
      args: [
        "exec",
        "--",
        "cyclonedx-npm",
        "--ignore-npm-errors",
        "--output-reproducible",
        "--validate",
        "--mc-type",
        "application",
        "--output-format",
        "JSON",
        "--output-file",
        "/tmp/release.sbom.json",
      ],
    });
  });
});
