import { ProjectContextError } from "../core/errors.ts";
import type { JiraProjectProvider, JiraProviderProfile } from "../core/types.ts";
import { requestJson, versionOf } from "./http.ts";
import type {
  IssueCreateInput,
  IssueProviderAdapter,
  IssueSnapshot,
  IssueUpdateInput,
  ProviderIdentity,
} from "./types.ts";

interface JiraIssue {
  id: string;
  key: string;
  self: string;
  fields: {
    summary: string;
    description?: unknown;
    status: { name: string };
    updated: string;
    labels?: string[];
  };
}

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
      url: `${this.#baseUrl}/browse/${issue.key}`,
      updatedAt: issue.fields.updated,
      version: versionOf(issue.fields.updated, issue.id),
    };
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

  async search(query: string, limit = 30): Promise<IssueSnapshot[]> {
    const jql = `project = "${this.target.project.id.replaceAll('"', '\\"')}" AND text ~ "${query.replaceAll('"', '\\"')}" ORDER BY updated DESC`;
    const data = await this.#request<{ issues: JiraIssue[] }>(
      "/rest/api/3/search/jql",
      "POST",
      {
        jql,
        maxResults: limit,
        fields: ["summary", "description", "status", "updated", "labels"],
      },
      "read",
    );
    return data.issues.map((issue) => this.#snapshot(issue));
  }

  async get(identifier: string): Promise<IssueSnapshot> {
    return this.#snapshot(
      await this.#request<JiraIssue>(
        `/rest/api/3/issue/${encodeURIComponent(identifier)}?fields=summary,description,status,updated,labels`,
      ),
    );
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
