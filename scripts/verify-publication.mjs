import { publicationUrl } from "./publication-url.mjs";

const version = process.argv[2];
const target = process.argv[3];

if (!version || !["npm", "registry"].includes(target)) {
  throw new Error("Usage: node scripts/verify-publication.mjs <version> <npm|registry>");
}

const url = publicationUrl(version, target);

async function waitForPublication(attempts) {
  const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(20_000) });
  if (response.ok) return;
  if (attempts <= 1)
    throw new Error(`${target} did not expose version ${version}: ${response.status}`);
  await new Promise((resolve) => setTimeout(resolve, 5_000));
  return waitForPublication(attempts - 1);
}

await waitForPublication(12);
console.log(JSON.stringify({ target, version, available: true }));
