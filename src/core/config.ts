import { lstat, readFile } from "node:fs/promises";
import Ajv2020, { type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import { parseDocument } from "yaml";
import credentialsSchema from "../../schemas/credentials.schema.json";
import projectsSchema from "../../schemas/projects.schema.json";
import { ProjectContextError } from "./errors.ts";
import { absolutePath, getPaths } from "./paths.ts";
import type { CredentialsConfig, ProjectsConfig } from "./types.ts";

const ajv = new Ajv2020({ allErrors: true, strict: true });
const validateProjectsSchema = ajv.compile(projectsSchema) as ValidateFunction<ProjectsConfig>;
const validateCredentialsSchema = ajv.compile(
  credentialsSchema,
) as ValidateFunction<CredentialsConfig>;

function formatSchemaErrors(errors: ErrorObject[] | null | undefined): string {
  if (!errors?.length) return "unknown validation error";
  return errors
    .map((error) => `${error.instancePath || "/"}: ${error.message ?? error.keyword}`)
    .join("; ");
}

async function parseYamlFile(path: string): Promise<unknown> {
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    throw new ProjectContextError("CONFIG_READ_FAILED", `Cannot read configuration ${path}`, {
      cause: error,
    });
  }

  const document = parseDocument(content, { uniqueKeys: true });
  if (document.errors.length > 0) {
    throw new ProjectContextError(
      "CONFIG_YAML_INVALID",
      `Invalid YAML in ${path}: ${document.errors.map((error) => error.message).join("; ")}`,
    );
  }
  return document.toJS();
}

async function assertSecureHostConfig(path: string): Promise<void> {
  const resolved = absolutePath(path);
  const paths = getPaths();
  if (resolved !== paths.projectsFile && resolved !== paths.credentialsFile) return;
  const metadata = await lstat(resolved);
  if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0) {
    throw new ProjectContextError(
      "CONFIG_PERMISSIONS_UNSAFE",
      `Host configuration ${resolved} must be a regular mode-0600 file`,
    );
  }
}

export async function loadProjectsConfig(path: string): Promise<ProjectsConfig> {
  await assertSecureHostConfig(path);
  const value = await parseYamlFile(path);
  if (!validateProjectsSchema(value)) {
    throw new ProjectContextError(
      "PROJECTS_SCHEMA_INVALID",
      `Invalid project registry ${path}: ${formatSchemaErrors(validateProjectsSchema.errors)}`,
    );
  }
  validateProjectInternals(value);
  return value;
}

export async function loadCredentialConfig(path: string): Promise<CredentialsConfig> {
  await assertSecureHostConfig(path);
  const value = await parseYamlFile(path);
  if (!validateCredentialsSchema(value)) {
    throw new ProjectContextError(
      "CREDENTIALS_SCHEMA_INVALID",
      `Invalid credential registry ${path}: ${formatSchemaErrors(validateCredentialsSchema.errors)}`,
    );
  }
  return value;
}

function validateProjectInternals(projects: ProjectsConfig): void {
  for (const [repositoryId, project] of Object.entries(projects.projects)) {
    const defaultProvider = project.issues.default;
    if (!project.issues.providers[defaultProvider]) {
      throw new ProjectContextError(
        "DEFAULT_PROVIDER_MISSING",
        `Project ${repositoryId} default provider "${defaultProvider}" is not configured`,
      );
    }

    for (const [providerAlias, provider] of Object.entries(project.issues.providers)) {
      const profile = projects.providers[provider.profile];
      if (!profile) {
        throw new ProjectContextError(
          "PROVIDER_PROFILE_MISSING",
          `Project ${repositoryId} provider ${providerAlias} references missing profile ${provider.profile}`,
        );
      }
      if (profile.type !== provider.type) {
        throw new ProjectContextError(
          "PROVIDER_TYPE_MISMATCH",
          `Project ${repositoryId} provider ${providerAlias} type does not match profile ${provider.profile}`,
        );
      }
      for (const pattern of provider.identifiers ?? []) {
        try {
          new RegExp(pattern);
        } catch {
          throw new ProjectContextError(
            "IDENTIFIER_PATTERN_INVALID",
            `Project ${repositoryId} provider ${providerAlias} has invalid identifier pattern ${pattern}`,
          );
        }
      }
      if (
        provider.type === "github" &&
        provider.target.repository === "inherit" &&
        !repositoryId.toLowerCase().startsWith("github.com/")
      ) {
        throw new ProjectContextError(
          "GITHUB_TARGET_CANNOT_INHERIT",
          `Project ${repositoryId} must configure an explicit GitHub Issues repository`,
        );
      }
    }
  }
}

export function validateRegistryReferences(
  projects: ProjectsConfig,
  credentials: CredentialsConfig,
): void {
  validateProjectInternals(projects);
  for (const [profileAlias, profile] of Object.entries(projects.providers)) {
    if (!credentials.credentials[profile.credential]) {
      throw new ProjectContextError(
        "CREDENTIAL_ALIAS_MISSING",
        `Provider profile ${profileAlias} references missing credential ${profile.credential}`,
      );
    }
  }
}

export function hashConfiguration(value: unknown): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(stableStringify(value));
  return hasher.digest("hex");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
      left.localeCompare(right),
    );
    return `{${entries
      .map(([key, nested]) => `${JSON.stringify(key)}:${stableStringify(nested)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
