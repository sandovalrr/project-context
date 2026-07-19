import type { IssueFieldCapability, IssueFieldName, IssueFieldOperation } from "./types.ts";

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
