import { ProjectContextError } from "../core/errors.ts";
import type {
  CanonicalStatus,
  GitHubProjectProvider,
  GitHubProviderProfile,
  StatusMatch,
} from "../core/types.ts";
import { filterIssueOptions, issueFieldCapability } from "./capabilities.ts";
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
  IssueCommentWriteOptions,
  IssueCreateInput,
  IssueGetOptions,
  IssueListOptions,
  IssueListResult,
  IssueOptionField,
  IssueOptionListResult,
  IssueProviderAdapter,
  IssueReference,
  IssueRelations,
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
  repository_url?: string;
  html_url: string;
  updated_at: string;
  created_at?: string;
  assignee?: GitHubUser | null;
  user?: GitHubUser | null;
  labels?: Array<string | { name?: string }>;
  pull_request?: unknown;
  comments?: number;
  type?: string | GitHubIssueType | null;
  milestone?: GitHubMilestone | null;
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
  issue_url?: string;
}

interface GitHubIssueType {
  id: number;
  name: string;
}

interface GitHubMilestone {
  id: number;
  number: number;
  title: string;
  state?: string;
}

interface GitHubGraphqlIssueReference {
  id: string;
  databaseId: number;
  number: number;
  title: string;
  url: string;
  repository: { nameWithOwner: string };
}

interface ResolvedGitHubInput {
  issueType: string | null | undefined;
  milestone: number | null | undefined;
  parent: GitHubIssue | null | undefined;
  blocks: GitHubIssue[];
  blockedBy: GitHubIssue[];
  duplicateOf: GitHubIssue | null | undefined;
  removeBlocks: GitHubIssue[];
  removeBlockedBy: GitHubIssue[];
}

type GitHubAssignableUser = GitHubUser;

