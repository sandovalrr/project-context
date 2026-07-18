import { describe, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { generateNotes } from "@semantic-release/release-notes-generator";
import { parse } from "yaml";
import releaseConfig from "../release.config.mjs";
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

  test("installs locked verification dependencies before npm publication", async () => {
    const workflow = parse(
      await readFile(join(process.cwd(), ".github/workflows/publish-release.yml"), "utf8"),
    );
    const steps = workflow.jobs["publish-npm"].steps;
    const setupBunIndex = steps.findIndex(({ name }) => name === "Set up Bun");
    const installIndex = steps.findIndex(({ name }) => name === "Install locked dependencies");
    const verifyIndex = steps.findIndex(
      ({ name }) => name === "Verify tag, versions, checksums, SBOM, and package behavior",
    );
    const publishIndex = steps.findIndex(
      ({ name }) => name === "Publish the exact tarball to npm with OIDC provenance",
    );

    expect(steps[setupBunIndex]?.uses).toMatch(/^oven-sh\/setup-bun@[0-9a-f]{40}$/);
    expect(steps[installIndex]?.run).toBe("bun ci");
    expect(setupBunIndex).toBeLessThan(installIndex);
    expect(installIndex).toBeLessThan(verifyIndex);
    expect(verifyIndex).toBeLessThan(publishIndex);
    expect(steps[verifyIndex]?.run).toContain("realpath");
  });

  test("allows a protected retry against an explicit immutable release tag", async () => {
    const workflow = parse(
      await readFile(join(process.cwd(), ".github/workflows/publish-release.yml"), "utf8"),
    );
    const tagExpression = `\${{ github.event.release.tag_name || inputs.tag }}`;

    expect(workflow.on.workflow_dispatch.inputs.tag).toMatchObject({
      required: true,
      type: "string",
    });
    for (const job of Object.values(workflow.jobs)) {
      const checkout = job.steps.find(({ name }) => name === "Check out the immutable release tag");
      expect(checkout.with.ref).toBe(tagExpression);
    }
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

  test("generates feature and bug-fix sections for conventional commits", async () => {
    const notesPlugin = releaseConfig.plugins.find(
      (plugin) =>
        Array.isArray(plugin) && plugin[0] === "@semantic-release/release-notes-generator",
    );
    if (!Array.isArray(notesPlugin)) throw new Error("Release notes plugin is not configured");

    const notes = await generateNotes(notesPlugin[1], {
      commits: [
        { hash: "68331656", message: "feat: add client-ready MCP manifests" },
        { hash: "1b98eed6", message: "fix: generate SBOM from Bun installs" },
      ],
      lastRelease: { gitTag: "v0.0.0", version: "0.0.0" },
      nextRelease: { gitTag: "v0.1.0", version: "0.1.0" },
      options: { repositoryUrl: "https://github.com/sandovalrr/project-context.git" },
      cwd: process.cwd(),
      logger: { log() {}, error() {} },
    });

    expect(notes).toContain("### Features");
    expect(notes).toContain("add client-ready MCP manifests");
    expect(notes).toContain("### Bug Fixes");
    expect(notes).toContain("generate SBOM from Bun installs");
  });
});
