import { ProjectContextError } from "../core/errors.ts";
import type { LinearProjectProvider, LinearProviderProfile } from "../core/types.ts";
import { requestJson, versionOf } from "./http.ts";
import type {
  IssueCreateInput,
  IssueProviderAdapter,
  IssueSnapshot,
  IssueUpdateInput,
  ProviderIdentity,
} from "./types.ts";

interface LinearIssue {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  url: string;
  updatedAt: string;
  state: { id: string; name: string };
  team?: { id: string };
  project?: { id: string } | null;
  labels?: { nodes: Array<{ name: string }> };
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
    );
    if (result.errors?.length || !result.data) {
      throw new ProjectContextError(
        "LINEAR_GRAPHQL_ERROR",
        `Linear GraphQL request failed${result.errors?.length ? `: ${result.errors.map((error) => error.message).join("; ")}` : ""}`,
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
      url: issue.url,
      updatedAt: issue.updatedAt,
      version: versionOf(issue.updatedAt, issue.id),
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

  async search(query: string, limit = 30): Promise<IssueSnapshot[]> {
    const data = await this.#graphql<{ issueSearch: { nodes: LinearIssue[] } }>(
      `query Search($query: String!, $first: Int!) {
        issueSearch(query: $query, first: $first) {
          nodes {
            id identifier title description url updatedAt state { id name } labels { nodes { name } }
            team { id }
            project { id }
          }
        }
      }`,
      { query, first: limit },
    );
    return data.issueSearch.nodes
      .filter((issue) => issue.team?.id === this.target.team.id)
      .filter(
        (issue) => this.target.project === "none" || issue.project?.id === this.target.project.id,
      )
      .map((issue) => this.#snapshot(issue));
  }

  async get(identifier: string): Promise<IssueSnapshot> {
    const data = await this.#graphql<{ issue: LinearIssue }>(
      `query Issue($id: String!) {
        issue(id: $id) { id identifier title description url updatedAt state { id name } labels { nodes { name } } }
      }`,
      { id: identifier },
    );
    return this.#snapshot(data.issue);
  }

  async create(input: IssueCreateInput): Promise<IssueSnapshot> {
    const variables = {
      input: {
        title: input.title,
        teamId: this.target.team.id,
        ...(this.target.project === "none" ? {} : { projectId: this.target.project.id }),
        ...(input.description === undefined ? {} : { description: input.description }),
        ...(input.priority === undefined ? {} : { priority: input.priority }),
        ...(input.assignee === undefined ? {} : { assigneeId: input.assignee }),
      },
    };
    const data = await this.#graphql<{ issueCreate: { success: boolean; issue: LinearIssue } }>(
      `mutation Create($input: IssueCreateInput!) {
        issueCreate(input: $input) {
          success
          issue { id identifier title description url updatedAt state { id name } labels { nodes { name } } }
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
    const data = await this.#graphql<{ issueUpdate: { success: boolean; issue: LinearIssue } }>(
      `mutation Update($id: String!, $input: IssueUpdateInput!) {
        issueUpdate(id: $id, input: $input) {
          success
          issue { id identifier title description url updatedAt state { id name } labels { nodes { name } } }
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
    return this.update(identifier, { stateId: matches[0]?.id } as IssueUpdateInput);
  }

  async link(identifier: string, targetUrl: string): Promise<void> {
    await this.comment(identifier, `Related issue: ${targetUrl}`);
  }
}
