import { ProjectContextError } from "../core/errors.ts";
import type { JiraProjectProvider, JiraProviderProfile } from "../core/types.ts";
import { filterIssueOptions, issueFieldCapability } from "./capabilities.ts";
import { requestJson, versionOf } from "./http.ts";
import type {
  AssignableUser,
  IssueComment,
  IssueCommentListResult,
  IssueCreateInput,
  IssueListOptions,
  IssueListResult,
  IssueOption,
  IssueOptionField,
  IssueOptionListResult,
  IssueProviderAdapter,
  IssueSnapshot,
  IssueUpdateInput,
  IssueUser,
  ProviderIdentity,
  ProviderIssueCapabilities,
  UserListResult,
} from "./types.ts";

function jqlValue(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function jiraStatusFilter(match: NonNullable<IssueListOptions["matches"]>[number]): string {
  const states = match.states ?? (match.state ? [match.state] : []);
  const stateClause =
    states.length === 0
      ? []
      : states.length === 1
        ? [`status = ${jqlValue(states[0] as string)}`]
        : [`status in (${states.map(jqlValue).join(", ")})`];
  const clauses = [
    ...stateClause,
    ...match.labelsAll.map((label) => `labels = ${jqlValue(label)}`),
    ...match.labelsNone.map((label) => `(labels != ${jqlValue(label)} OR labels is EMPTY)`),
  ];

  return clauses.length > 1 ? `(${clauses.join(" AND ")})` : (clauses[0] ?? "");
}

const jiraIssueFields = [
  "summary",
  "description",
  "status",
  "project",
  "updated",
  "labels",
  "assignee",
  "creator",
  "priority",
  "issuetype",
  "created",
  "duedate",
];

interface JiraUser {
  accountId: string;
  displayName: string;
  emailAddress?: string;
}

interface JiraIssue {
  id: string;
  key: string;
  self: string;
  fields: {
    summary: string;
    description?: unknown;
    status: { name: string };
    project?: { id: string };
    updated: string;
    created?: string;
    duedate?: string | null;
    assignee?: JiraAssignableUser | null;
    creator?: JiraUser | null;
    priority?: { id: string; name: string } | null;
    issuetype?: { id: string; name: string } | null;
    labels?: string[];
  };
}

interface JiraAssignableUser extends JiraUser {
  active: boolean;
}

interface JiraIssueType {
  id: string;
  name: string;
  subtask: boolean;
}

interface JiraPriority {
  id: string;
  name: string;
}

interface JiraComment {
  id: string;
  body: unknown;
  author?: JiraUser | null;
  created: string;
  updated: string;
}

const jiraOptionSearchMaxPages = 10;

function adf(text: string) {
  return {
    type: "doc",
    version: 1,
    content: text
      .split("\n")
      .map((line) => ({ type: "paragraph", content: line ? [{ type: "text", text: line }] : [] })),
  };
}

function adfText(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const parts: string[] = [];
  const visit = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    const record = node as { text?: unknown; content?: unknown[]; type?: unknown };
    if (typeof record.text === "string") parts.push(record.text);
    for (const child of record.content ?? []) visit(child);
    if (record.type === "paragraph") parts.push("\n");
  };
  visit(value);
  return parts.join("").trimEnd();
}

export class JiraCloudIssuesAdapter implements IssueProviderAdapter {
  readonly type = "jira-cloud" as const;
  readonly #baseUrl: string;

  constructor(
    private readonly profile: JiraProviderProfile,
    private readonly target: JiraProjectProvider["target"],
    private readonly credential: Record<string, string>,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    const origin = new URL(`https://${profile.expected_identity.site}`);
    if (!origin.hostname.endsWith(".atlassian.net") || origin.hostname === "atlassian.net") {
      throw new ProjectContextError(
        "JIRA_ORIGIN_UNSAFE",
        "Jira Cloud site must be a tenant under atlassian.net",
      );
    }
    this.#baseUrl = origin.origin;
  }

