import { ProjectContextError } from "../core/errors.ts";
import type { GitHubProjectTarget } from "../core/types.ts";
import { requestJson } from "./http.ts";

export interface GitHubProjectIssueContent {
  __typename: "Issue";
  id: string;
  databaseId: number;
  number: number;
  title: string;
  body: string | null;
  state: "OPEN" | "CLOSED";
  stateReason: "COMPLETED" | "NOT_PLANNED" | "REOPENED" | null;
  url: string;
  updatedAt: string;
  createdAt: string;
  repository: { nameWithOwner: string };
  author: { login: string; databaseId: number } | null;
  assignees: { nodes: Array<{ login: string; databaseId: number }> };
  labels: { nodes: Array<{ name: string }> };
}

export interface GitHubProjectIssueItem {
  id: string;
  content: GitHubProjectIssueContent;
  status: string | null;
  statusOptionId: string | null;
}

export interface GitHubProjectMembership {
  itemId: string;
  status: string | null;
  statusOptionId: string | null;
}

interface ProjectItemNode {
  id: string;
  content?: GitHubProjectIssueContent | { __typename: string } | null;
  project?: { id: string };
  fieldValueByName?: { name: string; optionId: string; field?: { id: string } } | null;
}

interface PageInfo {
  hasNextPage: boolean;
  endCursor: string | null;
}

const projectPageSize = 100;
const projectMaxPages = 10;

function sameName(left: string, right: string): boolean {
  return left.localeCompare(right, undefined, { sensitivity: "accent" }) === 0;
}

function issueItem(
  node: ProjectItemNode,
  expectedStatusFieldId: string,
): GitHubProjectIssueItem | undefined {
  if (node.content?.__typename !== "Issue") return undefined;
  if (
    node.fieldValueByName?.field?.id &&
    node.fieldValueByName.field.id !== expectedStatusFieldId
  ) {
    throw new ProjectContextError(
      "GITHUB_PROJECT_STATUS_FIELD_MISMATCH",
      "Configured GitHub Project Status field identity does not match",
    );
  }

  return {
    id: node.id,
    content: node.content as GitHubProjectIssueContent,
    status: node.fieldValueByName?.name ?? null,
    statusOptionId: node.fieldValueByName?.optionId ?? null,
  };
}

export class GitHubProjectClient {
  readonly #baseUrl = "https://api.github.com";

  constructor(
    private readonly target: GitHubProjectTarget,
    private readonly token: string,
    private readonly fetcher: typeof fetch,
  ) {}

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
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json",
          "X-GitHub-Api-Version": "2022-11-28",
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

