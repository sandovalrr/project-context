export type ProviderType = "linear" | "github" | "jira-cloud";
export type CanonicalStatus = "open" | "in_progress" | "done" | "canceled";

export interface IdentityRef {
  id: string;
  name: string;
}

export interface LinearProviderProfile {
  type: "linear";
  credential: string;
  expected_identity: {
    workspace: IdentityRef;
  };
}

export interface GitHubProviderProfile {
  type: "github";
  credential: string;
  expected_identity: {
    login: string;
    host: string;
  };
}

export interface JiraProviderProfile {
  type: "jira-cloud";
  credential: string;
  expected_identity: {
    site: string;
    account_id: string;
  };
}

export type ProviderProfile = LinearProviderProfile | GitHubProviderProfile | JiraProviderProfile;

export interface StatusMappingObject {
  state?: string;
  add_labels?: string[];
  remove_labels?: string[];
}

export type StatusMapping = string | StatusMappingObject;

export interface CreatePreset {
  priority?: string | number;
  labels?: string[];
  assignee?: string;
  template?: string;
  [key: string]: unknown;
}

export interface CreatePolicy {
  required?: Array<"title" | "description">;
  defaults?: Record<string, unknown>;
  presets?: Record<string, CreatePreset>;
}

interface ProjectProviderBase {
  profile: string;
  identifiers?: string[];
  mappings?: {
    status?: Partial<Record<CanonicalStatus, StatusMapping>>;
  };
  create?: CreatePolicy;
}

export interface LinearProjectProvider extends ProjectProviderBase {
  type: "linear";
  target: {
    team: IdentityRef;
    project: IdentityRef | "none";
  };
}

export interface GitHubRepositoryTarget {
  id: string;
  owner: string;
  name: string;
}

export interface GitHubProjectProvider extends ProjectProviderBase {
  type: "github";
  target: {
    repository: GitHubRepositoryTarget | "inherit";
  };
}

export interface JiraProjectProvider extends ProjectProviderBase {
  type: "jira-cloud";
  target: {
    project: IdentityRef;
  };
}

export type ProjectProvider = LinearProjectProvider | GitHubProjectProvider | JiraProjectProvider;

export interface ProjectConfig {
  aliases?: {
    remotes?: string[];
    paths?: string[];
  };
  issues: {
    default: string;
    providers: Record<string, ProjectProvider>;
  };
}

export interface ProjectsConfig {
  version: 1;
  providers: Record<string, ProviderProfile>;
  projects: Record<string, ProjectConfig>;
}

export type CredentialFieldSource =
  | { source: "file"; path: string }
  | { source: "command"; command: string[] }
  | { source: "environment"; variable: string }
  | { source: "keychain"; service: string; account: string };

export interface CredentialDefinition {
  fields: Record<string, CredentialFieldSource>;
}

export interface CredentialsConfig {
  version: 1;
  credentials: Record<string, CredentialDefinition>;
}

export interface ResolvedRepository {
  repositoryId: string;
  gitRoot: string;
  originRemote?: string;
  normalizedOrigin?: string;
  matchSource: "origin" | "remote-alias" | "path-alias";
  project: ProjectConfig;
}