  #request<T>(
    path: string,
    method = "GET",
    body?: unknown,
    access: "read" | "write" = method === "GET" ? "read" : "write",
  ): Promise<T> {
    const basic = btoa(`${this.credential.email ?? ""}:${this.credential.token ?? ""}`);
    return requestJson<T>(
      this.fetcher,
      `${this.#baseUrl}${path}`,
      {
        method,
        headers: {
          Accept: "application/json",
          Authorization: `Basic ${basic}`,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
      { provider: "Jira Cloud", allowedOrigin: this.#baseUrl, access },
    );
  }

  #snapshot(issue: JiraIssue): IssueSnapshot {
    return {
      provider: this.type,
      id: issue.id,
      identifier: issue.key,
      title: issue.fields.summary,
      description: adfText(issue.fields.description),
      status: issue.fields.status.name,
      labels: issue.fields.labels ?? [],
      assignee: issue.fields.assignee ? this.#assignableUser(issue.fields.assignee) : null,
      creator: issue.fields.creator ? this.#issueUser(issue.fields.creator) : null,
      priority: issue.fields.priority
        ? { value: issue.fields.priority.name, label: issue.fields.priority.name }
        : null,
      issueType: issue.fields.issuetype
        ? { value: issue.fields.issuetype.name, label: issue.fields.issuetype.name }
        : null,
      createdAt: issue.fields.created ?? null,
      dueDate: issue.fields.duedate ?? null,
      url: `${this.#baseUrl}/browse/${issue.key}`,
      updatedAt: issue.fields.updated,
      version: versionOf(issue.fields.updated, issue.id),
    };
  }

  #assignableUser(user: JiraAssignableUser): AssignableUser {
    return {
      provider: this.type,
      assignee: user.accountId,
      displayName: user.displayName,
      username: null,
      email: user.emailAddress ?? null,
      active: user.active,
    };
  }

  #issueUser(user: JiraUser): IssueUser {
    return {
      provider: this.type,
      id: user.accountId,
      displayName: user.displayName,
      username: null,
      email: user.emailAddress ?? null,
    };
  }

  async #issueTypes(startAt = 0): Promise<{ issueTypes: JiraIssueType[]; truncated: boolean }> {
    const parameters = new URLSearchParams({ maxResults: "100", startAt: String(startAt) });
    const page = await this.#request<{
      issueTypes: JiraIssueType[];
      total: number;
    }>(
      `/rest/api/3/issue/createmeta/${encodeURIComponent(this.target.project.id)}/issuetypes?${parameters}`,
    );

    return {
      issueTypes: page.issueTypes,
      truncated: startAt + page.issueTypes.length < page.total,
    };
  }

  async #priorities(startAt = 0): Promise<{ priorities: JiraPriority[]; truncated: boolean }> {
    const parameters = new URLSearchParams({
      projectId: this.target.project.id,
      maxResults: "100",
      startAt: String(startAt),
    });
    const page = await this.#request<{
      values: JiraPriority[];
      isLast?: boolean;
    }>(`/rest/api/3/priority/search?${parameters}`);

    return {
      priorities: page.values,
      truncated: page.isLast === false,
    };
  }

  async #searchIssueTypes(
    query: string,
    limit: number,
    startAt = 0,
    pageNumber = 1,
    collected: IssueOption[] = [],
  ): Promise<IssueOptionListResult> {
    const page = await this.#issueTypes(startAt);
    const options = [
      ...collected,
      ...page.issueTypes
        .filter((issueType) => !issueType.subtask)
        .map((issueType) => ({ value: issueType.name, label: issueType.name })),
    ];
    const filtered = filterIssueOptions(options, query, limit);
    const pageBoundReached = pageNumber >= jiraOptionSearchMaxPages;
    const noProgress = page.issueTypes.length === 0;

    if (filtered.truncated || !page.truncated || pageBoundReached || noProgress) {
      return {
        options: filtered.options,
        truncated: filtered.truncated || (page.truncated && (pageBoundReached || noProgress)),
      };
    }

    return this.#searchIssueTypes(
      query,
      limit,
      startAt + page.issueTypes.length,
      pageNumber + 1,
      options,
    );
  }

  async #searchPriorities(
    query: string,
    limit: number,
    startAt = 0,
    pageNumber = 1,
    collected: IssueOption[] = [],
  ): Promise<IssueOptionListResult> {
    const page = await this.#priorities(startAt);
    const options = [
      ...collected,
      ...page.priorities.map((priority) => ({ value: priority.name, label: priority.name })),
    ];
    const filtered = filterIssueOptions(options, query, limit);
    const pageBoundReached = pageNumber >= jiraOptionSearchMaxPages;
    const noProgress = page.priorities.length === 0;

    if (filtered.truncated || !page.truncated || pageBoundReached || noProgress) {
      return {
        options: filtered.options,
        truncated: filtered.truncated || (page.truncated && (pageBoundReached || noProgress)),
      };
    }

    return this.#searchPriorities(
      query,
      limit,
      startAt + page.priorities.length,
      pageNumber + 1,
      options,
    );
  }

  async #collectAssignableUsers(
    query: string | undefined,
    limit: number,
    startAt = 0,
    collected: JiraAssignableUser[] = [],
  ): Promise<JiraAssignableUser[]> {
    const pageSize = Math.min(limit + 1, 100);
    const parameters = new URLSearchParams({
      project: this.target.project.id,
      ...(query ? { query } : {}),
      maxResults: String(pageSize),
      startAt: String(startAt),
    });
    const page = await this.#request<JiraAssignableUser[]>(
      `/rest/api/3/user/assignable/search?${parameters}`,
    );
    const users = [...collected, ...page.filter((user) => user.active)];

    if (users.length > limit || page.length < pageSize) return users;
    return this.#collectAssignableUsers(query, limit, startAt + page.length, users);
  }

  async #users(query: string | undefined, limit: number): Promise<UserListResult> {
    const users = await this.#collectAssignableUsers(query, limit);

    return {
      users: users.slice(0, limit).map((user) => this.#assignableUser(user)),
      truncated: users.length > limit,
    };
  }

  #assertTarget(issue: JiraIssue): void {
    if (issue.fields.project?.id === this.target.project.id) return;

    throw new ProjectContextError(
      "ISSUE_OUTSIDE_TARGET",
      "Jira issue is outside the configured project target",
    );
  }

  #targetedSnapshot(issue: JiraIssue): IssueSnapshot {
    this.#assertTarget(issue);
    return this.#snapshot(issue);
  }

  async identity(): Promise<ProviderIdentity> {
    const user = await this.#request<{
      accountId: string;
      displayName: string;
      emailAddress?: string;
    }>("/rest/api/3/myself");
    return {
      provider: this.type,
      principalId: user.accountId,
      principalName: user.emailAddress ?? user.displayName,
      scopeId: this.profile.expected_identity.site,
      scopeName: this.profile.expected_identity.site,
    };
  }

  async list(options: IssueListOptions = {}): Promise<IssueListResult> {
    const limit = options.limit ?? 30;
    const matches = options.matches?.map(jiraStatusFilter).filter(Boolean) ?? [];
    const statusFilter =
      matches.length === 0
        ? ""
        : matches.length === 1
          ? ` AND ${matches[0]}`
          : ` AND (${matches.join(" OR ")})`;
    const jql = `project = ${jqlValue(this.target.project.id)}${statusFilter} ORDER BY updated DESC`;
    const data = await this.#request<{
      issues: JiraIssue[];
      isLast?: boolean;
      nextPageToken?: string;
    }>(
      "/rest/api/3/search/jql",
      "POST",
      {
        jql,
        maxResults: limit,
        fields: jiraIssueFields,
      },
      "read",
    );
    const issues = data.issues.map((issue) => this.#targetedSnapshot(issue));

    return {
      issues,
      truncated: data.isLast === false || data.nextPageToken !== undefined,
    };
  }

  async search(query: string, limit = 30): Promise<IssueSnapshot[]> {
    const jql = `project = "${this.target.project.id.replaceAll('"', '\\"')}" AND text ~ "${query.replaceAll('"', '\\"')}" ORDER BY updated DESC`;
    const data = await this.#request<{ issues: JiraIssue[] }>(
      "/rest/api/3/search/jql",
      "POST",
      {
        jql,
        maxResults: limit,
        fields: jiraIssueFields,
      },
      "read",
    );
    return data.issues.map((issue) => this.#targetedSnapshot(issue));
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
    if (field === "priority") return this.#searchPriorities(query, limit);
    if (field === "issueType") return this.#searchIssueTypes(query, limit);

    throw new ProjectContextError(
      "ISSUE_OPTION_FIELD_UNSUPPORTED",
      "Jira labels accept custom values but its label catalog is not project-scoped",
    );
  }

  async capabilities(): Promise<ProviderIssueCapabilities> {
    const [issueTypeResult, priorityResult] = await Promise.all([
      this.#issueTypes(),
      this.#priorities(),
    ]);

    return {
      fields: [
        issueFieldCapability("title", ["create", "update"]),
        issueFieldCapability("description", ["create", "update"]),
        issueFieldCapability("labels", ["create", "update"], {
          acceptsCustomValues: true,
        }),
        issueFieldCapability("assignee", ["create", "update"], {
          clearable: true,
          discoveryTool: "search_users",
        }),
        issueFieldCapability("priority", ["create", "update"], {
          options: priorityResult.priorities.map((priority) => ({
            value: priority.name,
            label: priority.name,
          })),
          optionsTruncated: priorityResult.truncated,
          discoveryTool: "search_issue_options",
        }),
        issueFieldCapability("issueType", ["create"], {
          defaultValue: "Task",
          options: issueTypeResult.issueTypes
            .filter((issueType) => !issueType.subtask)
            .map((issueType) => ({ value: issueType.name, label: issueType.name })),
          optionsTruncated: issueTypeResult.truncated,
          discoveryTool: "search_issue_options",
        }),
      ],
    };
  }

  async get(identifier: string): Promise<IssueSnapshot> {
    return this.#targetedSnapshot(
      await this.#request<JiraIssue>(
        `/rest/api/3/issue/${encodeURIComponent(identifier)}?fields=${jiraIssueFields.join(",")}`,
      ),
    );
  }

  async listComments(identifier: string, limit = 30): Promise<IssueCommentListResult> {
    await this.get(identifier);
    const commentPath = `/rest/api/3/issue/${encodeURIComponent(identifier)}/comment`;
    const firstParameters = new URLSearchParams({ startAt: "0", maxResults: String(limit) });
    const firstPage = await this.#request<{
      comments: JiraComment[];
      total: number;
    }>(`${commentPath}?${firstParameters}`);
    const latestStart = Math.max(0, firstPage.total - limit);
    const page =
      latestStart === 0
        ? firstPage
        : await this.#request<{ comments: JiraComment[]; total: number }>(
            `${commentPath}?${new URLSearchParams({
              startAt: String(latestStart),
              maxResults: String(limit),
            })}`,
          );
    await this.get(identifier);

    const comments = page.comments
      .toSorted((left, right) => right.created.localeCompare(left.created))
      .slice(0, limit)
      .map(
        (comment): IssueComment => ({
          provider: this.type,
          id: comment.id,
          body: adfText(comment.body) ?? "",
          author: comment.author ? this.#issueUser(comment.author) : null,
          createdAt: comment.created,
          updatedAt: comment.updated,
          url: null,
        }),
      );

    return { comments, truncated: page.total > comments.length };
  }

  async create(input: IssueCreateInput): Promise<IssueSnapshot> {
    const result = await this.#request<{ id: string; key: string }>("/rest/api/3/issue", "POST", {
      fields: {
        project: { id: this.target.project.id },
        summary: input.title,
        issuetype: { name: input.issueType ?? "Task" },
        ...(input.description === undefined ? {} : { description: adf(input.description) }),
        ...(input.labels === undefined ? {} : { labels: input.labels }),
        ...(input.assignee === undefined ? {} : { assignee: { accountId: input.assignee } }),
        ...(input.priority === undefined ? {} : { priority: { name: String(input.priority) } }),
      },
    });
    return this.get(result.key);
  }

  async update(identifier: string, input: IssueUpdateInput): Promise<IssueSnapshot> {
    await this.#request(`/rest/api/3/issue/${encodeURIComponent(identifier)}`, "PUT", {
      fields: {
        ...(input.title === undefined ? {} : { summary: input.title }),
        ...(input.description === undefined ? {} : { description: adf(input.description) }),
        ...(input.labels === undefined ? {} : { labels: input.labels }),
        ...(input.assignee === undefined
          ? {}
          : { assignee: input.assignee === null ? null : { accountId: input.assignee } }),
        ...(input.priority === undefined ? {} : { priority: { name: String(input.priority) } }),
      },
    });
    return this.get(identifier);
  }

  async comment(identifier: string, body: string): Promise<void> {
    await this.#request(`/rest/api/3/issue/${encodeURIComponent(identifier)}/comment`, "POST", {
      body: adf(body),
    });
  }

  async transition(identifier: string, nativeStatus: string): Promise<IssueSnapshot> {
    const available = await this.#request<{
      transitions: Array<{ id: string; name: string; to: { name: string } }>;
    }>(`/rest/api/3/issue/${encodeURIComponent(identifier)}/transitions`);
    const matches = available.transitions.filter((transition) =>
      [transition.name, transition.to.name].some(
        (name) => name.localeCompare(nativeStatus, undefined, { sensitivity: "accent" }) === 0,
      ),
    );
    if (matches.length !== 1) {
      throw new ProjectContextError(
        "JIRA_TRANSITION_AMBIGUOUS",
        `Jira status ${nativeStatus} resolved to ${matches.length} transitions`,
      );
    }
    await this.#request(`/rest/api/3/issue/${encodeURIComponent(identifier)}/transitions`, "POST", {
      transition: { id: matches[0]?.id },
    });
    return this.get(identifier);
  }

  async link(identifier: string, targetUrl: string): Promise<void> {
    const target = new URL(targetUrl);
    const key = /^\/browse\/([^/]+)$/.exec(target.pathname)?.[1];
    if (target.hostname === new URL(this.#baseUrl).hostname && key) {
      await this.#request("/rest/api/3/issueLink", "POST", {
        type: { name: "Relates" },
        inwardIssue: { key: identifier },
        outwardIssue: { key },
      });
      return;
    }
    await this.comment(identifier, `Related issue: ${targetUrl}`);
  }
}
