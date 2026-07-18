import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  assertExpectedIdentity,
  createProviderAdapter,
  validateAdapterIdentity,
} from "../providers/factory.ts";
import type {
  IssueCreateInput,
  IssueProviderAdapter,
  IssueSnapshot,
  IssueUpdateInput,
  ProviderIdentity,
} from "../providers/types.ts";
import { appendAuditEvent } from "./audit.ts";
import {
  hashConfiguration,
  loadCredentialConfig,
  loadProjectsConfig,
  validateRegistryReferences,
} from "./config.ts";
import { resolveCredentialAlias } from "./credentials.ts";
import { ProjectContextError } from "./errors.ts";
import { getPaths } from "./paths.ts";
import {
  consumePendingChange,
  createPendingChange,
  type IssueOperationRequest,
  readPendingChange,
  validatePendingChange,
} from "./pending.ts";
import { resolveRepository } from "./repository.ts";
import { routeIssueProvider } from "./routing.ts";
import type { CanonicalStatus, ProjectProvider, ProviderProfile } from "./types.ts";

interface OperationRuntime {
  repositoryId: string;
  gitRoot: string;
  configHash: string;
  providerAlias: string;
  provider: ProjectProvider;
  profile: ProviderProfile;
  adapter: IssueProviderAdapter;
  identity: ProviderIdentity;
  identityHash: string;
  routedReference?: string;
}

export interface PrepareResult {
  token: string;
  expiresAt: string;
  repositoryId: string;
  providerAlias: string;
  providerType: string;
  identity: { id: string; name: string; scope: string };
  operation: IssueOperationRequest["operation"];
  target?: { identifier: string; title: string; version: string };
  changes: Record<string, unknown>;
}

function requestReference(request: IssueOperationRequest): string | undefined {
  return request.operation === "create" ? undefined : request.identifier;
}

async function runtime(
  cwd: string,
  options: { explicitProvider?: string; reference?: string; fetcher?: typeof fetch } = {},
): Promise<OperationRuntime> {
  const paths = getPaths();
  const projects = await loadProjectsConfig(paths.projectsFile);
  const credentials = await loadCredentialConfig(paths.credentialsFile);
  validateRegistryReferences(projects, credentials);
  const repository = await resolveRepository(projects, cwd);
  const route = routeIssueProvider(repository.project, projects.providers, {
    ...(options.explicitProvider ? { explicitProvider: options.explicitProvider } : {}),
    ...(options.reference ? { reference: options.reference } : {}),
  });
  const profile = projects.providers[route.provider.profile];
  if (!profile)
    throw new ProjectContextError("PROVIDER_PROFILE_MISSING", "Provider profile missing");
  const credential = await resolveCredentialAlias(credentials, profile.credential);
  const adapter = createProviderAdapter(
    profile,
    route.provider,
    credential,
    repository,
    options.fetcher ?? fetch,
  );
  const identity = await validateAdapterIdentity(adapter, profile);
  return {
    repositoryId: repository.repositoryId,
    gitRoot: repository.gitRoot,
    configHash: hashConfiguration({ projects, credentials }),
    providerAlias: route.alias,
    provider: route.provider,
    profile,
    adapter,
    identity,
    identityHash: hashConfiguration(identity),
    ...(route.reference ? { routedReference: route.reference } : {}),
  };
}

function withRoutedReference(
  request: IssueOperationRequest,
  routedReference: string | undefined,
): IssueOperationRequest {
  if (request.operation === "create" || !routedReference) return request;
  return { ...request, identifier: routedReference };
}

