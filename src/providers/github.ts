import { ProjectContextError } from "../core/errors.ts";
import type { GitHubProjectProvider, GitHubProviderProfile } from "../core/types.ts";
import { issueFieldCapability } from "./capabilities.ts";
import { requestJson, versionOf } from "./http.ts";
import type {
  AssignableUser,
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
  if (match.state && !["open", "closed"].includes(match.state.toLowerCase())) {
    throw new ProjectContextError(
      "GITHUB_STATUS_FILTER_INVALID",
      `GitHub status filters support only open or closed, not ${match.state}`,
    );
  }
  const qualifiers = [
    ...(match.state ? [`is:${match.state.toLowerCase()}`] : []),
    ...match.labelsAll.map((label) => quotedQualifier("label", label)),
    ...match.labelsNone.map((label) => quotedQualifier("label", label, true)),
  ];

  return qualifiers.join(" AND ");
}

interface GitHubIssue {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: string;
  html_url: string;
  updated_at: string;
  created_at?: string;
  assignee?: GitHubUser | null;
  user?: GitHubUser | null;
  labels?: Array<string | { name?: string }>;
  pull_request?: unknown;
}

interface GitHubUser {
  id: number;
  login: string;
}

interface GitHubLabel {
  id: number;
  name: string;
}

type GitHubAssignableUser = GitHubUser;

const githubLabelSearchMaxPages = 10;

export class GitHubIssuesAdapter implements IssueProviderAdapter {
  readonly type = "github" as const;
  readonly #baseUrl: string;
  readonly #repository: { owner: string; name: string };

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

  #snapshot(issue: GitHubIssue): IssueSnapshot {
    return {
      provider: this.type,
      id: String(issue.id),
      identifier: `#${issue.number}`,
      title: issue.title,
      description: issue.body,
      status: issue.state,
      labels: (issue.labels ?? []).flatMap((label) =>
        typeof label === "string" ? [label] : label.name ? [label.name] : [],
      ),
      assignee: issue.assignee ? this.#assignableUser(issue.assignee) : null,
      creator: issue.user ? this.#issueUser(issue.user) : null,
      priority: null,
      issueType: null,
      createdAt: issue.created_at ?? null,
      dueDate: null,
      url: issue.html_url,
      updatedAt: issue.updated_at,
      version: versionOf(issue.updated_at, String(issue.id)),
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
    const limit = options.limit ?? 30;
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
    const number = identifier.replace(/^#/, "");
    return this.#snapshot(await this.#request<GitHubIssue>(this.#issuePath(`/${number}`)));
  }

  async create(input: IssueCreateInput): Promise<IssueSnapshot> {
    this.#assertSupportedFields(input);
    const issue = await this.#request<GitHubIssue>(this.#issuePath(), "POST", {
      title: input.title,
      ...(input.description === undefined ? {} : { body: input.description }),
      ...(input.labels === undefined ? {} : { labels: input.labels }),
      ...(input.assignee === undefined ? {} : { assignees: [input.assignee] }),
    });
    return this.#snapshot(issue);
  }

  async update(identifier: string, input: IssueUpdateInput): Promise<IssueSnapshot> {
    this.#assertSupportedFields(input);
    const number = identifier.replace(/^#/, "");
    const issue = await this.#request<GitHubIssue>(this.#issuePath(`/${number}`), "PATCH", {
      ...(input.title === undefined ? {} : { title: input.title }),
      ...(input.description === undefined ? {} : { body: input.description }),
      ...(input.labels === undefined ? {} : { labels: input.labels }),
      ...(input.assignee === undefined
        ? {}
        : { assignees: input.assignee ? [input.assignee] : [] }),
    });
    return this.#snapshot(issue);
  }

  async comment(identifier: string, body: string): Promise<void> {
    const number = identifier.replace(/^#/, "");
    await this.#request(this.#issuePath(`/${number}/comments`), "POST", { body });
  }

  async transition(identifier: string, nativeStatus: string): Promise<IssueSnapshot> {
    const number = identifier.replace(/^#/, "");
    return this.#snapshot(
      await this.#request<GitHubIssue>(this.#issuePath(`/${number}`), "PATCH", {
        state: nativeStatus,
      }),
    );
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
  }
}
