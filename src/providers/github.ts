import { ProjectContextError } from "../core/errors.ts";
import type { GitHubProjectProvider, GitHubProviderProfile } from "../core/types.ts";
import { requestJson, versionOf } from "./http.ts";
import type {
  IssueCreateInput,
  IssueProviderAdapter,
  IssueSnapshot,
  IssueUpdateInput,
  ProviderIdentity,
} from "./types.ts";

interface GitHubIssue {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: string;
  html_url: string;
  updated_at: string;
  labels?: Array<string | { name?: string }>;
  pull_request?: unknown;
}

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
    this.#baseUrl = profile.expected_identity.api_base_url ?? "https://api.github.com";
    if (target.repository === "inherit" && !inheritedRepository) {
      throw new Error("GitHub inherit target needs a repository");
    }
    this.#repository =
      target.repository === "inherit"
        ? (inheritedRepository as { owner: string; name: string })
        : target.repository;
  }

  #request<T>(path: string, method = "GET", body?: unknown): Promise<T> {
    return requestJson<T>(this.fetcher, `${this.#baseUrl}${path}`, {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${this.credential.token ?? ""}`,
        "X-GitHub-Api-Version": "2022-11-28",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  #issuePath(suffix = ""): string {
    return `/repos/${encodeURIComponent(this.#repository.owner)}/${encodeURIComponent(this.#repository.name)}/issues${suffix}`;
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

  async search(query: string, limit = 30): Promise<IssueSnapshot[]> {
    const result = await this.#request<{ items: GitHubIssue[] }>(
      `/search/issues?q=${encodeURIComponent(`${query} repo:${this.#repository.owner}/${this.#repository.name} is:issue`)}&per_page=${limit}`,
    );
    return result.items
      .filter((issue) => !issue.pull_request)
      .map((issue) => this.#snapshot(issue));
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
