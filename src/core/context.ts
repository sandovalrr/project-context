import { loadCredentialConfig, loadProjectsConfig, validateRegistryReferences } from "./config.ts";
import { getPaths } from "./paths.ts";
import { resolveRepository } from "./repository.ts";

export async function resolveProjectContext(cwd = process.cwd()) {
  const paths = getPaths();
  const projects = await loadProjectsConfig(paths.projectsFile);
  const credentials = await loadCredentialConfig(paths.credentialsFile);
  validateRegistryReferences(projects, credentials);
  const repository = await resolveRepository(projects, cwd);
  const providerAlias = repository.project.issues.default;
  const provider = repository.project.issues.providers[providerAlias];
  if (!provider) throw new Error(`Resolved default provider ${providerAlias} disappeared`);
  const profile = projects.providers[provider.profile];
  if (!profile) throw new Error(`Resolved provider profile ${provider.profile} disappeared`);

  return {
    repository: {
      id: repository.repositoryId,
      git_root: repository.gitRoot,
      origin: repository.normalizedOrigin ?? null,
      match_source: repository.matchSource,
    },
    issues: {
      default_provider: providerAlias,
      configured_providers: Object.keys(repository.project.issues.providers),
      selected: {
        alias: providerAlias,
        type: provider.type,
        profile: provider.profile,
        target: provider.target,
        credential_alias: profile.credential,
        credential_available: Boolean(credentials.credentials[profile.credential]),
      },
    },
  };
}
