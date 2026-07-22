import { ProjectContextError } from "../core/errors.ts";
import type {
  CanonicalStatus,
  GitHubProjectProvider,
  GitHubProviderProfile,
  StatusMatch,
} from "../core/types.ts";
import { issueFieldCapability } from "./capabilities.ts";
import {
  GitHubProjectClient,
  type GitHubProjectIssueItem,
  type GitHubProjectMembership,
} from "./github-project.ts";
import { requestJson, versionOf } from "./http.ts";
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
  IssueUser,
  ProviderIdentity,
  ProviderIssueCapabilities,
  UserListResult,
} from "./types.ts";

function quotedQualifier(name: string, value: string, negative = false): string {
  const escaped = value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');

  return `${negative ? "-" : ""}${name}:"${escaped}"`;
}

function statusQuery(match: NonNullable<IssueListOptions["matches"]>[number]): string {
  const states = match.states ?? (match.state ? [match.state] : []);
  const invalidState = states.find((state) => !["open", "closed"].includes(state.toLowerCase()));
  if (invalidState) {
    throw new ProjectContextError(
      "GITHUB_STATUS_FILTER_INVALID",
      `GitHub status filters support only open or closed, not ${invalidState}`,
    );
  }
  const stateQualifier =
    states.length === 0
      ? []
      : states.length === 1
        ? [`is:${states[0]?.toLowerCase()}`]
        : [`(${states.map((state) => `is:${state.toLowerCase()}`).join(" OR ")})`];
  const qualifiers = [
    ...stateQualifier,
    ...match.labelsAll.map((label) => quotedQualifier("label", label)),
    ...match.labelsNone.map((label) => quotedQualifier("label", label, true)),
  ];

  return qualifiers.join(" AND ");
}

interface GitHubIssue {
  id: number;
  node_id?: string;
  number: number;
  title: string;
  body: string | null;
  state: string;
  state_reason?: string | null;
  html_url: string;
  updated_at: string;
  created_at?: string;
  assignee?: GitHubUser | null;
  user?: GitHubUser | null;
  labels?: Array<string | { name?: string }>;
  pull_request?: unknown;
  comments?: number;
}

interface GitHubUser {
  id: number;
  login: string;
}

interface GitHubLabel {
  id: number;
  name: string;
}

interface GitHubComment {
  id: number;
  body: string;
  user: GitHubUser | null;
  created_at: string;
  updated_at: string;
  html_url: string;
}

type GitHubAssignableUser = GitHubUser;

const githubLabelSearchMaxPages = 10;

function sameName(left: string, right: string): boolean {
  return left.localeCompare(right, undefined, { sensitivity: "accent" }) === 0;
}

function containsName(names: string[], candidate: string): boolean {
  return names.some((name) => sameName(name, candidate));
}

function matchesProjectFilter(item: GitHubProjectIssueItem, match: StatusMatch): boolean {
  const status =
    item.content.stateReason === "NOT_PLANNED" ? "Canceled" : (item.status ?? "No Status");
  const states = match.states ?? (match.state ? [match.state] : undefined);
  const stateMatches = states === undefined || containsName(states, status);
  const labels = item.content.labels.nodes.map((label) => label.name);
  const includesLabels = match.labelsAll.every((label) => containsName(labels, label));
  const excludesLabels = match.labelsNone.every((label) => !containsName(labels, label));

  return stateMatches && includesLabels && excludesLabels;
}

export class GitHubIssuesAdapter implements IssueProviderAdapter {
  readonly type = "github" as const;
  readonly #baseUrl: string;
  readonly #repository: { owner: string; name: string };
  readonly #project: GitHubProjectClient | undefined;

  constructor(
    private readonly profile: GitHubProviderProfile,
    target: GitHubProjectProvider["target"],
    private readonly credential: Record<string, string>,
    private readonly fetcher: typeof fetch = fetch,
    inheritedRepository?: { owner: string; name: string },
  ) {
    this.#baseUrl = "https://api.github.com";
    if (target.repository === "inherit" && !inheritedRepository) {
      throw new Error("GitHub inherit target needs a repository");
    }
    this.#repository =
      target.repository === "inherit"
        ? (inheritedRepository as { owner: string; name: string })
        : target.repository;
    this.#project = target.project
      ? new GitHubProjectClient(target.project, this.credential.token ?? "", this.fetcher)
      : undefined;
  }

