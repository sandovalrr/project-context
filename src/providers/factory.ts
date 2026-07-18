import { ProjectContextError } from "../core/errors.ts";
import type { ProjectProvider, ProviderProfile, ResolvedRepository } from "../core/types.ts";
import { GitHubIssuesAdapter } from "./github.ts";
import { JiraCloudIssuesAdapter } from "./jira.ts";
import { LinearIssuesAdapter } from "./linear.ts";
import type { IssueProviderAdapter, ProviderIdentity } from "./types.ts";

export function createProviderAdapter(
  profile: ProviderProfile,
  projectProvider: ProjectProvider,
  credential: Record<string, string>,
  repository: Pick<ResolvedRepository, "repositoryId">,
  fetcher: typeof fetch = fetch,
): IssueProviderAdapter {
  if (profile.type !== projectProvider.type) {
    throw new ProjectContextError(
      "PROVIDER_TYPE_MISMATCH",
      `Provider type ${projectProvider.type} does not match profile type ${profile.type}`,
    );
  }
  if (profile.type === "linear" && projectProvider.type === "linear") {
    return new LinearIssuesAdapter(profile, projectProvider.target, credential, fetcher);
  }
  if (profile.type === "jira-cloud" && projectProvider.type === "jira-cloud") {
    return new JiraCloudIssuesAdapter(profile, projectProvider.target, credential, fetcher);
  }
  if (profile.type === "github" && projectProvider.type === "github") {
    const [, owner, name] = repository.repositoryId.split("/");
    if (!owner || !name) {
      throw new ProjectContextError(
        "GITHUB_REPOSITORY_INVALID",
        `Cannot inherit GitHub repository from ${repository.repositoryId}`,
      );
    }
    return new GitHubIssuesAdapter(profile, projectProvider.target, credential, fetcher, {
      owner,
      name,
    });
  }
  throw new ProjectContextError("PROVIDER_UNSUPPORTED", `Unsupported provider ${profile.type}`);
}

export function assertExpectedIdentity(profile: ProviderProfile, actual: ProviderIdentity): void {
  const mismatch = (expected: string, received: string, field: string) => {
    if (expected !== received) {
      throw new ProjectContextError(
        "PROVIDER_IDENTITY_MISMATCH",
        `Credential identity mismatch for ${profile.type}: expected ${field} ${expected}, received ${received}`,
      );
    }
  };
  if (profile.type === "linear") {
    mismatch(profile.expected_identity.workspace.id, actual.scopeId, "workspace");
  } else if (profile.type === "github") {
    mismatch(profile.expected_identity.login, actual.principalName, "login");
    mismatch(profile.expected_identity.host, actual.scopeId, "host");
  } else {
    mismatch(profile.expected_identity.account_id, actual.principalId, "account");
    mismatch(profile.expected_identity.site, actual.scopeId, "site");
  }
}

export async function validateAdapterIdentity(
  adapter: IssueProviderAdapter,
  profile: ProviderProfile,
): Promise<ProviderIdentity> {
  const identity = await adapter.identity();
  assertExpectedIdentity(profile, identity);
  return identity;
}
