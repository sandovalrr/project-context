import type {
  IssueFieldCapability,
  IssueFieldName,
  IssueFieldOperation,
  IssueOption,
  IssueOptionListResult,
} from "./types.ts";

function normalized(value: string | number): string {
  return String(value).trim().toLocaleLowerCase();
}

export function filterIssueOptions(
  options: IssueOption[],
  query: string,
  limit: number,
): IssueOptionListResult {
  const normalizedQuery = normalized(query);
  const matches = options.filter(
    (option) =>
      normalized(option.label).includes(normalizedQuery) ||
      normalized(option.value).includes(normalizedQuery),
  );

  return {
    options: matches.slice(0, limit),
    truncated: matches.length > limit,
  };
}

export function issueFieldCapability(
  field: IssueFieldName,
  operations: IssueFieldOperation[],
  overrides: Partial<Omit<IssueFieldCapability, "field" | "operations">> = {},
): IssueFieldCapability {
  return {
    field,
    operations,
    requiredOnCreate: field === "title" && operations.includes("create"),
    clearable: operations.includes("update") && ["description", "labels"].includes(field),
    acceptsCustomValues: field === "title" || field === "description",
    options: [],
    optionsTruncated: false,
    defaultValue: null,
    discoveryTool: null,
    ...overrides,
  };
}
