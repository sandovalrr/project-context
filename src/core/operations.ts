import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  assertExpectedIdentity,
  createProviderAdapter,
  validateAdapterIdentity,
} from "../providers/factory.ts";
import type {
  AssignableUser,
  IssueComment,
  IssueCreateInput,
  IssueFieldCapability,
  IssueFieldName,
  IssueOption,
  IssueOptionField,
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
  claimPendingChange,
  consumePendingChange,
  createPendingChange,
  type IssueOperationRequest,
  markPendingChangeIndeterminate,
  type PendingChange,
  validatePendingChange,
} from "./pending.ts";
import { resolveRepository } from "./repository.ts";
import { routeIssueProvider } from "./routing.ts";
import { classifyCanonicalStatus, resolveStatusFilters } from "./status.ts";
import type { CanonicalStatus, ProjectProvider, ProviderProfile, ProviderType } from "./types.ts";
import { CANONICAL_STATUSES } from "./types.ts";

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
  if (provider.type === "linear") {
    for (const field of [
      "dueDate",
      "estimate",
      "cycle",
      "milestone",
      "parent",
      "blocks",
      "blockedBy",
      "relatedTo",
      "duplicateOf",
    ]) {
      allowed.add(field);
    }
    if (operation === "update") {
      for (const field of ["removeBlocks", "removeBlockedBy", "removeRelatedTo"]) {
        allowed.add(field);
      }
    }
  }
  if (provider.type === "github") {
    allowed.delete("priority");
    for (const field of [
      "issueType",
      "milestone",
      "parent",
      "blocks",
      "blockedBy",
      "duplicateOf",
    ]) {
      allowed.add(field);
    }
    if (operation === "update") {
      allowed.add("removeBlocks");
      allowed.add("removeBlockedBy");
    }
  }
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
  if (
    input.issueType !== undefined &&
    typeof input.issueType !== "string" &&
    !(operation === "update" && input.issueType === null)
  ) {
    throw new ProjectContextError(
      "FIELD_INVALID",
      "Field issueType must be a string, or null when updating",
    );
  }
  const dueDateParts =
    typeof input.dueDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(input.dueDate)
      ? input.dueDate.split("-").map(Number)
      : [];
  const dueDate =
    dueDateParts.length === 3
      ? new Date(
          Date.UTC(dueDateParts[0] as number, (dueDateParts[1] as number) - 1, dueDateParts[2]),
        )
      : undefined;
  const validDueDate =
    input.dueDate === undefined ||
    (operation === "update" && input.dueDate === null) ||
    (typeof input.dueDate === "string" &&
      dueDate !== undefined &&
      dueDate.getUTCFullYear() === dueDateParts[0] &&
      dueDate.getUTCMonth() + 1 === dueDateParts[1] &&
      dueDate.getUTCDate() === dueDateParts[2]);
  if (!validDueDate) {
    throw new ProjectContextError(
      "FIELD_INVALID",
      "Field dueDate must be an ISO date (YYYY-MM-DD), or null when updating",
    );
  }
  if (
    input.estimate !== undefined &&
    !(
      (operation === "update" && input.estimate === null) ||
      (typeof input.estimate === "number" && Number.isFinite(input.estimate) && input.estimate >= 0)
    )
  ) {
    throw new ProjectContextError(
      "FIELD_INVALID",
      "Field estimate must be a non-negative number, or null when updating",
    );
  }
  for (const field of ["cycle", "parent", "duplicateOf"] as const) {
    if (
      input[field] !== undefined &&
      (typeof input[field] !== "string" || !input[field].trim()) &&
      !(operation === "update" && input[field] === null)
    ) {
      throw new ProjectContextError(
        "FIELD_INVALID",
        `Field ${field} must be a string, or null when updating`,
      );
    }
  }
  if (
    input.milestone !== undefined &&
    (typeof input.milestone !== "string" || !input.milestone.trim()) &&
    !(operation === "update" && provider.type === "github" && input.milestone === null)
  ) {
    throw new ProjectContextError(
      "FIELD_INVALID",
      "Field milestone must be a string, or null when updating",
    );
  }
  for (const field of [
    "blocks",
    "blockedBy",
    "relatedTo",
    "removeBlocks",
    "removeBlockedBy",
    "removeRelatedTo",
  ] as const) {
    if (
      input[field] !== undefined &&
      (!Array.isArray(input[field]) ||
        input[field].some((identifier) => typeof identifier !== "string" || !identifier.trim()))
    ) {
      throw new ProjectContextError(
        "FIELD_INVALID",
        `Field ${field} must be an array of non-empty issue identifiers`,
      );
    }
  }
}

