import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const executeFile = promisify(execFile);
const MINIMUM_AGE_SECONDS = 172_800;
const MINIMUM_AGE_MS = MINIMUM_AGE_SECONDS * 1_000;

function parseLocator(locator) {
  const separator = locator.lastIndexOf("@");
  if (separator <= 0) return undefined;
  const name = locator.slice(0, separator);
  const version = locator.slice(separator + 1);
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version) ? { name, version } : undefined;
}

export function packageVersionsFromLockDiff(diff) {
  const versions = diff
    .split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .flatMap((line) => {
      const locator = /^\+\s+"[^"]+": \["([^"]+)"/.exec(line)?.[1];
      const parsed = locator ? parseLocator(locator) : undefined;
      return parsed ? [parsed] : [];
    });
  return [...new Map(versions.map((entry) => [`${entry.name}@${entry.version}`, entry])).values()];
}

async function lockDiff(baseSha) {
  if (!baseSha) return `+${(await readFile("bun.lock", "utf8")).replaceAll("\n", "\n+")}`;
  return executeFile("git", ["diff", `${baseSha}...HEAD`, "--", "bun.lock"], {
    maxBuffer: 16 * 1024 * 1024,
  }).then((result) => result.stdout);
}

async function assertPackageOldEnough(entry, now = Date.now()) {
  const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(entry.name)}`, {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw new Error(`Cannot verify npm publication time for ${entry.name}`);
  const metadata = await response.json();
  const publishedAt = metadata.time?.[entry.version];
  if (!publishedAt)
    throw new Error(`npm has no publication time for ${entry.name}@${entry.version}`);
  const age = now - new Date(publishedAt).getTime();
  if (age < MINIMUM_AGE_MS) {
    throw new Error(`${entry.name}@${entry.version} is newer than the required 48-hour minimum`);
  }
}

function batches(values, size) {
  if (values.length === 0) return [];
  return [values.slice(0, size), ...batches(values.slice(size), size)];
}

export async function checkPackageAge(baseSha = process.env.PACKAGE_AGE_BASE_SHA) {
  const bunfig = await readFile("bunfig.toml", "utf8");
  if (!bunfig.includes(`minimumReleaseAge = ${MINIMUM_AGE_SECONDS}`)) {
    throw new Error("bunfig.toml must enforce a 48-hour minimum release age");
  }
  const packages = packageVersionsFromLockDiff(await lockDiff(baseSha));
  for (const batch of batches(packages, 12)) {
    await Promise.all(batch.map((entry) => assertPackageOldEnough(entry)));
  }
  return { checked: packages.length, minimumAgeSeconds: MINIMUM_AGE_SECONDS };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify(await checkPackageAge(), null, 2));
}
