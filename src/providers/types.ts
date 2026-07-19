import type { ProviderType, StatusMatch } from "../core/types.ts";

export interface ProviderIdentity {
  provider: ProviderType;
  principalId: string;
  principalName: string;
  scopeId: string;
  scopeName: string;
}

export interface IssueUser {
  provider: ProviderType;
  id: string;
  displayName: string;
  username: string | null;
  email: string | null;
}

export interface IssueOption {
  value: string | number;
  label: string;
}

export type IssueOptionField = "labels" | "priority" | "issueType";

export interface IssueOptionListResult {
  options: IssueOption[];
  truncated: boolean;
}

export interface IssueComment {
  provider: ProviderType;
  id: string;
  body: string;
  author: IssueUser | null;
  createdAt: string;
  updatedAt: string;
  url: string | null;
}

export interface IssueCommentListResult {
  comments: IssueComment[];
  truncated: boolean;
}

export interface IssueSnapshot {
  provider: ProviderType;
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  status: string;
  labels: string[];
  assignee: AssignableUser | null;
  creator: IssueUser | null;
  priority: IssueOption | null;
  issueType: IssueOption | null;
  createdAt: string | null;
  dueDate: string | null;
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

export interface AssignableUser {
  provider: ProviderType;
  assignee: string;
  displayName: string;
  username: string | null;
  email: string | null;
  active: boolean;
}

export interface UserListResult {
  users: AssignableUser[];
  truncated: boolean;
}

export type IssueFieldName =
  | "title"
  | "description"
  | "labels"
  | "assignee"
  | "priority"
  | "issueType";

export type IssueFieldOperation = "create" | "update";

export interface IssueFieldCapability {
  field: IssueFieldName;
  operations: IssueFieldOperation[];
  requiredOnCreate: boolean;
  clearable: boolean;
  acceptsCustomValues: boolean;
  options: IssueOption[];
  optionsTruncated: boolean;
  defaultValue: string | number | null;
  discoveryTool: "search_users" | "search_issue_options" | null;
}

export interface ProviderIssueCapabilities {
  fields: IssueFieldCapability[];
}

export interface IssueProviderAdapter {
  readonly type: ProviderType;
  identity(): Promise<ProviderIdentity>;
  list(options?: IssueListOptions): Promise<IssueListResult>;
  search(query: string, limit?: number): Promise<IssueSnapshot[]>;
  listUsers(limit?: number): Promise<UserListResult>;
  searchUsers(query: string, limit?: number): Promise<UserListResult>;
  searchOptions(
    field: IssueOptionField,
    query: string,
    limit?: number,
  ): Promise<IssueOptionListResult>;
  capabilities(): Promise<ProviderIssueCapabilities>;
  get(identifier: string): Promise<IssueSnapshot>;
  listComments(identifier: string, limit?: number): Promise<IssueCommentListResult>;
  create(input: IssueCreateInput): Promise<IssueSnapshot>;
  update(identifier: string, input: IssueUpdateInput): Promise<IssueSnapshot>;
  comment(identifier: string, body: string): Promise<void>;
  transition(identifier: string, nativeStatus: string): Promise<IssueSnapshot>;
  link(identifier: string, targetUrl: string): Promise<void>;
}