async function normalizeRequest(
  request: IssueOperationRequest,
  provider: ProjectProvider,
): Promise<IssueOperationRequest> {
  if (request.operation !== "create") return request;
  const policy = provider.create;
  const preset = request.preset ? policy?.presets?.[request.preset] : undefined;
  if (request.preset && !preset) {
    throw new ProjectContextError(
      "PRESET_NOT_CONFIGURED",
      `Issue creation preset ${request.preset} is not configured`,
    );
  }
  const { template, ...presetFields } = preset ?? {};
  const input = { ...(policy?.defaults ?? {}), ...presetFields, ...request.input };
  if (template && input.description === undefined) {
    input.description = await readFile(
      join(getPaths().templatesDirectory, `${template}.md`),
      "utf8",
    );
  }
  if (typeof input.title !== "string" || !input.title.trim()) {
    throw new ProjectContextError("ISSUE_TITLE_REQUIRED", "Issue creation requires a title");
  }
  for (const field of policy?.required ?? []) {
    if (typeof input[field] !== "string" || !input[field].trim()) {
      throw new ProjectContextError(
        "ISSUE_FIELD_REQUIRED",
        `Issue creation requires field ${field}`,
      );
    }
  }
  validateFields(input, provider, "create");
  return { operation: "create", input, ...(request.preset ? { preset: request.preset } : {}) };
}

function validateFields(
  input: Record<string, unknown>,
  provider: ProjectProvider,
  operation: "create" | "update",
): void {
  const allowed = new Set(["title", "description", "labels", "assignee", "priority"]);
  if (operation === "create" && provider.type === "jira-cloud") allowed.add("issueType");
  if (provider.type === "github") allowed.delete("priority");
  for (const field of Object.keys(input)) {
    if (!allowed.has(field)) {
      throw new ProjectContextError(
        "FIELD_UNSUPPORTED",
        `Field ${field} is not supported for ${provider.type} ${operation}`,
      );
    }
  }
  for (const field of ["title", "description"] as const) {
    if (input[field] !== undefined && typeof input[field] !== "string") {
      throw new ProjectContextError("FIELD_INVALID", `Field ${field} must be a string`);
    }
  }
  if (
    input.labels !== undefined &&
    (!Array.isArray(input.labels) || input.labels.some((label) => typeof label !== "string"))
  ) {
    throw new ProjectContextError("FIELD_INVALID", "Field labels must be an array of strings");
  }
  if (
    input.assignee !== undefined &&
    typeof input.assignee !== "string" &&
    !(operation === "update" && input.assignee === null)
  ) {
    throw new ProjectContextError(
      "FIELD_INVALID",
      "Field assignee must be a string, or null when updating",
    );
  }
  if (
    input.priority !== undefined &&
    typeof input.priority !== "string" &&
    typeof input.priority !== "number"
  ) {
    throw new ProjectContextError("FIELD_INVALID", "Field priority must be a string or number");
  }
  if (input.issueType !== undefined && typeof input.issueType !== "string") {
    throw new ProjectContextError("FIELD_INVALID", "Field issueType must be a string");
  }
}

function previewChanges(request: IssueOperationRequest): Record<string, unknown> {
  switch (request.operation) {
    case "create":
    case "update":
      return request.input;
    case "comment":
      return { comment: request.body };
    case "transition":
      return { status: request.status };
    case "close":
      return { status: "done" };
    case "reopen":
      return { status: "open" };
    case "link":
      return { target_url: request.targetUrl };
  }
}

