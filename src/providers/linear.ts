import { ProjectContextError } from "../core/errors.ts";
import type { LinearProjectProvider, LinearProviderProfile } from "../core/types.ts";
import { filterIssueOptions, issueFieldCapability } from "./capabilities.ts";
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

function linearStatusFilter(match: NonNullable<IssueListOptions["matches"]>[number]) {
  const conditions = [
    ...(match.state ? [{ state: { name: { eqIgnoreCase: match.state } } }] : []),
    ...match.labelsAll.map((label) => ({ labels: { name: { eqIgnoreCase: label } } })),
    ...match.labelsNone.map((label) => ({
      labels: { every: { name: { neqIgnoreCase: label } } },
    })),
  ];

  return conditions.length === 1 ? conditions[0] : { and: conditions };
}

const linearPriorities = [
  { value: 0, label: "No priority" },
  { value: 1, label: "Urgent" },
  { value: 2, label: "High" },
  { value: 3, label: "Medium" },
  { value: 4, label: "Low" },
];

interface LinearIssue {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  url: string;
  updatedAt: string;
  createdAt?: string;
  dueDate?: string | null;
  priority?: number;
  priorityLabel?: string;
  assignee?: LinearAssignableUser | null;
  creator?: Omit<LinearAssignableUser, "active"> | null;
  state: { id: string; name: string };
  team?: { id: string };
  project?: { id: string } | null;
  labels?: { nodes: Array<{ name: string }> };
}

interface LinearAssignableUser {
  id: string;
  name: string;
  email: string;
  active: boolean;
}

interface LinearUserPage {
  nodes: LinearAssignableUser[];
  pageInfo: { hasNextPage: boolean; endCursor?: string | null };
}

interface LinearComment {
  id: string;
  body: string;
  createdAt: string;
  updatedAt: string;
  url?: string | null;
  user?: Omit<LinearAssignableUser, "active"> | null;
}

export class LinearIssuesAdapter implements IssueProviderAdapter {
  readonly type = "linear" as const;

