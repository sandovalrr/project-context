import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const executeFile = promisify(execFile);
const RELEASE_FILES = ["CHANGELOG.md", "package.json", "bun.lock", "server.json"];

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

export async function synchronizeReleaseVersion(version, cwd = process.cwd()) {
  const packagePath = join(cwd, "package.json");
  const serverPath = join(cwd, "server.json");
  const packageMetadata = await readJson(packagePath);
  const serverMetadata = await readJson(serverPath);
  const packages = serverMetadata.packages.map((entry) => ({ ...entry, version }));

  await Promise.all([
    writeJson(packagePath, { ...packageMetadata, version }),
    writeJson(serverPath, { ...serverMetadata, version, packages }),
  ]);
}

async function run(command, args, cwd, env) {
  return executeFile(command, args, { cwd, env, maxBuffer: 16 * 1024 * 1024 });
}

async function sha256(path) {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

export function cycloneDxInvocation(outputPath) {
  // npm supplies its own CLI path, avoiding Bun's npm_execpath shim. Bun's
  // install layout can also trigger false npm-ls errors; SBOM validation stays enabled.
  return {
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
      outputPath,
    ],
  };
}

async function createReleaseArtifacts(version, cwd, env) {
  const releaseDirectory = join(cwd, "release");
  await rm(releaseDirectory, { recursive: true, force: true });
  await mkdir(releaseDirectory, { recursive: true });
  await run("bun", ["install", "--lockfile-only"], cwd, env);
  await run("bun", ["run", "build"], cwd, env);
  const packed = await run(
    "npm",
    ["pack", "--json", "--ignore-scripts", "--pack-destination", releaseDirectory],
    cwd,
    env,
  );
  const packageResult = JSON.parse(packed.stdout)[0];
  if (!packageResult?.filename) throw new Error("npm pack did not report a tarball filename");

  const tarballPath = join(releaseDirectory, packageResult.filename);
  const sbomName = `project-context-mcp-${version}.sbom.cdx.json`;
  const sbomPath = join(releaseDirectory, sbomName);
  const cycloneDx = cycloneDxInvocation(sbomPath);
  await run(cycloneDx.command, cycloneDx.args, cwd, env);
  const checksumName = `project-context-mcp-${version}.sha256`;
  const checksumPath = join(releaseDirectory, checksumName);
  const checksums = [
    `${await sha256(tarballPath)}  ${packageResult.filename}`,
    `${await sha256(sbomPath)}  ${sbomName}`,
  ];
  await writeFile(checksumPath, `${checksums.join("\n")}\n`);
  await run("node", ["scripts/test-package.mjs", tarballPath], cwd, env);
}

function githubContext(env) {
  const repository = env.GITHUB_REPOSITORY?.split("/");
  const owner = repository?.[0];
  const repo = repository?.[1];
  const token = env.GITHUB_TOKEN ?? env.GH_TOKEN;
  if (!owner || !repo || !token) {
    throw new Error("GitHub repository and token are required for a verified release commit");
  }
  return { owner, repo, token };
}

async function githubRequest(github, path, options = {}) {
  const response = await fetch(`https://api.github.com${path}`, {
    ...options,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${github.token}`,
      "User-Agent": "project-context-release",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(options.headers ?? {}),
    },
  });
  if (!response.ok) throw new Error(`GitHub release commit request failed with ${response.status}`);
  return response.json();
}

async function createBlob(github, cwd, path) {
  const blob = await githubRequest(github, `/repos/${github.owner}/${github.repo}/git/blobs`, {
    method: "POST",
    body: JSON.stringify({
      content: (await readFile(join(cwd, path))).toString("base64"),
      encoding: "base64",
    }),
  });
  return { path, mode: "100644", type: "blob", sha: blob.sha };
}

async function createVerifiedReleaseCommit(context) {
  const github = githubContext(context.env);
  const branch = context.branch.name;
  const reference = await githubRequest(
    github,
    `/repos/${github.owner}/${github.repo}/git/ref/heads/${encodeURIComponent(branch)}`,
  );
  const parentSha = reference.object.sha;
  const parent = await githubRequest(
    github,
    `/repos/${github.owner}/${github.repo}/git/commits/${parentSha}`,
  );
  const entries = await Promise.all(
    RELEASE_FILES.map((path) => createBlob(github, context.cwd, path)),
  );
  const tree = await githubRequest(github, `/repos/${github.owner}/${github.repo}/git/trees`, {
    method: "POST",
    body: JSON.stringify({ base_tree: parent.tree.sha, tree: entries }),
  });
  const commit = await githubRequest(github, `/repos/${github.owner}/${github.repo}/git/commits`, {
    method: "POST",
    body: JSON.stringify({
      message: `chore(release): ${context.nextRelease.version} [skip ci]\n\n${context.nextRelease.notes}`,
      tree: tree.sha,
      parents: [parentSha],
    }),
  });
  await githubRequest(
    github,
    `/repos/${github.owner}/${github.repo}/git/refs/heads/${encodeURIComponent(branch)}`,
    { method: "PATCH", body: JSON.stringify({ sha: commit.sha, force: false }) },
  );
  await run("git", ["fetch", "origin", branch], context.cwd, context.env);
  await run("git", ["reset", "--hard", commit.sha], context.cwd, context.env);
  // semantic-release tags nextRelease.gitHead after prepare; the verified API commit replaces it.
  context.nextRelease.gitHead = commit.sha;
}

export async function prepare(_pluginConfig, context) {
  await synchronizeReleaseVersion(context.nextRelease.version, context.cwd);
  await createReleaseArtifacts(context.nextRelease.version, context.cwd, context.env);
  await createVerifiedReleaseCommit(context);
}
