import type { ProviderType, StatusMatch } from "../core/types.ts";

export interface ProviderIdentity {
  provider: ProviderType;
  principalId: string;
  principalName: string;
  scopeId: string;
  scopeName: string;
}

export interface IssueSnapshot {
  provider: ProviderType;
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  status: string;
  labels: string[];
  url: string;
  updatedAt: string;
  version: string;
}

export interface IssueCreateInput {
  title: string;
  description?: string;
  labels?: string[];
  assignee?: string;
  priority?: string | number;
  issueType?: string;
}

export interface IssueUpdateInput {
  title?: string;
  description?: string;
  labels?: string[];
  assignee?: string | null;
  priority?: string | number;
}

export interface IssueListOptions {
  matches?: StatusMatch[];
  limit?: number;
}

export interface IssueListResult {
  issues: IssueSnapshot[];
  truncated: boolean;
}

export interface IssueProviderAdapter {
  readonly type: ProviderType;
  identity(): Promise<ProviderIdentity>;
  list(options?: IssueListOptions): Promise<IssueListResult>;
  search(query: string, limit?: number): Promise<IssueSnapshot[]>;
  get(identifier: string): Promise<IssueSnapshot>;
  create(input: IssueCreateInput): Promise<IssueSnapshot>;
  update(identifier: string, input: IssueUpdateInput): Promise<IssueSnapshot>;
  comment(identifier: string, body: string): Promise<void>;
  transition(identifier: string, nativeStatus: string): Promise<IssueSnapshot>;
  link(identifier: string, targetUrl: string): Promise<void>;
}
