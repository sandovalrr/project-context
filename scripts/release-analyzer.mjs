import { analyzeCommits as analyzeConventionalCommits } from "@semantic-release/commit-analyzer";

export function normalizeReleaseType(lastVersion, proposedType, releaseOneConfirmed) {
  const isPreOne = /^0\./.test(lastVersion || "0.0.0");
  if (!isPreOne || proposedType !== "major") return proposedType;
  return releaseOneConfirmed ? "major" : "minor";
}

export async function analyzeCommits(pluginConfig, context) {
  const proposedType = await analyzeConventionalCommits(
    { preset: "conventionalcommits", ...pluginConfig },
    context,
  );
  return normalizeReleaseType(
    context.lastRelease.version,
    proposedType,
    context.env.RELEASE_1_0 === "true",
  );
}
