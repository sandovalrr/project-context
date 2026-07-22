import { z } from "zod";
import { ProjectContextError } from "../core/errors.ts";
import type { LinearProjectProvider, LinearProviderProfile, StatusMatch } from "../core/types.ts";
import { filterIssueOptions, issueFieldCapability } from "./capabilities.ts";
import { requestJson, versionOf } from "./http.ts";
import {
  HostedLinearMcpConnector,
  type LinearMcpConnector,
  type LinearMcpSession,
} from "./linear-mcp.ts";
import type {
  AssignableUser,
  IssueComment,
  IssueCommentListResult,
  IssueCreateInput,
  IssueListOptions,
  IssueListResult,
  IssueOptionField,
  IssueOptionListResult,
  IssueProviderAdapter,
  IssueSnapshot,
  IssueUpdateInput,
  ProviderIdentity,
  ProviderIssueCapabilities,
  UserListResult,
} from "./types.ts";

const MAX_MCP_PAGES = 10;
const MCP_PAGE_SIZE = 250;

const linearPriorities = [
  { value: 0, label: "No priority" },
  { value: 1, label: "Urgent" },
  { value: 2, label: "High" },
  { value: 3, label: "Medium" },
  { value: 4, label: "Low" },
];

const linearMcpIssueSchema = z
  .object({
    id: z.string().min(1),
    title: z.string(),
    description: z.string().nullable().optional(),
    priority: z.object({ value: z.number(), name: z.string() }).nullable().optional(),
    url: z.string().url(),
    createdAt: z.string(),
    updatedAt: z.string(),
    dueDate: z.string().nullable().optional(),
    status: z.string(),
    labels: z.array(z.string()).optional(),
    assignee: z.string().nullable().optional(),
    assigneeId: z.string().nullable().optional(),
    createdBy: z.string().nullable().optional(),
    createdById: z.string().nullable().optional(),
    projectId: z.string().nullable().optional(),
    teamId: z.string().min(1),
  })
  .passthrough();
const linearMcpIssuePageSchema = z
  .object({
    issues: z.array(linearMcpIssueSchema),
    hasNextPage: z.boolean(),
    cursor: z.string().nullable().optional(),
  })
  .passthrough();
const linearMcpUserSchema = z
  .object({
    id: z.string().min(1),
    name: z.string(),
    displayName: z.string().optional(),
    email: z.string().optional(),
    isActive: z.boolean(),
  })
  .passthrough();
const linearMcpUserPageSchema = z
  .object({
    users: z.array(linearMcpUserSchema),
    hasNextPage: z.boolean(),
    cursor: z.string().nullable().optional(),
  })
  .passthrough();
const linearMcpIdentitySchema = linearMcpUserSchema.extend({
  email: z.string(),
});
const linearMcpLabelSchema = z
  .object({ id: z.string().min(1), name: z.string().min(1) })
  .passthrough();
const linearMcpLabelPageSchema = z
  .object({
    labels: z.array(linearMcpLabelSchema),
    hasNextPage: z.boolean(),
    cursor: z.string().nullable().optional(),
  })
  .passthrough();
const linearMcpStatusSchema = z
  .object({ id: z.string().min(1), name: z.string().min(1), type: z.string() })
  .passthrough();
const linearMcpStatusesSchema = z.array(linearMcpStatusSchema);
const linearMcpCommentSchema = z
  .object({
    id: z.string().min(1),
    body: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
    author: z.object({ id: z.string(), name: z.string() }).nullable().optional(),
  })
  .passthrough();
const linearMcpCommentPageSchema = z
  .object({
    comments: z.array(linearMcpCommentSchema),
    hasNextPage: z.boolean(),
    cursor: z.string().nullable().optional(),
  })
  .passthrough();
const linearMcpSavedIssueSchema = z.object({ id: z.string().min(1) }).passthrough();