function referencedIssues(input: Record<string, unknown>): string[] {
  const single = [input.parent, input.duplicateOf].filter(
    (value): value is string => typeof value === "string",
  );
  const lists = [
    input.blocks,
    input.blockedBy,
    input.relatedTo,
    input.removeBlocks,
    input.removeBlockedBy,
    input.removeRelatedTo,
  ].flatMap((value) =>
    Array.isArray(value) ? value.filter((item) => typeof item === "string") : [],
  );

  return [...new Set([...single, ...lists])];
}

async function validateReferencedIssues(
  adapter: IssueProviderAdapter,
  request: IssueOperationRequest,
): Promise<void> {
  if (request.operation !== "create" && request.operation !== "update") return;

  const references = referencedIssues(request.input);
  if (
    request.operation === "update" &&
    references.some((reference) => reference === request.identifier)
  ) {
    throw new ProjectContextError(
      "ISSUE_RELATION_INVALID",
      "An issue cannot have a relationship with itself",
    );
  }

  const referenced = await Promise.all(references.map((reference) => adapter.get(reference)));
  if (
    request.operation === "update" &&
    referenced.some(
      (issue) => issue.identifier === request.identifier || issue.id === request.identifier,
    )
  ) {
    throw new ProjectContextError(
      "ISSUE_RELATION_INVALID",
      "An issue cannot have a relationship with itself",
    );
  }
}

function previewChanges(request: IssueOperationRequest): Record<string, unknown> {
  switch (request.operation) {
    case "create":
    case "update":
      return request.input;
    case "comment":
      return {
        comment: request.body,
        ...(request.commentId ? { comment_id: request.commentId } : {}),
        ...(request.parentCommentId ? { parent_comment_id: request.parentCommentId } : {}),
      };
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
  if (request.operation === "comment" && request.commentId && request.parentCommentId) {
    throw new ProjectContextError(
      "ISSUE_COMMENT_MODE_INVALID",
      "A comment write cannot edit and reply at the same time",
    );
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
  await validateReferencedIssues(current.adapter, routedRequest);
  if (
    routedRequest.operation === "comment" &&
    (routedRequest.commentId || routedRequest.parentCommentId)
  ) {
    if (!current.adapter.validateCommentTarget) {
      throw new ProjectContextError(
        "OPERATION_UNSUPPORTED",
        `${current.provider.type} does not support comment replies or edits`,
      );
    }
    await current.adapter.validateCommentTarget(routedRequest.identifier, {
      ...(routedRequest.commentId ? { commentId: routedRequest.commentId } : {}),
      ...(routedRequest.parentCommentId ? { parentCommentId: routedRequest.parentCommentId } : {}),
    });
  }
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
      await adapter.comment(request.identifier, request.body, {
        ...(request.commentId ? { commentId: request.commentId } : {}),
        ...(request.parentCommentId ? { parentCommentId: request.parentCommentId } : {}),
      });
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
        ? await adapter.transition(request.identifier, mapping.state, canonical)
        : (currentIssue as IssueSnapshot);

      return applyMappedLabels(adapter, request.identifier, result, mapping);
    }
  }
}