  constructor(
    _profile: LinearProviderProfile,
    private readonly target: LinearProjectProvider["target"],
    private readonly credential: Record<string, string>,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async #graphql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const result = await requestJson<{ data?: T; errors?: Array<{ message: string }> }>(
      this.fetcher,
      "https://api.linear.app/graphql",
      {
        method: "POST",
        headers: {
          Authorization: this.credential.token ?? "",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query, variables }),
      },
      {
        provider: "Linear",
        allowedOrigin: "https://api.linear.app",
        access: query.trimStart().startsWith("mutation") ? "write" : "read",
      },
    );
    if (result.errors?.length || !result.data) {
      throw new ProjectContextError(
        "LINEAR_GRAPHQL_ERROR",
        "Linear GraphQL request failed; provider response details were redacted",
      );
    }
    return result.data;
  }

  #snapshot(issue: LinearIssue): IssueSnapshot {
    return {
      provider: this.type,
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      description: issue.description,
      status: issue.state.name,
      labels: issue.labels?.nodes.map((label) => label.name) ?? [],
      assignee: issue.assignee ? this.#assignableUser(issue.assignee) : null,
      creator: issue.creator ? this.#issueUser(issue.creator) : null,
      priority:
        issue.priority === undefined
          ? null
          : { value: issue.priority, label: issue.priorityLabel ?? String(issue.priority) },
      issueType: null,
      createdAt: issue.createdAt ?? null,
      dueDate: issue.dueDate ?? null,
      url: issue.url,
      updatedAt: issue.updatedAt,
      version: versionOf(issue.updatedAt, issue.id),
    };
  }

  #assignableUser(user: LinearAssignableUser): AssignableUser {
    return {
      provider: this.type,
      assignee: user.id,
      displayName: user.name,
      username: null,
      email: user.email || null,
      active: user.active,
    };
  }

  #issueUser(user: Omit<LinearAssignableUser, "active">): IssueUser {
    return {
      provider: this.type,
      id: user.id,
      displayName: user.name,
      username: null,
      email: user.email || null,
    };
  }

  async #userPage(first: number, after?: string): Promise<LinearUserPage> {
    const data = await this.#graphql<{ team: { members: LinearUserPage } }>(
      `query TeamUsers($teamId: String!, $first: Int!, $after: String) {
        team(id: $teamId) {
          members(first: $first, after: $after) {
            nodes { id name email active }
            pageInfo { hasNextPage endCursor }
          }
        }
      }`,
      { teamId: this.target.team.id, first, ...(after ? { after } : {}) },
    );

    return data.team.members;
  }

  async #collectAssignableUsers(
    query: string | undefined,
    limit: number,
    after?: string,
    collected: LinearAssignableUser[] = [],
  ): Promise<LinearAssignableUser[]> {
    const pageSize = query ? 100 : Math.min(limit + 1, 100);
    const page = await this.#userPage(pageSize, after);
    const normalizedQuery = query?.trim().toLocaleLowerCase();
    const activeUsers = page.nodes.filter((user) => user.active);
    const matches = normalizedQuery
      ? activeUsers.filter((user) =>
          [user.name, user.email].some((value) =>
            value.toLocaleLowerCase().includes(normalizedQuery),
          ),
        )
      : activeUsers;
    const users = [...collected, ...matches];
    const nextCursor = page.pageInfo.endCursor;

    if (users.length > limit || !page.pageInfo.hasNextPage || !nextCursor) return users;
    return this.#collectAssignableUsers(query, limit, nextCursor, users);
  }

  async #users(query: string | undefined, limit: number): Promise<UserListResult> {
    const users = await this.#collectAssignableUsers(query, limit);

    return {
      users: users.slice(0, limit).map((user) => this.#assignableUser(user)),
      truncated: users.length > limit,
    };
  }

  #assertTarget(issue: LinearIssue): void {
    const teamMatches = issue.team?.id === this.target.team.id;
    const projectMatches =
      Object.hasOwn(issue, "project") &&
      (this.target.project === "none"
        ? issue.project === null
        : issue.project?.id === this.target.project.id);
    if (teamMatches && projectMatches) return;

    throw new ProjectContextError(
      "ISSUE_OUTSIDE_TARGET",
      "Linear issue is outside the configured team/project target",
    );
  }

  #targetedSnapshot(issue: LinearIssue): IssueSnapshot {
    this.#assertTarget(issue);
    return this.#snapshot(issue);
  }

  #comment(comment: LinearComment): IssueComment {
    return {
      provider: this.type,
      id: comment.id,
      body: comment.body,
      author: comment.user ? this.#issueUser(comment.user) : null,
      createdAt: comment.createdAt,
      updatedAt: comment.updatedAt,
      url: comment.url ?? null,
    };
  }

  #priority(value: string | number): number {
    if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 4)
      return value;
    const normalized = String(value).trim().toLowerCase().replaceAll("_", " ");
    const priorities: Record<string, number> = {
      "no priority": 0,
      none: 0,
      urgent: 1,
      high: 2,
      medium: 3,
      low: 4,
    };
    const priority = priorities[normalized];
    if (priority === undefined) {
      throw new ProjectContextError(
        "LINEAR_PRIORITY_INVALID",
        `Unsupported Linear priority ${value}; use none, urgent, high, medium, low, or 0-4`,
      );
    }
    return priority;
  }

  async #labels(): Promise<Array<{ id: string; name: string }>> {
    const data = await this.#graphql<{
      issueLabels: { nodes: Array<{ id: string; name: string }> };
    }>(
      `query Labels($teamId: ID!) {
        issueLabels(filter: { team: { id: { eq: $teamId } } }) { nodes { id name } }
      }`,
      { teamId: this.target.team.id },
    );

    return data.issueLabels.nodes;
  }

  async #capabilityLabels(): Promise<{
    labels: Array<{ id: string; name: string }>;
    truncated: boolean;
  }> {
    const data = await this.#graphql<{
      issueLabels: {
        nodes: Array<{ id: string; name: string }>;
        pageInfo: { hasNextPage: boolean };
      };
    }>(
      `query CapabilityLabels($teamId: ID!, $first: Int!) {
        issueLabels(filter: { team: { id: { eq: $teamId } } }, first: $first) {
          nodes { id name }
          pageInfo { hasNextPage }
        }
      }`,
      { teamId: this.target.team.id, first: 101 },
    );

    return {
      labels: data.issueLabels.nodes.slice(0, 100),
      truncated: data.issueLabels.pageInfo.hasNextPage || data.issueLabels.nodes.length > 100,
    };
  }

  async #labelIds(names: string[]): Promise<string[]> {
    const labels = await this.#labels();
    return names.map((name) => {
      const matches = labels.filter(
        (label) => label.name.localeCompare(name, undefined, { sensitivity: "accent" }) === 0,
      );
      if (matches.length !== 1) {
        throw new ProjectContextError(
          "LINEAR_LABEL_AMBIGUOUS",
          `Linear label ${name} resolved to ${matches.length} labels`,
        );
      }
      return matches[0]?.id as string;
    });
  }

  async #input(input: IssueUpdateInput | IssueCreateInput): Promise<Record<string, unknown>> {
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
      ...(input.assignee === undefined ? {} : { assigneeId: input.assignee }),
      ...(input.labels === undefined ? {} : { labelIds: await this.#labelIds(input.labels) }),
    };
  }

  async identity(): Promise<ProviderIdentity> {
    const data = await this.#graphql<{
      viewer: { id: string; name: string; email: string };
      organization: { id: string; name: string };
    }>("query Identity { viewer { id name email } organization { id name } }");
    return {
      provider: this.type,
      principalId: data.viewer.id,
      principalName: data.viewer.email || data.viewer.name,
      scopeId: data.organization.id,
      scopeName: data.organization.name,
    };
  }

  async list(options: IssueListOptions = {}): Promise<IssueListResult> {
    const limit = options.limit ?? 30;
    const projectFilter =
      this.target.project === "none" ? { null: true } : { id: { eq: this.target.project.id } };
    const matches = options.matches?.map(linearStatusFilter) ?? [];
    const filter = {
      team: { id: { eq: this.target.team.id } },
      project: projectFilter,
      ...(matches.length === 0 ? {} : { or: matches }),
    };
    const data = await this.#graphql<{
      issues: { nodes: LinearIssue[]; pageInfo: { hasNextPage: boolean } };
    }>(
      `query List($filter: IssueFilter!, $first: Int!) {
        issues(filter: $filter, first: $first, orderBy: updatedAt) {
          nodes {
            id identifier title description url updatedAt createdAt dueDate priority priorityLabel
            state { id name } labels { nodes { name } }
            assignee { id name email active }
            creator { id name email }
            team { id }
            project { id }
          }
          pageInfo { hasNextPage }
        }
      }`,
      { filter, first: limit },
    );
    const issues = data.issues.nodes.map((issue) => this.#targetedSnapshot(issue));

    return { issues, truncated: data.issues.pageInfo.hasNextPage };
  }

  async search(query: string, limit = 30): Promise<IssueSnapshot[]> {
    const projectFilter =
      this.target.project === "none" ? { null: true } : { id: { eq: this.target.project.id } };
    const filter = {
      team: { id: { eq: this.target.team.id } },
      project: projectFilter,
      or: [
        { title: { containsIgnoreCase: query } },
        { description: { containsIgnoreCase: query } },
      ],
    };

    const data = await this.#graphql<{ issues: { nodes: LinearIssue[] } }>(
      `query Search($filter: IssueFilter!, $first: Int!) {
        issues(filter: $filter, first: $first) {
          nodes {
            id identifier title description url updatedAt createdAt dueDate priority priorityLabel
            state { id name } labels { nodes { name } }
            assignee { id name email active }
            creator { id name email }
            team { id }
            project { id }
          }
        }
      }`,
      { filter, first: limit },
    );
    return data.issues.nodes.map((issue) => this.#targetedSnapshot(issue));
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
    const data = await this.#graphql<{
      issueLabels: {
        nodes: Array<{ id: string; name: string }>;
        pageInfo: { hasNextPage: boolean };
      };
    }>(
      `query SearchOptions($teamId: ID!, $query: String!, $first: Int!) {
        issueLabels(
          filter: {
            team: { id: { eq: $teamId } }
            name: { containsIgnoreCase: $query }
          }
          first: $first
        ) {
          nodes { id name }
          pageInfo { hasNextPage }
        }
      }`,
      { teamId: this.target.team.id, query, first: limit + 1 },
    );
    const options = data.issueLabels.nodes.map((label) => ({
      value: label.name,
      label: label.name,
    }));

    return {
      options: options.slice(0, limit),
      truncated: data.issueLabels.pageInfo.hasNextPage || options.length > limit,
    };
  }

  async capabilities(): Promise<ProviderIssueCapabilities> {
    const labelResult = await this.#capabilityLabels();

    return {
      fields: [
        issueFieldCapability("title", ["create", "update"]),
        issueFieldCapability("description", ["create", "update"]),
        issueFieldCapability("labels", ["create", "update"], {
          options: labelResult.labels.map((label) => ({ value: label.name, label: label.name })),
          optionsTruncated: labelResult.truncated,
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
  }

  async get(identifier: string): Promise<IssueSnapshot> {
    const data = await this.#graphql<{ issue: LinearIssue }>(
      `query Issue($id: String!) {
        issue(id: $id) {
          id identifier title description url updatedAt createdAt dueDate priority priorityLabel
          state { id name } labels { nodes { name } }
          assignee { id name email active }
          creator { id name email }
          team { id }
          project { id }
        }
      }`,
      { id: identifier },
    );
    return this.#targetedSnapshot(data.issue);
  }

  async listComments(identifier: string, limit = 30): Promise<IssueCommentListResult> {
    const data = await this.#graphql<{
      issue: LinearIssue & {
        comments: {
          nodes: LinearComment[];
          pageInfo: { hasPreviousPage: boolean };
        };
      };
    }>(
      `query IssueComments($id: String!, $last: Int!) {
        issue(id: $id) {
          id identifier
          team { id }
          project { id }
          comments(last: $last) {
            nodes {
              id body createdAt updatedAt url
              user { id name email }
            }
            pageInfo { hasPreviousPage }
          }
        }
      }`,
      { id: identifier, last: limit },
    );
    this.#assertTarget(data.issue);

    return {
      comments: data.issue.comments.nodes
        .toSorted((left, right) => right.createdAt.localeCompare(left.createdAt))
        .map((comment) => this.#comment(comment)),
      truncated: data.issue.comments.pageInfo.hasPreviousPage,
    };
  }

  async create(input: IssueCreateInput): Promise<IssueSnapshot> {
    const variables = {
      input: {
        ...(await this.#input(input)),
        teamId: this.target.team.id,
        ...(this.target.project === "none" ? {} : { projectId: this.target.project.id }),
      },
    };
    const data = await this.#graphql<{ issueCreate: { success: boolean; issue: LinearIssue } }>(
      `mutation Create($input: IssueCreateInput!) {
        issueCreate(input: $input) {
          success
          issue {
            id identifier title description url updatedAt createdAt dueDate priority priorityLabel
            state { id name } labels { nodes { name } }
            assignee { id name email active }
            creator { id name email }
          }
        }
      }`,
      variables,
    );
    if (!data.issueCreate.success) {
      throw new ProjectContextError("LINEAR_MUTATION_FAILED", "Linear issue creation failed");
    }
    return this.#snapshot(data.issueCreate.issue);
  }

  async update(identifier: string, input: IssueUpdateInput): Promise<IssueSnapshot> {
    return this.#updateRaw(identifier, await this.#input(input));
  }

  async #updateRaw(identifier: string, input: Record<string, unknown>): Promise<IssueSnapshot> {
    const data = await this.#graphql<{ issueUpdate: { success: boolean; issue: LinearIssue } }>(
      `mutation Update($id: String!, $input: IssueUpdateInput!) {
        issueUpdate(id: $id, input: $input) {
          success
          issue {
            id identifier title description url updatedAt createdAt dueDate priority priorityLabel
            state { id name } labels { nodes { name } }
            assignee { id name email active }
            creator { id name email }
          }
        }
      }`,
      { id: identifier, input },
    );
    if (!data.issueUpdate.success) {
      throw new ProjectContextError("LINEAR_MUTATION_FAILED", "Linear issue update failed");
    }
    return this.#snapshot(data.issueUpdate.issue);
  }

  async comment(identifier: string, body: string): Promise<void> {
    const issue = await this.get(identifier);
    const data = await this.#graphql<{ commentCreate: { success: boolean } }>(
      `mutation Comment($input: CommentCreateInput!) {
        commentCreate(input: $input) { success }
      }`,
      { input: { issueId: issue.id, body } },
    );
    if (!data.commentCreate.success) {
      throw new ProjectContextError("LINEAR_MUTATION_FAILED", "Linear comment creation failed");
    }
  }

  async transition(identifier: string, nativeStatus: string): Promise<IssueSnapshot> {
    const states = await this.#graphql<{
      workflowStates: { nodes: Array<{ id: string; name: string }> };
    }>(
      `query States($teamId: ID!) {
        workflowStates(filter: { team: { id: { eq: $teamId } } }) { nodes { id name } }
      }`,
      { teamId: this.target.team.id },
    );
    const matches = states.workflowStates.nodes.filter(
      (state) => state.name.localeCompare(nativeStatus, undefined, { sensitivity: "accent" }) === 0,
    );
    if (matches.length !== 1) {
      throw new ProjectContextError(
        "LINEAR_STATE_AMBIGUOUS",
        `Linear state ${nativeStatus} resolved to ${matches.length} workflow states`,
      );
    }
    return this.#updateRaw(identifier, { stateId: matches[0]?.id });
  }

  async link(identifier: string, targetUrl: string): Promise<void> {
    await this.comment(identifier, `Related issue: ${targetUrl}`);
  }
}
