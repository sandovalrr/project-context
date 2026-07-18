import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { ProjectContextError } from "./errors.ts";
import { absolutePath } from "./paths.ts";
import type { ProjectsConfig, ResolvedRepository } from "./types.ts";

function stripRepositorySuffix(path: string): string {
  return path
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "");
}

export function normalizeRemoteUrl(remote: string): string {
  const trimmed = remote.trim();
  const scpMatch = /^(?:[^@/]+@)?([^:/]+):(.+)$/.exec(trimmed);
  if (scpMatch?.[1] && scpMatch[2] && !trimmed.includes("://")) {
    const path = stripRepositorySuffix(scpMatch[2]);
    if (path.split("/").length >= 2) return `${scpMatch[1].toLowerCase()}/${path}`;
  }

  try {
    const parsed = new URL(trimmed);
    const path = stripRepositorySuffix(parsed.pathname);
    if (!parsed.hostname || path.split("/").length < 2) throw new Error("incomplete remote");
    return `${parsed.hostname.toLowerCase()}/${path}`;
  } catch {
    throw new ProjectContextError("REMOTE_UNSUPPORTED", `Unsupported Git remote: ${remote}`);
  }
}

function runGit(cwd: string, args: string[]): string {
  const result = Bun.spawnSync(["git", "-C", cwd, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    const detail = result.stderr.toString().trim();
    throw new ProjectContextError(
      "GIT_COMMAND_FAILED",
      `Git command failed in ${cwd}: ${detail || args.join(" ")}`,
    );
  }
  return result.stdout.toString().trim();
}

function sameRepository(left: string, right: string): boolean {
  return left.localeCompare(right, undefined, { sensitivity: "accent" }) === 0;
}

export async function resolveRepository(
  config: ProjectsConfig,
  cwd = process.cwd(),
): Promise<ResolvedRepository> {
  const gitRoot = await realpath(runGit(cwd, ["rev-parse", "--show-toplevel"]));
  let originRemote: string | undefined;
  let normalizedOrigin: string | undefined;
  try {
    originRemote = runGit(gitRoot, ["remote", "get-url", "origin"]);
    normalizedOrigin = normalizeRemoteUrl(originRemote);
  } catch (error) {
    if (!(error instanceof ProjectContextError) || error.code !== "GIT_COMMAND_FAILED") throw error;
  }
  const matches: Array<{
    repositoryId: string;
    matchSource: ResolvedRepository["matchSource"];
  }> = [];

  for (const [repositoryId, project] of Object.entries(config.projects)) {
    if (normalizedOrigin && sameRepository(repositoryId, normalizedOrigin)) {
      matches.push({ repositoryId, matchSource: "origin" });
      continue;
    }

    const remoteMatches =
      Boolean(originRemote) &&
      (project.aliases?.remotes ?? []).some((remote) => {
        try {
          return normalizedOrigin
            ? sameRepository(normalizeRemoteUrl(remote), normalizedOrigin)
            : false;
        } catch {
          return remote === originRemote;
        }
      });
    if (remoteMatches) {
      matches.push({ repositoryId, matchSource: "remote-alias" });
      continue;
    }

    const pathMatches = await Promise.all(
      (project.aliases?.paths ?? []).map(async (path) => {
        try {
          return (await realpath(absolutePath(path))) === gitRoot;
        } catch {
          return resolve(absolutePath(path)) === gitRoot;
        }
      }),
    );
    if (pathMatches.some(Boolean)) matches.push({ repositoryId, matchSource: "path-alias" });
  }

  if (matches.length === 0) {
    throw new ProjectContextError(
      "REPOSITORY_NOT_CONFIGURED",
      `Repository ${normalizedOrigin ?? gitRoot} is not configured`,
      { gitRoot, originRemote, normalizedOrigin },
    );
  }
  if (matches.length > 1) {
    throw new ProjectContextError(
      "REPOSITORY_AMBIGUOUS",
      `Repository ${normalizedOrigin ?? gitRoot} matches multiple configured projects: ${matches
        .map((match) => match.repositoryId)
        .join(", ")}`,
    );
  }

  const match = matches[0];
  if (!match) throw new ProjectContextError("REPOSITORY_RESOLUTION_FAILED", "No repository match");
  const project = config.projects[match.repositoryId];
  if (!project)
    throw new ProjectContextError("REPOSITORY_RESOLUTION_FAILED", "Project disappeared");

  return {
    repositoryId: match.repositoryId,
    gitRoot,
    ...(originRemote ? { originRemote } : {}),
    ...(normalizedOrigin ? { normalizedOrigin } : {}),
    matchSource: match.matchSource,
    project,
  };
}