async function applyClaimedIssueOperation(
  pending: PendingChange,
  options: { cwd?: string; fetcher?: typeof fetch } = {},
): Promise<IssueSnapshot> {
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

  const executeWithFailureAudit = async () => {
    try {
      assertExpectedIdentity(current.profile, current.identity);
      return await execute(current.adapter, current.provider, pending.request, currentIssue);
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
  };

  const result = await executeWithFailureAudit();
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
  await consumePendingChange(pending.token);
  return result;
}

export async function applyIssueOperation(
  token: string,
  options: { cwd?: string; fetcher?: typeof fetch } = {},
): Promise<IssueSnapshot> {
  const pending = await claimPendingChange(token);
  try {
    return await applyClaimedIssueOperation(pending, options);
  } catch (error) {
    await markPendingChangeIndeterminate(token);
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

export interface ListedIssue extends IssueSnapshot {
  canonicalStatus: CanonicalStatus | null;
}

export interface IssueListGroup {
  providerAlias: string;
  issues: ListedIssue[];
  truncated: boolean;
}

async function listFromRuntime(
  current: OperationRuntime,
  statuses: CanonicalStatus[] | undefined,
  limit: number | undefined,
  includeArchived: boolean | undefined,
  parent: string | undefined,
): Promise<IssueListGroup> {
  const filters = statuses ? resolveStatusFilters(current.provider, statuses) : undefined;
  const result = await current.adapter.list({
    ...(filters ? { matches: filters.map((filter) => filter.match) } : {}),
    ...(limit === undefined ? {} : { limit }),
    ...(includeArchived === undefined ? {} : { includeArchived }),
    ...(parent === undefined ? {} : { parent }),
  });
  const issues = result.issues.flatMap((issue) => {
    const canonicalStatus = classifyCanonicalStatus(current.provider, issue);
    const included =
      statuses === undefined || (canonicalStatus && statuses.includes(canonicalStatus));

    return included ? [{ ...issue, canonicalStatus }] : [];
  });

  return {
    providerAlias: current.providerAlias,
    issues,
    truncated: result.truncated || issues.length !== result.issues.length,
  };
}

export async function listIssues(
  options: {
    cwd?: string;
    provider?: string;
    all?: boolean;
    statuses?: CanonicalStatus[];
    limit?: number;
    includeArchived?: boolean;
    parent?: string;
    fetcher?: typeof fetch;
  } = {},
): Promise<IssueListGroup[]> {
  if (options.all && options.provider) {
    throw new ProjectContextError("ROUTING_CONFLICT", "Use either --provider or --all, not both");
  }
  if (options.statuses?.length === 0) {
    throw new ProjectContextError(
      "STATUS_FILTER_EMPTY",
      "Canonical status filters must contain at least one status",
    );
  }
  if (
    options.limit !== undefined &&
    (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 100)
  ) {
    throw new ProjectContextError("LIMIT_INVALID", "Issue list limit must be between 1 and 100");
  }

  const cwd = options.cwd ?? process.cwd();
  const runtimeOptions = {
    ...(options.provider ? { explicitProvider: options.provider } : {}),
    ...(options.fetcher ? { fetcher: options.fetcher } : {}),
  };
  if (!options.all) {
    return [
      await listFromRuntime(
        await runtime(cwd, runtimeOptions),
        options.statuses,
        options.limit,
        options.includeArchived,
        options.parent,
      ),
    ];
  }

  const paths = getPaths();
  const projects = await loadProjectsConfig(paths.projectsFile);
  const repository = await resolveRepository(projects, cwd);
  const aliases = Object.keys(repository.project.issues.providers);

  return Promise.all(
    aliases.map(async (alias) =>
      listFromRuntime(
        await runtime(cwd, {
          explicitProvider: alias,
          ...(options.fetcher ? { fetcher: options.fetcher } : {}),
        }),
        options.statuses,
        options.limit,
        options.includeArchived,
        options.parent,
      ),
    ),
  );
}

export interface UserListGroup {
  providerAlias: string;
  users: AssignableUser[];
  truncated: boolean;
}

interface UserDiscoveryOptions {
  cwd?: string;
  provider?: string;
  all?: boolean;
  limit?: number;
  fetcher?: typeof fetch;
}

function validateUserDiscoveryOptions(options: UserDiscoveryOptions): void {
  if (options.all && options.provider) {
    throw new ProjectContextError("ROUTING_CONFLICT", "Use either --provider or --all, not both");
  }
  if (
    options.limit !== undefined &&
    (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 100)
  ) {
    throw new ProjectContextError("LIMIT_INVALID", "User list limit must be between 1 and 100");
  }
}

async function discoverUsersFromRuntime(
  current: OperationRuntime,
  query: string | undefined,
  limit: number | undefined,
): Promise<UserListGroup> {
  const result = query
    ? await current.adapter.searchUsers(query, limit)
    : await current.adapter.listUsers(limit);

  return {
    providerAlias: current.providerAlias,
    users: result.users,
    truncated: result.truncated,
  };
}

async function discoverUsers(
  query: string | undefined,
  options: UserDiscoveryOptions,
): Promise<UserListGroup[]> {
  validateUserDiscoveryOptions(options);
  const cwd = options.cwd ?? process.cwd();
  const runtimeOptions = {
    ...(options.provider ? { explicitProvider: options.provider } : {}),
    ...(options.fetcher ? { fetcher: options.fetcher } : {}),
  };

  if (!options.all) {
    return [
      await discoverUsersFromRuntime(await runtime(cwd, runtimeOptions), query, options.limit),
    ];
  }

  const paths = getPaths();
  const projects = await loadProjectsConfig(paths.projectsFile);
  const repository = await resolveRepository(projects, cwd);
  const aliases = Object.keys(repository.project.issues.providers);

  return Promise.all(
    aliases.map(async (alias) =>
      discoverUsersFromRuntime(
        await runtime(cwd, {
          explicitProvider: alias,
          ...(options.fetcher ? { fetcher: options.fetcher } : {}),
        }),
        query,
        options.limit,
      ),
    ),
  );
}

export function listUsers(options: UserDiscoveryOptions = {}): Promise<UserListGroup[]> {
  return discoverUsers(undefined, options);
}

export function searchUsers(
  query: string,
  options: UserDiscoveryOptions = {},
): Promise<UserListGroup[]> {
  const normalizedQuery = query.trim();
  if (!normalizedQuery) {
    throw new ProjectContextError("USER_QUERY_REQUIRED", "User search query cannot be empty");
  }

  return discoverUsers(normalizedQuery, options);
}

export interface IssueOptionSearchGroup {
  providerAlias: string;
  providerType: ProviderType;
  field: IssueOptionField;
  options: IssueOption[];
  truncated: boolean;
}

interface IssueOptionSearchOptions {
  cwd?: string;
  provider?: string;
  all?: boolean;
  limit?: number;
  fetcher?: typeof fetch;
}

function validateIssueOptionSearch(options: IssueOptionSearchOptions): void {
  if (options.all && options.provider) {
    throw new ProjectContextError("ROUTING_CONFLICT", "Use either --provider or --all, not both");
  }
  if (
    options.limit !== undefined &&
    (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 100)
  ) {
    throw new ProjectContextError(
      "LIMIT_INVALID",
      "Issue option search limit must be between 1 and 100",
    );
  }
}

async function searchOptionsFromRuntime(
  current: OperationRuntime,
  field: IssueOptionField,
  query: string,
  limit: number | undefined,
): Promise<IssueOptionSearchGroup> {
  const result = await current.adapter.searchOptions(field, query, limit);

  return {
    providerAlias: current.providerAlias,
    providerType: current.provider.type,
    field,
    options: result.options,
    truncated: result.truncated,
  };
}

export async function searchIssueOptions(
  field: IssueOptionField,
  query: string,
  options: IssueOptionSearchOptions = {},
): Promise<IssueOptionSearchGroup[]> {
  const normalizedQuery = query.trim();
  if (!normalizedQuery) {
    throw new ProjectContextError(
      "ISSUE_OPTION_QUERY_REQUIRED",
      "Issue option search query cannot be empty",
    );
  }
  validateIssueOptionSearch(options);
  const cwd = options.cwd ?? process.cwd();
  const runtimeOptions = {
    ...(options.provider ? { explicitProvider: options.provider } : {}),
    ...(options.fetcher ? { fetcher: options.fetcher } : {}),
  };

  if (!options.all) {
    return [
      await searchOptionsFromRuntime(
        await runtime(cwd, runtimeOptions),
        field,
        normalizedQuery,
        options.limit,
      ),
    ];
  }

  const paths = getPaths();
  const projects = await loadProjectsConfig(paths.projectsFile);
  const repository = await resolveRepository(projects, cwd);
  const aliases = Object.keys(repository.project.issues.providers);

  return Promise.all(
    aliases.map(async (alias) =>
      searchOptionsFromRuntime(
        await runtime(cwd, {
          explicitProvider: alias,
          ...(options.fetcher ? { fetcher: options.fetcher } : {}),
        }),
        field,
        normalizedQuery,
        options.limit,
      ),
    ),
  );
}

export interface IssueCreatePresetCapability {
  name: string;
  fields: Record<string, unknown>;
  template: string | null;
}

export interface IssueCapabilitiesGroup {
  providerAlias: string;
  providerType: ProviderType;
  fields: IssueFieldCapability[];
  canonicalStatuses: CanonicalStatus[];
  create: {
    required: IssueFieldName[];
    defaults: Record<string, unknown>;
    presets: IssueCreatePresetCapability[];
  };
}

interface IssueCapabilitiesOptions {
  cwd?: string;
  provider?: string;
  all?: boolean;
  fetcher?: typeof fetch;
}

function createPolicyCapabilities(provider: ProjectProvider): IssueCapabilitiesGroup["create"] {
  const policy = provider.create;
  const required: IssueFieldName[] = [
    "title",
    ...(policy?.required ?? []).filter((field) => field !== "title"),
  ];
  const presets = Object.entries(policy?.presets ?? {}).map(([name, preset]) => {
    const { template, ...fields } = preset;

    return { name, fields, template: template ?? null };
  });

  return {
    required,
    defaults: policy?.defaults ?? {},
    presets,
  };
}

async function capabilitiesFromRuntime(current: OperationRuntime): Promise<IssueCapabilitiesGroup> {
  const providerCapabilities = await current.adapter.capabilities();
  const create = createPolicyCapabilities(current.provider);
  const required = new Set(create.required);
  const fields = providerCapabilities.fields.map((field) => ({
    ...field,
    requiredOnCreate: field.requiredOnCreate || required.has(field.field),
  }));
  const canonicalStatuses = CANONICAL_STATUSES.filter(
    (status) => current.provider.mappings?.status?.[status] !== undefined,
  );

  return {
    providerAlias: current.providerAlias,
    providerType: current.provider.type,
    fields,
    canonicalStatuses,
    create,
  };
}

export async function getIssueCapabilities(
  options: IssueCapabilitiesOptions = {},
): Promise<IssueCapabilitiesGroup[]> {
  if (options.all && options.provider) {
    throw new ProjectContextError("ROUTING_CONFLICT", "Use either --provider or --all, not both");
  }

  const cwd = options.cwd ?? process.cwd();
  const runtimeOptions = {
    ...(options.provider ? { explicitProvider: options.provider } : {}),
    ...(options.fetcher ? { fetcher: options.fetcher } : {}),
  };

  if (!options.all) {
    return [await capabilitiesFromRuntime(await runtime(cwd, runtimeOptions))];
  }

  const paths = getPaths();
  const projects = await loadProjectsConfig(paths.projectsFile);
  const repository = await resolveRepository(projects, cwd);
  const aliases = Object.keys(repository.project.issues.providers);

  return Promise.all(
    aliases.map(async (alias) =>
      capabilitiesFromRuntime(
        await runtime(cwd, {
          explicitProvider: alias,
          ...(options.fetcher ? { fetcher: options.fetcher } : {}),
        }),
      ),
    ),
  );
}

export async function getIssue(
  reference: string,
  options: {
    cwd?: string;
    provider?: string;
    includeRelations?: boolean;
    fetcher?: typeof fetch;
  } = {},
): Promise<{ providerAlias: string; issue: IssueSnapshot }> {
  const current = await runtime(options.cwd ?? process.cwd(), {
    ...(options.provider ? { explicitProvider: options.provider } : {}),
    reference,
    ...(options.fetcher ? { fetcher: options.fetcher } : {}),
  });
  return {
    providerAlias: current.providerAlias,
    issue: await current.adapter.get(current.routedReference ?? reference, {
      ...(options.includeRelations === undefined
        ? {}
        : { includeRelations: options.includeRelations }),
    }),
  };
}

export interface IssueCommentListGroup {
  providerAlias: string;
  providerType: ProviderType;
  issueIdentifier: string;
  comments: IssueComment[];
  truncated: boolean;
}

export async function listIssueComments(
  reference: string,
  options: { cwd?: string; provider?: string; limit?: number; fetcher?: typeof fetch } = {},
): Promise<IssueCommentListGroup> {
  if (
    options.limit !== undefined &&
    (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 100)
  ) {
    throw new ProjectContextError(
      "LIMIT_INVALID",
      "Issue comment list limit must be between 1 and 100",
    );
  }

  const current = await runtime(options.cwd ?? process.cwd(), {
    ...(options.provider ? { explicitProvider: options.provider } : {}),
    reference,
    ...(options.fetcher ? { fetcher: options.fetcher } : {}),
  });
  const issueIdentifier = current.routedReference ?? reference;
  const result = await current.adapter.listComments(issueIdentifier, options.limit);

  return {
    providerAlias: current.providerAlias,
    providerType: current.provider.type,
    issueIdentifier,
    comments: result.comments,
    truncated: result.truncated,
  };
}
