import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const executeFile = promisify(execFile);
const releaseDirectory = process.argv[2];
const tag = process.argv[3];

if (!releaseDirectory || !tag?.startsWith("v")) {
  throw new Error("Usage: node scripts/verify-release.mjs <release-directory> <v-version>");
}

function onlyFile(files, suffix) {
  const matches = files.filter((file) => file.endsWith(suffix));
  if (matches.length !== 1)
    throw new Error(`Expected one ${suffix} asset, found ${matches.length}`);
  return matches[0];
}

async function sha256(path) {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

const version = tag.slice(1);
const files = await readdir(releaseDirectory);
const tarball = onlyFile(files, ".tgz");
const checksum = onlyFile(files, ".sha256");
const sbom = onlyFile(files, ".sbom.cdx.json");
const expectedAssets = new Set([tarball, checksum, sbom]);

if (files.some((file) => !expectedAssets.has(file))) {
  throw new Error(
    `Unexpected release assets: ${files.filter((file) => !expectedAssets.has(file))}`,
  );
}

const checksumLines = (await readFile(join(releaseDirectory, checksum), "utf8"))
  .trim()
  .split("\n")
  .map((line) => line.match(/^([a-f0-9]{64}) {2}([^/]+)$/))
  .map((match) => {
    if (!match) throw new Error("Malformed checksum manifest");
    return { digest: match[1], filename: match[2] };
  });

if (checksumLines.length !== 2) throw new Error("Checksum manifest must contain two entries");
for (const entry of checksumLines) {
  if (!expectedAssets.has(entry.filename) || entry.filename === checksum) {
    throw new Error(`Unexpected checksum target ${entry.filename}`);
  }
  if ((await sha256(join(releaseDirectory, entry.filename))) !== entry.digest) {
    throw new Error(`Checksum mismatch for ${entry.filename}`);
  }
}

const workspacePackage = JSON.parse(await readFile("package.json", "utf8"));
const server = JSON.parse(await readFile("server.json", "utf8"));
const sbomDocument = JSON.parse(await readFile(join(releaseDirectory, sbom), "utf8"));
const tarballPackage = await executeFile("tar", [
  "-xOf",
  join(releaseDirectory, tarball),
  "package/package.json",
]);
const packedPackage = JSON.parse(tarballPackage.stdout);
const taggedCommit = (await executeFile("git", ["rev-parse", `${tag}^{commit}`])).stdout.trim();
const checkedOutCommit = (await executeFile("git", ["rev-parse", "HEAD"])).stdout.trim();

if (taggedCommit !== checkedOutCommit)
  throw new Error("Release tag does not identify the checked-out commit");
if (workspacePackage.version !== version || packedPackage.version !== version) {
  throw new Error("Package versions do not match the release tag");
}
if (server.version !== version || server.packages.some((entry) => entry.version !== version)) {
  throw new Error("server.json versions do not match the release tag");
}
if (packedPackage.mcpName !== server.name)
  throw new Error("npm mcpName does not match server name");
if (sbomDocument.metadata?.component?.type !== "application") {
  throw new Error("Release SBOM must describe an application");
}
if (sbomDocument.metadata?.component?.version !== version) {
  throw new Error("Release SBOM version does not match the release tag");
}

console.log(JSON.stringify({ version, tarball, checksum, sbom }));