  #request<T>(path: string, method = "GET", body?: unknown): Promise<T> {
    return requestJson<T>(
      this.fetcher,
      `${this.#baseUrl}${path}`,
      {
        method,
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${this.credential.token ?? ""}`,
          "X-GitHub-Api-Version": "2022-11-28",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
      {
        provider: "GitHub",
        allowedOrigin: this.#baseUrl,
        access: method === "GET" ? "read" : "write",
      },
    );
  }

  #issuePath(suffix = ""): string {
    return `/repos/${encodeURIComponent(this.#repository.owner)}/${encodeURIComponent(this.#repository.name)}/issues${suffix}`;
  }

  #assigneePath(parameters: URLSearchParams): string {
    return `/repos/${encodeURIComponent(this.#repository.owner)}/${encodeURIComponent(this.#repository.name)}/assignees?${parameters}`;
  }

  #assignableUser(user: GitHubAssignableUser): AssignableUser {
    return {
      provider: this.type,
      assignee: user.login,
      displayName: user.login,
      username: user.login,
      email: null,
      active: true,
    };
  }

  #issueUser(user: GitHubUser): IssueUser {
    return {
      provider: this.type,
      id: String(user.id),
      displayName: user.login,
      username: user.login,
      email: null,
    };
  }

  async #collectLabels(page = 1, collected: GitHubLabel[] = []): Promise<GitHubLabel[]> {
    const parameters = new URLSearchParams({ per_page: "100", page: String(page) });
    const labels = await this.#request<GitHubLabel[]>(
      `/repos/${encodeURIComponent(this.#repository.owner)}/${encodeURIComponent(this.#repository.name)}/labels?${parameters}`,
    );
    const allLabels = [...collected, ...labels];

    return allLabels.length > 100 || labels.length < 100
      ? allLabels
      : this.#collectLabels(page + 1, allLabels);
  }

  async #searchLabels(
    query: string,
    limit: number,
    page = 1,
    collected: GitHubLabel[] = [],
  ): Promise<{ labels: GitHubLabel[]; truncated: boolean }> {
    const parameters = new URLSearchParams({ per_page: "100", page: String(page) });
    const labels = await this.#request<GitHubLabel[]>(
      `/repos/${encodeURIComponent(this.#repository.owner)}/${encodeURIComponent(this.#repository.name)}/labels?${parameters}`,
    );
    const normalizedQuery = query.toLocaleLowerCase();
    const matches = [
      ...collected,
      ...labels.filter((label) => label.name.toLocaleLowerCase().includes(normalizedQuery)),
    ];
    const exhausted = labels.length < 100;
    const pageBoundReached = page >= githubLabelSearchMaxPages;

    if (matches.length > limit || exhausted || pageBoundReached) {
      return {
        labels: matches.slice(0, limit),
        truncated: matches.length > limit || (!exhausted && pageBoundReached),
      };
    }

    return this.#searchLabels(query, limit, page + 1, matches);
  }

  async #collectAssignableUsers(
    query: string | undefined,
    limit: number,
    page = 1,
    collected: GitHubAssignableUser[] = [],
  ): Promise<GitHubAssignableUser[]> {
    const pageSize = query ? 100 : Math.min(limit + 1, 100);
    const parameters = new URLSearchParams({ per_page: String(pageSize), page: String(page) });
    const pageUsers = await this.#request<GitHubAssignableUser[]>(this.#assigneePath(parameters));
    const normalizedQuery = query?.trim().toLocaleLowerCase();
    const matches = normalizedQuery
      ? pageUsers.filter((user) => user.login.toLocaleLowerCase().includes(normalizedQuery))
      : pageUsers;
    const users = [...collected, ...matches];
    const exhausted = pageUsers.length < pageSize;

    if (users.length > limit || exhausted) return users;
    return this.#collectAssignableUsers(query, limit, page + 1, users);
  }

  async #users(query: string | undefined, limit: number): Promise<UserListResult> {
    const users = await this.#collectAssignableUsers(query, limit);

    return {
      users: users.slice(0, limit).map((user) => this.#assignableUser(user)),
      truncated: users.length > limit,
    };
  }

  #snapshot(issue: GitHubIssue, membership?: GitHubProjectMembership): IssueSnapshot {
    const projectStatus =
      issue.state_reason?.toUpperCase() === "NOT_PLANNED"
        ? "Canceled"
        : (membership?.status ?? "No Status");
    const status = this.#project ? projectStatus : issue.state;
    const version = membership
      ? `${versionOf(issue.updated_at, String(issue.id))}:${membership.itemId}:${membership.statusOptionId ?? "none"}`
      : versionOf(issue.updated_at, String(issue.id));

    return {
      provider: this.type,
      id: String(issue.id),
      identifier: `#${issue.number}`,
      title: issue.title,
      description: issue.body,
      status,
      labels: (issue.labels ?? []).flatMap((label) =>
        typeof label === "string" ? [label] : label.name ? [label.name] : [],
      ),
      assignee: issue.assignee ? this.#assignableUser(issue.assignee) : null,
      creator: issue.user ? this.#issueUser(issue.user) : null,
      priority: null,
      issueType: null,
      createdAt: issue.created_at ?? null,
      dueDate: null,
      estimate: null,
      cycle: null,
      milestone: null,
      archivedAt: null,
      relations: null,
      url: issue.html_url,
      updatedAt: issue.updated_at,
      version,
    };
  }

  #projectSnapshot(item: GitHubProjectIssueItem): IssueSnapshot {
    const issue = item.content;

    return this.#snapshot(
      {
        id: issue.databaseId,
        node_id: issue.id,
        number: issue.number,
        title: issue.title,
        body: issue.body,
        state: issue.state.toLowerCase(),
        state_reason: issue.stateReason?.toLowerCase() ?? null,
        html_url: issue.url,
        updated_at: issue.updatedAt,
        created_at: issue.createdAt,
        assignee: issue.assignees.nodes[0]
          ? { id: issue.assignees.nodes[0].databaseId, login: issue.assignees.nodes[0].login }
          : null,
        user: issue.author ? { id: issue.author.databaseId, login: issue.author.login } : null,
        labels: issue.labels.nodes,
      },
      { itemId: item.id, status: item.status, statusOptionId: item.statusOptionId },
    );
  }

  async #scopedIssue(
    identifier: string,
  ): Promise<{ issue: GitHubIssue; membership?: GitHubProjectMembership }> {
    const number = identifier.replace(/^#/, "");
    const issue = await this.#request<GitHubIssue>(this.#issuePath(`/${number}`));
    this.#assertIssue(issue);
    if (!this.#project) return { issue };
    if (!issue.node_id) {
      throw new ProjectContextError(
        "GITHUB_ISSUE_NODE_ID_MISSING",
        "GitHub issue response did not include a GraphQL node identity",
      );
    }
    const membership = await this.#project.membership(issue.node_id);
    if (!membership) {
      throw new ProjectContextError(
        "ISSUE_OUTSIDE_TARGET",
        "GitHub issue is outside the configured Project target",
      );
    }

    return { issue, membership };
  }

  #assertIssue(issue: GitHubIssue): void {
    if (!issue.pull_request) return;

    throw new ProjectContextError(
      "ISSUE_PULL_REQUEST_UNSUPPORTED",
      "GitHub pull requests are outside the configured issue target",
    );
  }

  #comment(comment: GitHubComment): IssueComment {
    return {
      provider: this.type,
      id: String(comment.id),
      body: comment.body,
      author: comment.user ? this.#issueUser(comment.user) : null,
      createdAt: comment.created_at,
      updatedAt: comment.updated_at,
      url: comment.html_url,
    };
  }

  async identity(): Promise<ProviderIdentity> {
    const user = await this.#request<{ id: number; login: string }>("/user");
    return {
      provider: this.type,
      principalId: String(user.id),
      principalName: user.login,
      scopeId: this.profile.expected_identity.host,
      scopeName: this.profile.expected_identity.host,
    };
  }

  async list(options: IssueListOptions = {}): Promise<IssueListResult> {
    if (options.parent || options.includeArchived) {
      throw new ProjectContextError(
        "OPERATION_UNSUPPORTED",
        "GitHub issue listing does not support parent or archived filters",
      );
    }
    const limit = options.limit ?? 30;
    if (this.#project) {
      const result = await this.#project.collectIssueItems(
        `${this.#repository.owner}/${this.#repository.name}`,
      );
      const filtered = result.items.filter(
        (item) =>
          !options.matches?.length ||
          options.matches.some((match) => matchesProjectFilter(item, match)),
      );
      const issues = filtered
        .toSorted((left, right) => right.content.updatedAt.localeCompare(left.content.updatedAt))
        .slice(0, limit)
        .map((item) => this.#projectSnapshot(item));

      return { issues, truncated: result.truncated || filtered.length > issues.length };
    }
    const filters = options.matches?.map(statusQuery).filter(Boolean) ?? [];
    const statusFilter =
      filters.length === 0
        ? ""
        : filters.length === 1
          ? ` ${filters[0]}`
          : ` (${filters.join(" OR ")})`;
    const query = `repo:${this.#repository.owner}/${this.#repository.name} is:issue${statusFilter}`;
    const parameters = new URLSearchParams({
      q: query,
      sort: "updated",
      order: "desc",
      per_page: String(limit),
    });
    const result = await this.#request<{ total_count: number; items: GitHubIssue[] }>(
      `/search/issues?${parameters}`,
    );
    const issues = result.items
      .filter((issue) => !issue.pull_request)
      .slice(0, limit)
      .map((issue) => this.#snapshot(issue));

    return { issues, truncated: result.total_count > issues.length };
  }

  async search(query: string, limit = 30): Promise<IssueSnapshot[]> {
    if (this.#project) {
      const result = await this.#project.collectIssueItems(
        `${this.#repository.owner}/${this.#repository.name}`,
      );
      const normalizedQuery = query.trim().toLocaleLowerCase();

      return result.items
        .filter((item) =>
          [item.content.title, item.content.body ?? ""].some((value) =>
            value.toLocaleLowerCase().includes(normalizedQuery),
          ),
        )
        .toSorted((left, right) => right.content.updatedAt.localeCompare(left.content.updatedAt))
        .slice(0, limit)
        .map((item) => this.#projectSnapshot(item));
    }
    const result = await this.#request<{ items: GitHubIssue[] }>(
      `/search/issues?q=${encodeURIComponent(`${query} repo:${this.#repository.owner}/${this.#repository.name} is:issue`)}&per_page=${limit}`,
    );
    return result.items
      .filter((issue) => !issue.pull_request)
      .map((issue) => this.#snapshot(issue));
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
    if (field !== "labels") {
      throw new ProjectContextError(
        "ISSUE_OPTION_FIELD_UNSUPPORTED",
        `GitHub does not expose searchable ${field} options`,
      );
    }
    const result = await this.#searchLabels(query, limit);

    return {
      options: result.labels.map((label) => ({ value: label.name, label: label.name })),
      truncated: result.truncated,
    };
  }

  async capabilities(): Promise<ProviderIssueCapabilities> {
    const labels = await this.#collectLabels();

    return {
      fields: [
        issueFieldCapability("title", ["create", "update"]),
        issueFieldCapability("description", ["create", "update"]),
        issueFieldCapability("labels", ["create", "update"], {
          options: labels.slice(0, 100).map((label) => ({
            value: label.name,
            label: label.name,
          })),
          optionsTruncated: labels.length > 100,
          discoveryTool: "search_issue_options",
        }),
        issueFieldCapability("assignee", ["create", "update"], {
          clearable: true,
          discoveryTool: "search_users",
        }),
        issueFieldCapability("priority", []),
        issueFieldCapability("issueType", []),
      ],
    };
  }

  async get(identifier: string): Promise<IssueSnapshot> {
    const { issue, membership } = await this.#scopedIssue(identifier);

    return this.#snapshot(issue, membership);
  }

  async listComments(identifier: string, limit = 30): Promise<IssueCommentListResult> {
    const number = identifier.replace(/^#/, "");
    const { issue } = await this.#scopedIssue(identifier);

    const total = issue.comments ?? 0;
    if (total === 0) return { comments: [], truncated: false };

    const pageSize = 100;
    const lastPage = Math.max(1, Math.ceil(total / pageSize));
    const lastParameters = new URLSearchParams({
      per_page: String(pageSize),
      page: String(lastPage),
    });
    const lastComments = await this.#request<GitHubComment[]>(
      this.#issuePath(`/${number}/comments?${lastParameters}`),
    );
    const needsPreviousPage = lastPage > 1 && lastComments.length < limit;
    const previousComments = needsPreviousPage
      ? await this.#request<GitHubComment[]>(
          this.#issuePath(
            `/${number}/comments?${new URLSearchParams({
              per_page: String(pageSize),
              page: String(lastPage - 1),
            })}`,
          ),
        )
      : [];
    await this.#scopedIssue(identifier);

    const comments = [...previousComments, ...lastComments]
      .slice(-limit)
      .toSorted((left, right) => right.created_at.localeCompare(left.created_at))
      .map((comment) => this.#comment(comment));

    return { comments, truncated: total > comments.length };
  }

  async create(input: IssueCreateInput): Promise<IssueSnapshot> {
    this.#assertSupportedFields(input);
    const issue = await this.#request<GitHubIssue>(this.#issuePath(), "POST", {
      title: input.title,
      ...(input.description === undefined ? {} : { body: input.description }),
      ...(input.labels === undefined ? {} : { labels: input.labels }),
      ...(input.assignee === undefined ? {} : { assignees: [input.assignee] }),
    });
    if (!this.#project) return this.#snapshot(issue);
    if (!issue.node_id) {
      throw new ProjectContextError(
        "GITHUB_ISSUE_NODE_ID_MISSING",
        "GitHub issue response did not include a GraphQL node identity",
      );
    }
    const membership = await this.#project.add(issue.node_id);

    return this.#snapshot(issue, membership);
  }

  async update(identifier: string, input: IssueUpdateInput): Promise<IssueSnapshot> {
    this.#assertSupportedFields(input);
    const number = identifier.replace(/^#/, "");
    const membership = this.#project ? (await this.#scopedIssue(identifier)).membership : undefined;
    const issue = await this.#request<GitHubIssue>(this.#issuePath(`/${number}`), "PATCH", {
      ...(input.title === undefined ? {} : { title: input.title }),
      ...(input.description === undefined ? {} : { body: input.description }),
      ...(input.labels === undefined ? {} : { labels: input.labels }),
      ...(input.assignee === undefined
        ? {}
        : { assignees: input.assignee ? [input.assignee] : [] }),
    });
    return this.#snapshot(issue, membership);
  }

  async comment(identifier: string, body: string): Promise<void> {
    const number = identifier.replace(/^#/, "");
    if (this.#project) await this.#scopedIssue(identifier);
    await this.#request(this.#issuePath(`/${number}/comments`), "POST", { body });
  }

  async transition(
    identifier: string,
    nativeStatus: string,
    canonicalStatus?: CanonicalStatus,
  ): Promise<IssueSnapshot> {
    const number = identifier.replace(/^#/, "");
    if (!this.#project) {
      return this.#snapshot(
        await this.#request<GitHubIssue>(this.#issuePath(`/${number}`), "PATCH", {
          state: nativeStatus,
        }),
      );
    }
    if (!canonicalStatus) {
      throw new ProjectContextError(
        "STATUS_INVALID",
        "GitHub Project transitions require a canonical status",
      );
    }
    const { membership } = await this.#scopedIssue(identifier);
    if (!membership) {
      throw new ProjectContextError(
        "ISSUE_OUTSIDE_TARGET",
        "GitHub issue is outside the configured Project target",
      );
    }
    const optionId = await this.#project.updateStatus(membership.itemId, nativeStatus);
    const lifecycle =
      canonicalStatus === "done"
        ? { state: "closed", state_reason: "completed" }
        : canonicalStatus === "canceled"
          ? { state: "closed", state_reason: "not_planned" }
          : { state: "open" };
    const issue = await this.#request<GitHubIssue>(
      this.#issuePath(`/${number}`),
      "PATCH",
      lifecycle,
    );

    return this.#snapshot(issue, {
      itemId: membership.itemId,
      status: nativeStatus,
      statusOptionId: optionId,
    });
  }

  async link(identifier: string, targetUrl: string): Promise<void> {
    await this.comment(identifier, `Related issue: ${targetUrl}`);
  }

  #assertSupportedFields(input: IssueCreateInput | IssueUpdateInput): void {
    if (input.priority !== undefined) {
      throw new ProjectContextError(
        "FIELD_UNSUPPORTED",
        "GitHub Issues has no native priority field",
      );
    }
    if ("issueType" in input && input.issueType !== undefined) {
      throw new ProjectContextError(
        "FIELD_UNSUPPORTED",
        "GitHub Issues does not support the generic issueType field",
      );
    }
    const unsupported = [
      "dueDate",
      "estimate",
      "cycle",
      "milestone",
      "parent",
      "blocks",
      "blockedBy",
      "relatedTo",
      "duplicateOf",
      "removeBlocks",
      "removeBlockedBy",
      "removeRelatedTo",
    ].find((field) => Object.hasOwn(input, field));
    if (unsupported) {
      throw new ProjectContextError(
        "FIELD_UNSUPPORTED",
        `GitHub Issues does not support the generic ${unsupported} field`,
      );
    }
  }
}