  async #collectIssueItems(
    repositoryNameWithOwner: string,
    cursor: string | null = null,
    page = 1,
    collected: GitHubProjectIssueItem[] = [],
  ): Promise<{ items: GitHubProjectIssueItem[]; truncated: boolean }> {
    const data = await this.#graphql<{
      node: {
        items: { nodes: ProjectItemNode[]; pageInfo: PageInfo };
      } | null;
    }>(
      `query ProjectItems(
        $projectId: ID!
        $first: Int!
        $after: String
        $statusFieldName: String!
      ) {
        node(id: $projectId) {
          ... on ProjectV2 {
            items(first: $first, after: $after) {
              nodes {
                id
                content {
                  __typename
                  ... on Issue {
                    id databaseId number title body state stateReason url updatedAt createdAt
                    repository { nameWithOwner }
                    author { login ... on User { databaseId } }
                    assignees(first: 1) { nodes { login databaseId } }
                    labels(first: 100) { nodes { name } }
                  }
                }
                fieldValueByName(name: $statusFieldName) {
                  ... on ProjectV2ItemFieldSingleSelectValue {
                    name optionId
                    field { ... on ProjectV2SingleSelectField { id } }
                  }
                }
              }
              pageInfo { hasNextPage endCursor }
            }
          }
        }
      }`,
      {
        projectId: this.target.id,
        first: projectPageSize,
        after: cursor,
        statusFieldName: this.target.status_field.name,
      },
      "read",
    );
    if (!data.node) {
      throw new ProjectContextError(
        "GITHUB_PROJECT_NOT_FOUND",
        "Configured GitHub Project was not found",
      );
    }

    const matching = data.node.items.nodes
      .flatMap((node) => {
        const item = issueItem(node, this.target.status_field.id);

        return item ? [item] : [];
      })
      .filter((item) => sameName(item.content.repository.nameWithOwner, repositoryNameWithOwner));
    const items = [...collected, ...matching];
    const pageInfo = data.node.items.pageInfo;
    const pageBoundReached = page >= projectMaxPages;

    if (!pageInfo.hasNextPage || pageBoundReached) {
      return { items, truncated: pageInfo.hasNextPage && pageBoundReached };
    }

    return this.#collectIssueItems(repositoryNameWithOwner, pageInfo.endCursor, page + 1, items);
  }

  collectIssueItems(
    repositoryNameWithOwner: string,
  ): Promise<{ items: GitHubProjectIssueItem[]; truncated: boolean }> {
    return this.#collectIssueItems(repositoryNameWithOwner);
  }

  async #findMembership(
    issueNodeId: string,
    cursor: string | null = null,
    page = 1,
  ): Promise<GitHubProjectMembership | undefined> {
    const data = await this.#graphql<{
      node: {
        projectItems: { nodes: ProjectItemNode[]; pageInfo: PageInfo };
      } | null;
    }>(
      `query IssueProjectItems(
        $issueId: ID!
        $first: Int!
        $after: String
        $statusFieldName: String!
      ) {
        node(id: $issueId) {
          ... on Issue {
            projectItems(first: $first, after: $after) {
              nodes {
                id
                project { id }
                fieldValueByName(name: $statusFieldName) {
                  ... on ProjectV2ItemFieldSingleSelectValue {
                    name optionId
                    field { ... on ProjectV2SingleSelectField { id } }
                  }
                }
              }
              pageInfo { hasNextPage endCursor }
            }
          }
        }
      }`,
      {
        issueId: issueNodeId,
        first: projectPageSize,
        after: cursor,
        statusFieldName: this.target.status_field.name,
      },
      "read",
    );
    const projectItems = data.node?.projectItems;
    const match = projectItems?.nodes.find((item) => item.project?.id === this.target.id);
    if (match) {
      if (
        match.fieldValueByName?.field?.id &&
        match.fieldValueByName.field.id !== this.target.status_field.id
      ) {
        throw new ProjectContextError(
          "GITHUB_PROJECT_STATUS_FIELD_MISMATCH",
          "Configured GitHub Project Status field identity does not match",
        );
      }
      return {
        itemId: match.id,
        status: match.fieldValueByName?.name ?? null,
        statusOptionId: match.fieldValueByName?.optionId ?? null,
      };
    }
    if (!projectItems?.pageInfo.hasNextPage || page >= projectMaxPages) return undefined;

    return this.#findMembership(issueNodeId, projectItems.pageInfo.endCursor, page + 1);
  }

  membership(issueNodeId: string): Promise<GitHubProjectMembership | undefined> {
    return this.#findMembership(issueNodeId);
  }

  async add(issueNodeId: string): Promise<GitHubProjectMembership> {
    const data = await this.#graphql<{
      addProjectV2ItemById: { item: { id: string } | null };
    }>(
      `mutation AddProjectV2Item($projectId: ID!, $contentId: ID!) {
        addProjectV2ItemById(input: { projectId: $projectId, contentId: $contentId }) {
          item { id }
        }
      }`,
      { projectId: this.target.id, contentId: issueNodeId },
      "write",
    );
    const itemId = data.addProjectV2ItemById.item?.id;
    if (!itemId) {
      throw new ProjectContextError(
        "GITHUB_PROJECT_ADD_FAILED",
        "GitHub issue could not be added to the configured Project",
      );
    }

    return { itemId, status: null, statusOptionId: null };
  }

  async updateStatus(itemId: string, nativeStatus: string): Promise<string> {
    const data = await this.#graphql<{
      node: {
        field: {
          id: string;
          name: string;
          options: Array<{ id: string; name: string }>;
        } | null;
      } | null;
    }>(
      `query ProjectStatusOptions($projectId: ID!, $statusFieldName: String!) {
        node(id: $projectId) {
          ... on ProjectV2 {
            field(name: $statusFieldName) {
              ... on ProjectV2SingleSelectField { id name options { id name } }
            }
          }
        }
      }`,
      { projectId: this.target.id, statusFieldName: this.target.status_field.name },
      "read",
    );
    const field = data.node?.field;
    if (!field || field.id !== this.target.status_field.id) {
      throw new ProjectContextError(
        "GITHUB_PROJECT_STATUS_FIELD_MISMATCH",
        "Configured GitHub Project Status field identity does not match",
      );
    }
    const matches = field.options.filter((option) => sameName(option.name, nativeStatus));
    if (matches.length !== 1) {
      throw new ProjectContextError(
        "GITHUB_PROJECT_STATUS_AMBIGUOUS",
        `GitHub Project status ${nativeStatus} resolved to ${matches.length} options`,
      );
    }
    const optionId = matches[0]?.id;
    if (!optionId) {
      throw new ProjectContextError(
        "GITHUB_PROJECT_STATUS_AMBIGUOUS",
        `GitHub Project status ${nativeStatus} did not resolve to an option`,
      );
    }

    const update = await this.#graphql<{
      updateProjectV2ItemFieldValue: { projectV2Item: { id: string } | null };
    }>(
      `mutation UpdateProjectV2ItemStatus(
        $projectId: ID!
        $itemId: ID!
        $fieldId: ID!
        $optionId: String!
      ) {
        updateProjectV2ItemFieldValue(input: {
          projectId: $projectId
          itemId: $itemId
          fieldId: $fieldId
          value: { singleSelectOptionId: $optionId }
        }) {
          projectV2Item { id }
        }
      }`,
      {
        projectId: this.target.id,
        itemId,
        fieldId: field.id,
        optionId,
      },
      "write",
    );
    if (!update.updateProjectV2ItemFieldValue.projectV2Item) {
      throw new ProjectContextError(
        "GITHUB_PROJECT_STATUS_UPDATE_FAILED",
        "GitHub Project status update failed",
      );
    }

    return optionId;
  }
}