type LinearMcpIssue = z.infer<typeof linearMcpIssueSchema>;
type LinearMcpUser = z.infer<typeof linearMcpUserSchema>;
type LinearMcpLabel = z.infer<typeof linearMcpLabelSchema>;

interface CollectedIssues {
  issues: LinearMcpIssue[];
  truncated: boolean;
}

interface CollectedUsers {
  users: LinearMcpUser[];
  truncated: boolean;
}

interface CollectedLabels {
  labels: LinearMcpLabel[];
  truncated: boolean;
}

function parseLinearMcpOutput<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;

  throw new ProjectContextError(
    "LINEAR_MCP_RESPONSE_INVALID",
    "Linear MCP returned a response that does not match the required issue contract",
  );
}

function normalized(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function sameName(left: string, right: string): boolean {
  return left.localeCompare(right, undefined, { sensitivity: "accent" }) === 0;
}

function matchesStatus(issue: LinearMcpIssue, matches: StatusMatch[]): boolean {
  if (matches.length === 0) return true;

  const labels = issue.labels ?? [];

  return matches.some((match) => {
    const states = match.states ?? (match.state ? [match.state] : []);
    const stateMatches =
      states.length === 0 || states.some((state) => sameName(state, issue.status));
    const includedLabelsMatch = match.labelsAll.every((label) =>
      labels.some((candidate) => sameName(candidate, label)),
    );
    const excludedLabelsMatch = match.labelsNone.every(
      (label) => !labels.some((candidate) => sameName(candidate, label)),
    );

    return stateMatches && includedLabelsMatch && excludedLabelsMatch;
  });
}

function pageSize(limit: number): number {
  return Math.min(Math.max(limit + 1, 50), MCP_PAGE_SIZE);
}

export class LinearIssuesAdapter implements IssueProviderAdapter {
  readonly type = "linear" as const;

  private readonly connector: LinearMcpConnector;

  constructor(
    _profile: LinearProviderProfile,
    private readonly target: LinearProjectProvider["target"],
    private readonly credential: Record<string, string>,
    private readonly fetcher: typeof fetch = fetch,
    connector?: LinearMcpConnector,
  ) {
    this.connector =
      connector ?? new HostedLinearMcpConnector(this.credential.token ?? "", this.fetcher);
  }

  async #organization(): Promise<{ id: string; name: string }> {
    const result = await requestJson<{
      data?: { organization: { id: string; name: string } };
      errors?: Array<{ message: string }>;
    }>(
      this.fetcher,
      "https://api.linear.app/graphql",
      {
        method: "POST",
        headers: {
          Authorization: this.credential.token ?? "",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          query: "query Identity { organization { id name } }",
          variables: {},
        }),
      },
      { provider: "Linear", allowedOrigin: "https://api.linear.app", access: "read" },
    );
    if (result.errors?.length || !result.data) {
      throw new ProjectContextError(
        "LINEAR_GRAPHQL_ERROR",
        "Linear workspace identity query failed; provider response details were redacted",
      );
    }

    return result.data.organization;
  }

  #snapshot(issue: LinearMcpIssue): IssueSnapshot {
    return {
      provider: this.type,
      id: issue.id,
      identifier: issue.id,
      title: issue.title,
      description: issue.description ?? null,
      status: issue.status,
      labels: issue.labels ?? [],
      assignee:
        issue.assigneeId && issue.assignee
          ? {
              provider: this.type,
              assignee: issue.assigneeId,
              displayName: issue.assignee,
              username: null,
              email: null,
              active: true,
            }
          : null,
      creator:
        issue.createdById && issue.createdBy
          ? {
              provider: this.type,
              id: issue.createdById,
              displayName: issue.createdBy,
              username: null,
              email: null,
            }
          : null,
      priority: issue.priority ? { value: issue.priority.value, label: issue.priority.name } : null,
      issueType: null,
      createdAt: issue.createdAt,
      dueDate: issue.dueDate ?? null,
      url: issue.url,
      updatedAt: issue.updatedAt,
      version: versionOf(issue.updatedAt, issue.id),
    };
  }

  #projectMatches(issue: LinearMcpIssue): boolean {
    const project = this.target.project;
    if (project === "any") return true;
    if (project === "none") return !issue.projectId;
    if ("include" in project) {
      return project.include.some(({ id }) => id === issue.projectId);
    }

    return issue.projectId === project.id;
  }

  #assertTarget(issue: LinearMcpIssue): void {
    if (issue.teamId === this.target.team.id && this.#projectMatches(issue)) return;

    throw new ProjectContextError(
      "ISSUE_OUTSIDE_TARGET",
      "Linear issue is outside the configured team/project target",
    );
  }

  #targetedSnapshot(issue: LinearMcpIssue): IssueSnapshot {
    this.#assertTarget(issue);
    return this.#snapshot(issue);
  }

  #projectStreams(): Array<string | undefined> {
    const project = this.target.project;
    if (typeof project === "string") return [undefined];
    if ("include" in project) return project.include.map(({ id }) => id);

    return [project.id];
  }

  #creationProject(): string | undefined {
    const project = this.target.project;
    if (typeof project === "string") return undefined;
    if ("include" in project) return project.create_in;

    return project.id;
  }

  #issuesFromPage(page: LinearMcpIssue[], projectId: string | undefined): LinearMcpIssue[] {
    for (const issue of page) {
      if (issue.teamId !== this.target.team.id) {
        throw new ProjectContextError(
          "ISSUE_OUTSIDE_TARGET",
          "Linear MCP returned an issue outside the configured team",
        );
      }
      if (this.target.project !== "none" && !this.#projectMatches(issue)) {
        throw new ProjectContextError(
          "ISSUE_OUTSIDE_TARGET",
          `Linear MCP returned an issue outside the configured project${projectId ? ` ${projectId}` : ""}`,
        );
      }
    }

    return this.target.project === "none" ? page.filter((issue) => !issue.projectId) : page;
  }

  async #collectIssueStream(
    session: LinearMcpSession,
    desired: number,
    matches: StatusMatch[],
    projectId: string | undefined,
    query: string | undefined,
    cursor?: string,
    collected: LinearMcpIssue[] = [],
    pages = 0,
  ): Promise<CollectedIssues> {
    const value = await session.call("list_issues", {
      team: this.target.team.id,
      limit: pageSize(desired),
      orderBy: "updatedAt",
      includeArchived: false,
      ...(projectId ? { project: projectId } : {}),
      ...(query ? { query } : {}),
      ...(cursor ? { cursor } : {}),
    });
    const page = parseLinearMcpOutput(linearMcpIssuePageSchema, value);
    const issues = this.#issuesFromPage(page.issues, projectId).filter((issue) =>
      matchesStatus(issue, matches),
    );
    const combined = [...collected, ...issues];

    if (combined.length >= desired) return { issues: combined, truncated: true };
    if (!page.hasNextPage) return { issues: combined, truncated: false };
    if (!page.cursor || pages + 1 >= MAX_MCP_PAGES) {
      return { issues: combined, truncated: true };
    }

    return this.#collectIssueStream(
      session,
      desired,
      matches,
      projectId,
      query,
      page.cursor,
      combined,
      pages + 1,
    );
  }

  async #collectIssues(
    session: LinearMcpSession,
    limit: number,
    matches: StatusMatch[],
    query?: string,
  ): Promise<CollectedIssues> {
    const streams = await Promise.all(
      this.#projectStreams().map((projectId) =>
        this.#collectIssueStream(session, limit + 1, matches, projectId, query),
      ),
    );
    const unique = new Map(
      streams.flatMap(({ issues }) => issues).map((issue) => [issue.id, issue]),
    );
    const issues = [...unique.values()].toSorted((left, right) =>
      right.updatedAt.localeCompare(left.updatedAt),
    );

    return {
      issues: issues.slice(0, limit),
      truncated: issues.length > limit || streams.some(({ truncated }) => truncated),
    };
  }

  async #collectUsers(
    session: LinearMcpSession,
    limit: number,
    query?: string,
    cursor?: string,
    collected: LinearMcpUser[] = [],
    pages = 0,
  ): Promise<CollectedUsers> {
    const value = await session.call("list_users", {
      team: this.target.team.id,
      limit: pageSize(limit),
      ...(query ? { query } : {}),
      ...(cursor ? { cursor } : {}),
    });
    const page = parseLinearMcpOutput(linearMcpUserPageSchema, value);
    const normalizedQuery = query ? normalized(query) : undefined;
    const users = page.users.filter(
      (user) =>
        user.isActive &&
        (!normalizedQuery ||
          [user.name, user.displayName ?? "", user.email ?? ""].some((field) =>
            normalized(field).includes(normalizedQuery),
          )),
    );
    const combined = [...collected, ...users];

    if (combined.length > limit) return { users: combined, truncated: true };
    if (!page.hasNextPage) return { users: combined, truncated: false };
    if (!page.cursor || pages + 1 >= MAX_MCP_PAGES) {
      return { users: combined, truncated: true };
    }

    return this.#collectUsers(session, limit, query, page.cursor, combined, pages + 1);
  }

  async #collectLabels(
    session: LinearMcpSession,
    limit: number,
    query?: string,
    cursor?: string,
    collected: LinearMcpLabel[] = [],
    pages = 0,
  ): Promise<CollectedLabels> {
    const value = await session.call("list_issue_labels", {
      team: this.target.team.id,
      limit: pageSize(limit),
      ...(query ? { name: query } : {}),
      ...(cursor ? { cursor } : {}),
    });
    const page = parseLinearMcpOutput(linearMcpLabelPageSchema, value);
    const labels = query
      ? page.labels.filter(({ name }) => normalized(name).includes(normalized(query)))
      : page.labels;
    const combined = [...collected, ...labels];

    if (combined.length > limit) return { labels: combined, truncated: true };
    if (!page.hasNextPage) return { labels: combined, truncated: false };
    if (!page.cursor || pages + 1 >= MAX_MCP_PAGES) {
      return { labels: combined, truncated: true };
    }

    return this.#collectLabels(session, limit, query, page.cursor, combined, pages + 1);
  }

  #assignableUser(user: LinearMcpUser): AssignableUser {
    return {
      provider: this.type,
      assignee: user.id,
      displayName: user.displayName || user.name,
      username: null,
      email: user.email || null,
      active: user.isActive,
    };
  }

  async #users(query: string | undefined, limit: number): Promise<UserListResult> {
    return this.connector.withSession(async (session) => {
      const result = await this.#collectUsers(session, limit, query);

      return {
        users: result.users.slice(0, limit).map((user) => this.#assignableUser(user)),
        truncated: result.truncated,
      };
    });
  }

  #priority(value: string | number): number {
    if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 4) {
      return value;
    }

    const priorities: Record<string, number> = {
      "no priority": 0,
      none: 0,
      urgent: 1,
      high: 2,
      medium: 3,
      low: 4,
    };
    const priority = priorities[String(value).trim().toLowerCase().replaceAll("_", " ")];
    if (priority === undefined) {
      throw new ProjectContextError(
        "LINEAR_PRIORITY_INVALID",
        `Unsupported Linear priority ${value}; use none, urgent, high, medium, low, or 0-4`,
      );
    }

    return priority;
  }

  async #resolvedLabels(session: LinearMcpSession, names: string[]): Promise<string[]> {
    const resolutions = await Promise.all(
      names.map(async (name) => {
        const result = await this.#collectLabels(session, MCP_PAGE_SIZE, name);
        const matches = result.labels.filter((label) => sameName(label.name, name));

        if (result.truncated || matches.length !== 1) {
          throw new ProjectContextError(
            "LINEAR_LABEL_AMBIGUOUS",
            `Linear label ${name} could not be resolved uniquely inside the configured team`,
          );
        }

        return matches[0]?.name as string;
      }),
    );

    return resolutions;
  }

  async #input(
    session: LinearMcpSession,
    input: IssueUpdateInput | IssueCreateInput,
  ): Promise<Record<string, unknown>> {
    if ("issueType" in input && input.issueType !== undefined) {
      throw new ProjectContextError(
        "FIELD_UNSUPPORTED",
        "Linear does not support the generic issueType field",
      );
    }

    return {
      ...(input.title === undefined ? {} : { title: input.title }),
      ...(input.description === undefined ? {} : { description: input.description }),
      ...(input.priority === undefined ? {} : { priority: this.#priority(input.priority) }),
      ...(input.assignee === undefined ? {} : { assignee: input.assignee }),
      ...(input.labels === undefined
        ? {}
        : { labels: await this.#resolvedLabels(session, input.labels) }),
    };
  }

  async #get(session: LinearMcpSession, identifier: string): Promise<LinearMcpIssue> {
    const issue = parseLinearMcpOutput(
      linearMcpIssueSchema,
      await session.call("get_issue", { id: identifier }),
    );
    this.#assertTarget(issue);

    return issue;
  }

  async identity(): Promise<ProviderIdentity> {
    return this.connector.withSession(async (session) => {
      const [userValue, organization] = await Promise.all([
        session.call("get_user", { query: "me" }),
        this.#organization(),
      ]);
      const user = parseLinearMcpOutput(linearMcpIdentitySchema, userValue);

      return {
        provider: this.type,
        principalId: user.id,
        principalName: user.email || user.displayName || user.name,
        scopeId: organization.id,
        scopeName: organization.name,
      };
    });
  }

  async list(options: IssueListOptions = {}): Promise<IssueListResult> {
    return this.connector.withSession(async (session) => {
      const result = await this.#collectIssues(session, options.limit ?? 30, options.matches ?? []);

      return {
        issues: result.issues.map((issue) => this.#targetedSnapshot(issue)),
        truncated: result.truncated,
      };
    });
  }

  async search(query: string, limit = 30): Promise<IssueSnapshot[]> {
    return this.connector.withSession(async (session) => {
      const result = await this.#collectIssues(session, limit, [], query);

      return result.issues.map((issue) => this.#targetedSnapshot(issue));
    });
  }

  listUsers(limit = 30): Promise<UserListResult> {
    return this.#users(undefined, limit);
  }

  searchUsers(query: string, limit = 30): Promise<UserListResult> {
    return this.#users(query, limit);
  }

  async searchOptions(
    field: IssueOptionField,
    query: string,
    limit = 30,
  ): Promise<IssueOptionListResult> {
    if (field === "priority") return filterIssueOptions(linearPriorities, query, limit);
    if (field !== "labels") {
      throw new ProjectContextError(
        "ISSUE_OPTION_FIELD_UNSUPPORTED",
        `Linear does not expose searchable ${field} options`,
      );
    }

    return this.connector.withSession(async (session) => {
      const result = await this.#collectLabels(session, limit, query);

      return {
        options: result.labels.slice(0, limit).map((label) => ({
          value: label.name,
          label: label.name,
        })),
        truncated: result.truncated,
      };
    });
  }

  async capabilities(): Promise<ProviderIssueCapabilities> {
    return this.connector.withSession(async (session) => {
      const result = await this.#collectLabels(session, 100);

      return {
        fields: [
          issueFieldCapability("title", ["create", "update"]),
          issueFieldCapability("description", ["create", "update"]),
          issueFieldCapability("labels", ["create", "update"], {
            options: result.labels.slice(0, 100).map((label) => ({
              value: label.name,
              label: label.name,
            })),
            optionsTruncated: result.truncated,
            discoveryTool: "search_issue_options",
          }),
          issueFieldCapability("assignee", ["create", "update"], {
            clearable: true,
            discoveryTool: "search_users",
          }),
          issueFieldCapability("priority", ["create", "update"], {
            options: linearPriorities,
            defaultValue: 0,
            clearable: true,
            discoveryTool: "search_issue_options",
          }),
          issueFieldCapability("issueType", []),
        ],
      };
    });
  }

  async get(identifier: string): Promise<IssueSnapshot> {
    return this.connector.withSession(async (session) =>
      this.#snapshot(await this.#get(session, identifier)),
    );
  }

  async listComments(identifier: string, limit = 30): Promise<IssueCommentListResult> {
    return this.connector.withSession(async (session) => {
      await this.#get(session, identifier);
      const value = await session.call("list_comments", {
        issueId: identifier,
        limit: Math.min(limit + 1, MCP_PAGE_SIZE),
        orderBy: "updatedAt",
      });
      const page = parseLinearMcpOutput(linearMcpCommentPageSchema, value);
      await this.#get(session, identifier);
      const comments: IssueComment[] = page.comments
        .toSorted((left, right) => right.createdAt.localeCompare(left.createdAt))
        .slice(0, limit)
        .map((comment) => ({
          provider: this.type,
          id: comment.id,
          body: comment.body,
          author: comment.author
            ? {
                provider: this.type,
                id: comment.author.id,
                displayName: comment.author.name,
                username: null,
                email: null,
              }
            : null,
          createdAt: comment.createdAt,
          updatedAt: comment.updatedAt,
          url: null,
        }));

      return {
        comments,
        truncated: page.hasNextPage || page.comments.length > limit,
      };
    });
  }

  async create(input: IssueCreateInput): Promise<IssueSnapshot> {
    return this.connector.withSession(async (session) => {
      const fields = await this.#input(session, input);
      const created = parseLinearMcpOutput(
        linearMcpSavedIssueSchema,
        await session.call("save_issue", {
          ...fields,
          team: this.target.team.id,
          ...(this.#creationProject() ? { project: this.#creationProject() } : {}),
        }),
      );

      return this.#snapshot(await this.#get(session, created.id));
    });
  }

  async update(identifier: string, input: IssueUpdateInput): Promise<IssueSnapshot> {
    return this.connector.withSession(async (session) => {
      await this.#get(session, identifier);
      const fields = await this.#input(session, input);
      await session.call("save_issue", { id: identifier, ...fields });

      return this.#snapshot(await this.#get(session, identifier));
    });
  }

  async comment(identifier: string, body: string): Promise<void> {
    await this.connector.withSession(async (session) => {
      await this.#get(session, identifier);
      await session.call("save_comment", { issueId: identifier, body });
    });
  }

  async transition(identifier: string, nativeStatus: string): Promise<IssueSnapshot> {
    return this.connector.withSession(async (session) => {
      await this.#get(session, identifier);
      const statuses = parseLinearMcpOutput(
        linearMcpStatusesSchema,
        await session.call("list_issue_statuses", { team: this.target.team.id }),
      );
      const matches = statuses.filter((status) => sameName(status.name, nativeStatus));
      if (matches.length !== 1) {
        throw new ProjectContextError(
          "LINEAR_STATE_AMBIGUOUS",
          `Linear state ${nativeStatus} resolved to ${matches.length} workflow states`,
        );
      }

      await session.call("save_issue", { id: identifier, state: matches[0]?.id });

      return this.#snapshot(await this.#get(session, identifier));
    });
  }

  async link(identifier: string, targetUrl: string): Promise<void> {
    await this.comment(identifier, `Related issue: ${targetUrl}`);
  }
}