const githubLabelSearchMaxPages = 10;
const githubRelationPageSize = 100;
const githubRelationMaxPages = 10;
const githubApiVersion = "2026-03-10";

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
          "X-GitHub-Api-Version": githubApiVersion,
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

  #requestOptional<T>(path: string): Promise<T | undefined> {
    return requestJson<T | undefined>(
      this.fetcher,
      `${this.#baseUrl}${path}`,
      {
        method: "GET",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${this.credential.token ?? ""}`,
          "X-GitHub-Api-Version": githubApiVersion,
        },
      },
      {
        provider: "GitHub",
        allowedOrigin: this.#baseUrl,
        access: "read",
        notFound: "return-undefined",
      },
    );
  }

  async #graphql<T>(
    query: string,
    variables: Record<string, unknown>,
    access: "read" | "write",
  ): Promise<T> {
    const result = await requestJson<{ data?: T; errors?: Array<{ message: string }> }>(
      this.fetcher,
      `${this.#baseUrl}/graphql`,
      {
        method: "POST",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${this.credential.token ?? ""}`,
          "Content-Type": "application/json",
          "X-GitHub-Api-Version": githubApiVersion,
        },
        body: JSON.stringify({ query, variables }),
      },
      { provider: "GitHub", allowedOrigin: this.#baseUrl, access },
    );
    if (result.errors?.length || !result.data) {
      throw new ProjectContextError(
        "GITHUB_GRAPHQL_ERROR",
        "GitHub GraphQL request failed; provider response details were redacted",
      );
    }

    return result.data;
  }

  #repositoryPath(suffix = ""): string {
    return `/repos/${encodeURIComponent(this.#repository.owner)}/${encodeURIComponent(this.#repository.name)}${suffix}`;
  }

  #issuePath(suffix = ""): string {
    return this.#repositoryPath(`/issues${suffix}`);
  }

  #commentPath(commentId: string): string {
    return this.#issuePath(`/comments/${encodeURIComponent(commentId)}`);
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

  async #issueTypes(): Promise<{ supported: boolean; options: GitHubIssueType[] }> {
    const issueTypes = await this.#requestOptional<GitHubIssueType[]>(
      this.#repositoryPath("/issue-types"),
    );

    return issueTypes === undefined
      ? { supported: false, options: [] }
      : { supported: true, options: issueTypes };
  }

  async #collectMilestones(
    page = 1,
    collected: GitHubMilestone[] = [],
  ): Promise<{ milestones: GitHubMilestone[]; truncated: boolean }> {
    const parameters = new URLSearchParams({
      state: "all",
      per_page: String(githubRelationPageSize),
      page: String(page),
    });
    const milestones = await this.#request<GitHubMilestone[]>(
      this.#repositoryPath(`/milestones?${parameters}`),
    );
    const allMilestones = [...collected, ...milestones];
    const hasNextPage = milestones.length === githubRelationPageSize;
    const pageBoundReached = page >= githubRelationMaxPages;

    if (!hasNextPage || pageBoundReached) {
      return { milestones: allMilestones, truncated: hasNextPage && pageBoundReached };
    }

    return this.#collectMilestones(page + 1, allMilestones);
  }

  async #resolvedIssueType(value: string | null | undefined): Promise<string | null | undefined> {
    if (value === undefined || value === null) return value;

    const issueTypes = await this.#issueTypes();
    const matches = issueTypes.options.filter((issueType) => sameName(issueType.name, value));
    if (!issueTypes.supported || matches.length !== 1) {
      throw new ProjectContextError(
        "GITHUB_ISSUE_TYPE_AMBIGUOUS",
        `GitHub issue type ${value} resolved to ${matches.length} repository options`,
      );
    }

    return matches[0]?.name;
  }

  async #resolvedMilestone(value: string | null | undefined): Promise<number | null | undefined> {
    if (value === undefined || value === null) return value;

    const result = await this.#collectMilestones();
    const matches = result.milestones.filter(
      (milestone) => String(milestone.number) === value || sameName(milestone.title, value),
    );
    if (matches.length !== 1) {
      throw new ProjectContextError(
        "GITHUB_MILESTONE_AMBIGUOUS",
        `GitHub milestone ${value} resolved to ${matches.length} repository milestones`,
      );
    }

    return matches[0]?.number;
  }

  #snapshot(
    issue: GitHubIssue,
    membership?: GitHubProjectMembership,
    relations: IssueRelations | null = null,
  ): IssueSnapshot {
    const projectStatus =
      issue.state_reason?.toUpperCase() === "NOT_PLANNED"
        ? "Canceled"
        : (membership?.status ?? "No Status");
    const status = this.#project ? projectStatus : issue.state;
    const version = membership
      ? `${versionOf(issue.updated_at, String(issue.id))}:${membership.itemId}:${membership.statusOptionId ?? "none"}`
      : versionOf(issue.updated_at, String(issue.id));
    const issueTypeName =
      typeof issue.type === "string" ? issue.type : (issue.type?.name ?? undefined);

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
      issueType: issueTypeName ? { value: issueTypeName, label: issueTypeName } : null,
      createdAt: issue.created_at ?? null,
      dueDate: null,
      estimate: null,
      cycle: null,
      milestone: issue.milestone
        ? { value: String(issue.milestone.number), label: issue.milestone.title }
        : null,
      archivedAt: null,
      relations,
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
        type: issue.issueType?.name ?? null,
        milestone: issue.milestone ? { id: issue.milestone.number, ...issue.milestone } : null,
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

  #reference(issue: GitHubIssue): IssueReference {
    return {
      id: String(issue.id),
      identifier: `#${issue.number}`,
      title: issue.title,
      url: issue.html_url,
    };
  }

  async #scopedRelation(
    issue: GitHubIssue,
  ): Promise<{ issue: GitHubIssue; membership?: GitHubProjectMembership }> {
    this.#assertIssue(issue);
    const expectedRepositoryUrl = `${this.#baseUrl}${this.#repositoryPath()}`;
    if (issue.repository_url !== expectedRepositoryUrl) {
      throw new ProjectContextError(
        "ISSUE_OUTSIDE_TARGET",
        "GitHub relation points outside the configured repository target",
      );
    }
    if (!this.#project) return { issue };

    return this.#scopedIssue(`#${issue.number}`);
  }

  async #scopedRelationIssue(issue: GitHubIssue): Promise<GitHubIssue> {
    return (await this.#scopedRelation(issue)).issue;
  }

  async #relationReference(issue: GitHubIssue): Promise<IssueReference> {
    return this.#reference(await this.#scopedRelationIssue(issue));
  }

  async #graphqlRelationReference(issue: GitHubGraphqlIssueReference): Promise<IssueReference> {
    const expectedRepository = `${this.#repository.owner}/${this.#repository.name}`;
    if (!sameName(issue.repository.nameWithOwner, expectedRepository)) {
      throw new ProjectContextError(
        "ISSUE_OUTSIDE_TARGET",
        "GitHub relation points outside the configured repository target",
      );
    }
    if (this.#project) {
      return this.#reference((await this.#scopedIssue(`#${issue.number}`)).issue);
    }

    return {
      id: String(issue.databaseId),
      identifier: `#${issue.number}`,
      title: issue.title,
      url: issue.url,
    };
  }

  async #collectRelationIssues(
    path: string,
    page = 1,
    collected: GitHubIssue[] = [],
  ): Promise<{ issues: GitHubIssue[]; truncated: boolean }> {
    const separator = path.includes("?") ? "&" : "?";
    const parameters = new URLSearchParams({
      per_page: String(githubRelationPageSize),
      page: String(page),
    });
    const issues = await this.#request<GitHubIssue[]>(`${path}${separator}${parameters}`);
    const allIssues = [...collected, ...issues];
    const hasNextPage = issues.length === githubRelationPageSize;
    const pageBoundReached = page >= githubRelationMaxPages;

    if (!hasNextPage || pageBoundReached) {
      return { issues: allIssues, truncated: hasNextPage && pageBoundReached };
    }

    return this.#collectRelationIssues(path, page + 1, allIssues);
  }

  async #duplicateIssue(issueNumber: number): Promise<GitHubGraphqlIssueReference | null> {
    const data = await this.#graphql<{
      repository: { issue: { duplicateOf: GitHubGraphqlIssueReference | null } | null } | null;
    }>(
      `query IssueDuplicate($owner: String!, $repo: String!, $number: Int!) {
        repository(owner: $owner, name: $repo) {
          issue(number: $number) {
            duplicateOf {
              id databaseId number title url
              repository { nameWithOwner }
            }
          }
        }
      }`,
      { owner: this.#repository.owner, repo: this.#repository.name, number: issueNumber },
      "read",
    );

    return data.repository?.issue?.duplicateOf ?? null;
  }

  async #duplicateReference(issueNumber: number): Promise<IssueReference | null> {
    const duplicate = await this.#duplicateIssue(issueNumber);

    return duplicate ? this.#graphqlRelationReference(duplicate) : null;
  }

  async #relations(issue: GitHubIssue): Promise<IssueRelations> {
    const parentIssue = await this.#requestOptional<GitHubIssue>(
      this.#issuePath(`/${issue.number}/parent`),
    );
    const parent = parentIssue ? await this.#relationReference(parentIssue) : null;
    const [subIssuesResult, blockedByResult, blocksResult, duplicateOf] = await Promise.all([
      this.#collectRelationIssues(this.#issuePath(`/${issue.number}/sub_issues`)),
      this.#collectRelationIssues(this.#issuePath(`/${issue.number}/dependencies/blocked_by`)),
      this.#collectRelationIssues(this.#issuePath(`/${issue.number}/dependencies/blocking`)),
      this.#duplicateReference(issue.number),
    ]);
    if (subIssuesResult.truncated || blockedByResult.truncated || blocksResult.truncated) {
      throw new ProjectContextError(
        "PROVIDER_RESULT_TRUNCATED",
        "GitHub relation expansion exceeded the bounded pagination limit",
      );
    }
    const [subIssues, blockedBy, blocks] = await Promise.all([
      Promise.all(subIssuesResult.issues.map((related) => this.#relationReference(related))),
      Promise.all(blockedByResult.issues.map((related) => this.#relationReference(related))),
      Promise.all(blocksResult.issues.map((related) => this.#relationReference(related))),
    ]);

    return { parent, subIssues, blocks, blockedBy, relatedTo: [], duplicateOf };
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
    if (options.includeArchived) {
      throw new ProjectContextError(
        "OPERATION_UNSUPPORTED",
        "GitHub issue listing does not support archived filters",
      );
    }
    const limit = options.limit ?? 30;
    if (options.parent) {
      const { issue: parent } = await this.#scopedIssue(options.parent);
      const result = await this.#collectRelationIssues(
        this.#issuePath(`/${parent.number}/sub_issues`),
      );
      const scopedIssues = await Promise.all(
        result.issues.map((related) => this.#scopedRelation(related)),
      );
      const issues = scopedIssues
        .toSorted((left, right) => right.issue.updated_at.localeCompare(left.issue.updated_at))
        .slice(0, limit)
        .map(({ issue, membership }) => this.#snapshot(issue, membership));

      return { issues, truncated: result.truncated || scopedIssues.length > issues.length };
    }
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
    if (field === "labels") {
      const result = await this.#searchLabels(query, limit);

      return {
        options: result.labels.map((label) => ({ value: label.name, label: label.name })),
        truncated: result.truncated,
      };
    }
    if (field === "issueType") {
      const result = await this.#issueTypes();
      if (!result.supported) {
        throw new ProjectContextError(
          "ISSUE_OPTION_FIELD_UNSUPPORTED",
          "GitHub issue types are unavailable for the configured repository",
        );
      }

      return filterIssueOptions(
        result.options.map((issueType) => ({ value: issueType.name, label: issueType.name })),
        query,
        limit,
      );
    }
    if (field === "milestone") {
      const result = await this.#collectMilestones();
      const filtered = filterIssueOptions(
        result.milestones.map((milestone) => ({
          value: String(milestone.number),
          label: milestone.title,
        })),
        query,
        limit,
      );

      return {
        ...filtered,
        truncated: result.truncated || filtered.truncated,
      };
    }

    throw new ProjectContextError(
      "ISSUE_OPTION_FIELD_UNSUPPORTED",
      `GitHub does not expose searchable ${field} options`,
    );
  }

  async capabilities(): Promise<ProviderIssueCapabilities> {
    const [labels, issueTypes, milestones] = await Promise.all([
      this.#collectLabels(),
      this.#issueTypes(),
      this.#collectMilestones(),
    ]);

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
        issueFieldCapability("issueType", issueTypes.supported ? ["create", "update"] : [], {
          clearable: issueTypes.supported,
          options: issueTypes.options.slice(0, 100).map((issueType) => ({
            value: issueType.name,
            label: issueType.name,
          })),
          optionsTruncated: issueTypes.options.length > 100,
          discoveryTool: issueTypes.supported ? "search_issue_options" : null,
        }),
        issueFieldCapability("milestone", ["create", "update"], {
          clearable: true,
          options: milestones.milestones.slice(0, 100).map((milestone) => ({
            value: String(milestone.number),
            label: milestone.title,
          })),
          optionsTruncated: milestones.truncated || milestones.milestones.length > 100,
          discoveryTool: "search_issue_options",
        }),
        issueFieldCapability("parent", ["create", "update"], {
          clearable: true,
          discoveryTool: "get_issue",
        }),
        issueFieldCapability("blocks", ["create", "update"], {
          discoveryTool: "get_issue",
        }),
        issueFieldCapability("blockedBy", ["create", "update"], {
          discoveryTool: "get_issue",
        }),
        issueFieldCapability("duplicateOf", ["create", "update"], {
          clearable: true,
          discoveryTool: "get_issue",
        }),
        issueFieldCapability("removeBlocks", ["update"], { discoveryTool: "get_issue" }),
        issueFieldCapability("removeBlockedBy", ["update"], {
          discoveryTool: "get_issue",
        }),
      ],
    };
  }

  async get(identifier: string, options: IssueGetOptions = {}): Promise<IssueSnapshot> {
    const { issue, membership } = await this.#scopedIssue(identifier);
    const relations = options.includeRelations ? await this.#relations(issue) : null;

    return this.#snapshot(issue, membership, relations);
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

  async #resolvedIssue(value: string | null | undefined): Promise<GitHubIssue | null | undefined> {
    if (value === undefined || value === null) return value;

    return (await this.#scopedIssue(value)).issue;
  }

  async #resolvedIssues(values: string[] | undefined): Promise<GitHubIssue[]> {
    return Promise.all((values ?? []).map(async (value) => (await this.#scopedIssue(value)).issue));
  }

  async #resolvedInput(
    input: IssueCreateInput | IssueUpdateInput,
    source?: GitHubIssue,
  ): Promise<ResolvedGitHubInput> {
    const [
      issueType,
      milestone,
      parent,
      blocks,
      blockedBy,
      duplicateOf,
      removeBlocks,
      removeBlockedBy,
    ] = await Promise.all([
      this.#resolvedIssueType(input.issueType),
      this.#resolvedMilestone(input.milestone),
      this.#resolvedIssue(input.parent),
      this.#resolvedIssues(input.blocks),
      this.#resolvedIssues(input.blockedBy),
      this.#resolvedIssue(input.duplicateOf),
      this.#resolvedIssues("removeBlocks" in input ? input.removeBlocks : undefined),
      this.#resolvedIssues("removeBlockedBy" in input ? input.removeBlockedBy : undefined),
    ]);
    const referenced = [
      ...(parent ? [parent] : []),
      ...blocks,
      ...blockedBy,
      ...(duplicateOf ? [duplicateOf] : []),
      ...removeBlocks,
      ...removeBlockedBy,
    ];
    if (source && referenced.some((issue) => issue.id === source.id)) {
      throw new ProjectContextError(
        "ISSUE_RELATION_INVALID",
        "An issue cannot have a relationship with itself",
      );
    }

    return {
      issueType,
      milestone,
      parent,
      blocks,
      blockedBy,
      duplicateOf,
      removeBlocks,
      removeBlockedBy,
    };
  }

  #baseIssueBody(
    input: IssueCreateInput | IssueUpdateInput,
    resolved: ResolvedGitHubInput,
  ): Record<string, unknown> {
    return {
      ...(input.title === undefined ? {} : { title: input.title }),
      ...(input.description === undefined ? {} : { body: input.description }),
      ...(input.labels === undefined ? {} : { labels: input.labels }),
      ...(input.assignee === undefined
        ? {}
        : { assignees: input.assignee ? [input.assignee] : [] }),
      ...(resolved.issueType === undefined ? {} : { type: resolved.issueType }),
      ...(resolved.milestone === undefined ? {} : { milestone: resolved.milestone }),
    };
  }

  async #applyEach(
    issues: GitHubIssue[],
    operation: (issue: GitHubIssue) => Promise<unknown>,
    index = 0,
  ): Promise<void> {
    const issue = issues[index];
    if (!issue) return;

    await operation(issue);
    await this.#applyEach(issues, operation, index + 1);
  }

  async #setParent(
    source: GitHubIssue,
    parent: GitHubIssue,
    replaceParent: boolean,
  ): Promise<void> {
    await this.#request(this.#issuePath(`/${parent.number}/sub_issues`), "POST", {
      sub_issue_id: source.id,
      ...(replaceParent ? { replace_parent: true } : {}),
    });
  }

  async #clearParent(source: GitHubIssue): Promise<void> {
    const parent = await this.#requestOptional<GitHubIssue>(
      this.#issuePath(`/${source.number}/parent`),
    );
    if (!parent) return;

    const scopedParent = await this.#scopedRelationIssue(parent);
    await this.#request(this.#issuePath(`/${scopedParent.number}/sub_issue`), "DELETE", {
      sub_issue_id: source.id,
    });
  }

  async #addBlockedBy(issue: GitHubIssue, blocker: GitHubIssue): Promise<void> {
    await this.#request(this.#issuePath(`/${issue.number}/dependencies/blocked_by`), "POST", {
      issue_id: blocker.id,
    });
  }

  async #removeBlockedBy(issue: GitHubIssue, blocker: GitHubIssue): Promise<void> {
    await this.#request(
      this.#issuePath(`/${issue.number}/dependencies/blocked_by/${blocker.id}`),
      "DELETE",
    );
  }

  async #clearDuplicate(source: GitHubIssue): Promise<void> {
    const duplicate = await this.#duplicateIssue(source.number);
    if (!duplicate) return;
    await this.#graphqlRelationReference(duplicate);
    if (!source.node_id) {
      throw new ProjectContextError(
        "GITHUB_ISSUE_NODE_ID_MISSING",
        "GitHub issue response did not include a GraphQL node identity",
      );
    }

    await this.#graphql(
      `mutation UnmarkIssueDuplicate($canonicalId: ID!, $duplicateId: ID!) {
        unmarkIssueAsDuplicate(input: {
          canonicalId: $canonicalId
          duplicateId: $duplicateId
        }) {
          duplicate { ... on Issue { id } }
        }
      }`,
      { canonicalId: duplicate.id, duplicateId: source.node_id },
      "write",
    );
  }

  async #applyRelations(
    source: GitHubIssue,
    input: IssueCreateInput | IssueUpdateInput,
    resolved: ResolvedGitHubInput,
    replaceParent: boolean,
  ): Promise<void> {
    if (resolved.parent) await this.#setParent(source, resolved.parent, replaceParent);
    if (resolved.parent === null) await this.#clearParent(source);

    if (resolved.duplicateOf) {
      await this.#request(this.#issuePath(`/${source.number}`), "PATCH", {
        state: "closed",
        state_reason: "duplicate",
        duplicate_issue_id: resolved.duplicateOf.id,
      });
    }

    await this.#applyEach(resolved.blocks, (blocked) => this.#addBlockedBy(blocked, source));
    await this.#applyEach(resolved.blockedBy, (blocker) => this.#addBlockedBy(source, blocker));
    await this.#applyEach(resolved.removeBlocks, (blocked) =>
      this.#removeBlockedBy(blocked, source),
    );
    await this.#applyEach(resolved.removeBlockedBy, (blocker) =>
      this.#removeBlockedBy(source, blocker),
    );

    if (input.duplicateOf === null) await this.#clearDuplicate(source);
  }

  #hasRelationWrites(input: IssueCreateInput | IssueUpdateInput): boolean {
    return ["parent", "blocks", "blockedBy", "duplicateOf", "removeBlocks", "removeBlockedBy"].some(
      (field) => Object.hasOwn(input, field),
    );
  }

  async create(input: IssueCreateInput): Promise<IssueSnapshot> {
    this.#assertSupportedFields(input);
    const resolved = await this.#resolvedInput(input);
    const issue = await this.#request<GitHubIssue>(
      this.#issuePath(),
      "POST",
      this.#baseIssueBody(input, resolved),
    );
    const membership = this.#project
      ? await (async () => {
          if (!issue.node_id) {
            throw new ProjectContextError(
              "GITHUB_ISSUE_NODE_ID_MISSING",
              "GitHub issue response did not include a GraphQL node identity",
            );
          }

          return this.#project?.add(issue.node_id);
        })()
      : undefined;
    if (this.#project && !membership) {
      throw new ProjectContextError(
        "GITHUB_PROJECT_ADD_FAILED",
        "GitHub issue could not be added to the configured Project",
      );
    }
    await this.#applyRelations(issue, input, resolved, false);
    if (this.#hasRelationWrites(input)) {
      const refreshed = await this.#scopedIssue(`#${issue.number}`);

      return this.#snapshot(refreshed.issue, refreshed.membership);
    }

    return this.#snapshot(issue, membership);
  }

  async update(identifier: string, input: IssueUpdateInput): Promise<IssueSnapshot> {
    this.#assertSupportedFields(input);
    const { issue: source } = await this.#scopedIssue(identifier);
    const resolved = await this.#resolvedInput(input, source);
    const body = this.#baseIssueBody(input, resolved);

    if (Object.keys(body).length > 0) {
      await this.#request<GitHubIssue>(this.#issuePath(`/${source.number}`), "PATCH", body);
    }
    await this.#applyRelations(source, input, resolved, true);

    const refreshed = await this.#scopedIssue(identifier);

    return this.#snapshot(refreshed.issue, refreshed.membership);
  }

  async validateCommentTarget(
    identifier: string,
    options: IssueCommentWriteOptions,
  ): Promise<void> {
    if (options.parentCommentId) {
      throw new ProjectContextError(
        "OPERATION_UNSUPPORTED",
        "GitHub issue comments do not support threaded replies",
      );
    }
    if (!options.commentId) return;

    const { issue } = await this.#scopedIssue(identifier);
    const comment = await this.#request<GitHubComment>(this.#commentPath(options.commentId));
    const expectedIssueUrl = `${this.#baseUrl}${this.#issuePath(`/${issue.number}`)}`;
    if (comment.issue_url !== expectedIssueUrl) {
      throw new ProjectContextError(
        "ISSUE_COMMENT_OUTSIDE_TARGET",
        "GitHub comment does not belong to the target issue",
      );
    }
    await this.#scopedIssue(identifier);
  }

  async comment(
    identifier: string,
    body: string,
    options: IssueCommentWriteOptions = {},
  ): Promise<void> {
    if (options.commentId || options.parentCommentId) {
      await this.validateCommentTarget(identifier, options);
      if (!options.commentId) return;

      await this.#request(this.#commentPath(options.commentId), "PATCH", { body });
      return;
    }

    const { issue } = await this.#scopedIssue(identifier);
    await this.#request(this.#issuePath(`/${issue.number}/comments`), "POST", { body });
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
    const unsupported = ["dueDate", "estimate", "cycle", "relatedTo", "removeRelatedTo"].find(
      (field) => Object.hasOwn(input, field),
    );
    if (unsupported) {
      throw new ProjectContextError(
        "FIELD_UNSUPPORTED",
        `GitHub Issues does not support the generic ${unsupported} field`,
      );
    }
  }
}