export async function prepareIssueOperation(
  request: IssueOperationRequest,
  options: { cwd?: string; provider?: string; fetcher?: typeof fetch } = {},
): Promise<PrepareResult> {
  if (request.operation !== "create" && !request.identifier.trim()) {
    throw new ProjectContextError("ISSUE_IDENTIFIER_REQUIRED", "Issue identifier is required");
  }
  if (request.operation === "comment" && !request.body.trim()) {
    throw new ProjectContextError("ISSUE_COMMENT_REQUIRED", "Issue comment cannot be empty");
  }
  if (
    request.operation === "transition" &&
    !["open", "in_progress", "done", "canceled"].includes(request.status)
  ) {
    throw new ProjectContextError("STATUS_INVALID", `Unknown canonical status ${request.status}`);
  }
  if (request.operation === "link") {
    try {
      const target = new URL(request.targetUrl);
      if (target.protocol !== "https:") throw new Error("not HTTPS");
    } catch {
      throw new ProjectContextError(
        "ISSUE_URL_INVALID",
        "Issue link target must be an absolute HTTPS URL",
      );
    }
  }
  const reference = requestReference(request);
  const current = await runtime(options.cwd ?? process.cwd(), {
    ...(options.provider ? { explicitProvider: options.provider } : {}),
    ...(reference ? { reference } : {}),
    ...(options.fetcher ? { fetcher: options.fetcher } : {}),
  });
  if (request.operation === "update") {
    if (Object.keys(request.input).length === 0) {
      throw new ProjectContextError("ISSUE_UPDATE_EMPTY", "Issue update has no changed fields");
    }
    validateFields(request.input, current.provider, "update");
  }
  const routedRequest = withRoutedReference(
    await normalizeRequest(request, current.provider),
    current.routedReference,
  );
  const issue =
    routedRequest.operation === "create"
      ? undefined
      : await current.adapter.get(routedRequest.identifier);
  const pending = await createPendingChange({
    repositoryId: current.repositoryId,
    gitRoot: current.gitRoot,
    configHash: current.configHash,
    providerAlias: current.providerAlias,
    identityHash: current.identityHash,
    ...(issue ? { expectedIssueVersion: issue.version } : {}),
    request: routedRequest,
  });
  return {
    token: pending.token,
    expiresAt: pending.expiresAt,
    repositoryId: current.repositoryId,
    providerAlias: current.providerAlias,
    providerType: current.provider.type,
    identity: {
      id: current.identity.principalId,
      name: current.identity.principalName,
      scope: current.identity.scopeName,
    },
    operation: routedRequest.operation,
    ...(issue
      ? { target: { identifier: issue.identifier, title: issue.title, version: issue.version } }
      : {}),
    changes: previewChanges(routedRequest),
  };
}

function nativeStatus(provider: ProjectProvider, canonical: CanonicalStatus) {
  const mapping = provider.mappings?.status?.[canonical];
  if (!mapping) {
    throw new ProjectContextError(
      "STATUS_MAPPING_MISSING",
      `No ${canonical} status mapping is configured for ${provider.type}`,
    );
  }
  return typeof mapping === "string" ? { state: mapping } : mapping;
}

function mappedLabels(current: string[], add: string[] = [], remove: string[] = []): string[] {
  const retained = current.filter((label) => !remove.includes(label));

  return [...new Set([...retained, ...add])];
}

async function applyMappedLabels(
  adapter: IssueProviderAdapter,
  identifier: string,
  result: IssueSnapshot,
  mapping: ReturnType<typeof nativeStatus>,
): Promise<IssueSnapshot> {
  if (!mapping.add_labels?.length && !mapping.remove_labels?.length) return result;

  const labels = mappedLabels(result.labels, mapping.add_labels, mapping.remove_labels);

  return adapter.update(identifier, { labels });
}

async function execute(
  adapter: IssueProviderAdapter,
  provider: ProjectProvider,
  request: IssueOperationRequest,
  currentIssue?: IssueSnapshot,
): Promise<IssueSnapshot> {
  switch (request.operation) {
    case "create":
      return adapter.create(request.input as unknown as IssueCreateInput);
    case "update":
      return adapter.update(request.identifier, request.input as IssueUpdateInput);
    case "comment":
      await adapter.comment(request.identifier, request.body);
      return adapter.get(request.identifier);
    case "link":
      await adapter.link(request.identifier, request.targetUrl);
      return adapter.get(request.identifier);
    case "transition":
    case "close":
    case "reopen": {
      const canonical =
        request.operation === "transition"
          ? (request.status as CanonicalStatus)
          : request.operation === "close"
            ? "done"
            : "open";
      if (!["open", "in_progress", "done", "canceled"].includes(canonical)) {
        throw new ProjectContextError("STATUS_INVALID", `Unknown canonical status ${canonical}`);
      }

      const mapping = nativeStatus(provider, canonical);
      const result = mapping.state
        ? await adapter.transition(request.identifier, mapping.state)
        : (currentIssue as IssueSnapshot);

      return applyMappedLabels(adapter, request.identifier, result, mapping);
    }
  }
}

export async function applyIssueOperation(
  token: string,
  options: { cwd?: string; fetcher?: typeof fetch } = {},
): Promise<IssueSnapshot> {
  const pending = await readPendingChange(token);
  const reference = requestReference(pending.request);
  const current = await runtime(options.cwd ?? process.cwd(), {
    explicitProvider: pending.providerAlias,
    ...(reference ? { reference } : {}),
    ...(options.fetcher ? { fetcher: options.fetcher } : {}),
  });
  const currentIssue =
    pending.request.operation === "create"
      ? undefined
      : await current.adapter.get(pending.request.identifier);
  await validatePendingChange(pending, {
    repositoryId: current.repositoryId,
    gitRoot: current.gitRoot,
    configHash: current.configHash,
    providerAlias: current.providerAlias,
    identityHash: current.identityHash,
    ...(currentIssue ? { issueVersion: currentIssue.version } : {}),
  });

  try {
    assertExpectedIdentity(current.profile, current.identity);
    const result = await execute(current.adapter, current.provider, pending.request, currentIssue);
    await consumePendingChange(token);
    await appendAuditEvent({
      operation: pending.request.operation,
      outcome: "success",
      repositoryId: current.repositoryId,
      providerAlias: current.providerAlias,
      providerType: current.provider.type,
      identityId: current.identity.principalId,
      issueIdentifier: result.identifier,
      issueId: result.id,
    });
    return result;
  } catch (error) {
    await appendAuditEvent({
      operation: pending.request.operation,
      outcome: "failure",
      repositoryId: current.repositoryId,
      providerAlias: current.providerAlias,
      providerType: current.provider.type,
      identityId: current.identity.principalId,
      ...(currentIssue
        ? { issueIdentifier: currentIssue.identifier, issueId: currentIssue.id }
        : {}),
      errorCode: error instanceof ProjectContextError ? error.code : "UNEXPECTED",
    });
    throw error;
  }
}

export async function searchIssues(
  query: string,
  options: {
    cwd?: string;
    provider?: string;
    all?: boolean;
    limit?: number;
    fetcher?: typeof fetch;
  } = {},
): Promise<Array<{ providerAlias: string; issues: IssueSnapshot[] }>> {
  const cwd = options.cwd ?? process.cwd();
  if (!options.all) {
    const current = await runtime(cwd, {
      ...(options.provider ? { explicitProvider: options.provider } : {}),
      ...(options.fetcher ? { fetcher: options.fetcher } : {}),
    });
    return [
      {
        providerAlias: current.providerAlias,
        issues: await current.adapter.search(query, options.limit),
      },
    ];
  }
  if (options.provider) {
    throw new ProjectContextError("ROUTING_CONFLICT", "Use either --provider or --all, not both");
  }
  const paths = getPaths();
  const projects = await loadProjectsConfig(paths.projectsFile);
  const repository = await resolveRepository(projects, cwd);
  const results = [];
  for (const alias of Object.keys(repository.project.issues.providers)) {
    const current = await runtime(cwd, {
      explicitProvider: alias,
      ...(options.fetcher ? { fetcher: options.fetcher } : {}),
    });
    results.push({
      providerAlias: alias,
      issues: await current.adapter.search(query, options.limit),
    });
  }
  return results;
}

export async function getIssue(
  reference: string,
  options: { cwd?: string; provider?: string; fetcher?: typeof fetch } = {},
): Promise<{ providerAlias: string; issue: IssueSnapshot }> {
  const current = await runtime(options.cwd ?? process.cwd(), {
    ...(options.provider ? { explicitProvider: options.provider } : {}),
    reference,
    ...(options.fetcher ? { fetcher: options.fetcher } : {}),
  });
  return {
    providerAlias: current.providerAlias,
    issue: await current.adapter.get(current.routedReference ?? reference),
  };
}
