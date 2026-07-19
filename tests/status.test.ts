import { describe, expect, test } from "bun:test";
import {
  classifyCanonicalStatus,
  resolveStatusFilters,
  statusFilterWarnings,
} from "../src/core/status.ts";
import type { GitHubProjectProvider } from "../src/core/types.ts";
import type { IssueSnapshot } from "../src/providers/types.ts";

const issue: IssueSnapshot = {
  provider: "github",
  id: "1",
  identifier: "#1",
  title: "Example",
  description: null,
  status: "open",
  labels: ["in-progress"],
  url: "https://github.com/example/repository/issues/1",
  updatedAt: "2026-07-19T12:00:00Z",
  version: "1:2026-07-19T12:00:00Z",
};

function provider(
  status: NonNullable<NonNullable<GitHubProjectProvider["mappings"]>["status"]>,
): GitHubProjectProvider {
  return {
    type: "github",
    profile: "github-example",
    target: { repository: "inherit" },
    mappings: { status },
  };
}

describe("canonical status filters", () => {
  test("derives read predicates from strings and transition label actions", () => {
    const configured = provider({
      in_progress: { state: "open", add_labels: ["in-progress"], remove_labels: ["blocked"] },
    });

    expect(resolveStatusFilters(configured, ["in_progress"])).toEqual([
      {
        canonicalStatus: "in_progress",
        match: {
          state: "open",
          labelsAll: ["in-progress"],
          labelsNone: ["blocked"],
        },
      },
    ]);
  });

  test("uses an explicit match instead of the derived transition predicate", () => {
    const configured = provider({
      in_progress: {
        state: "open",
        add_labels: ["workflow-transition-label"],
        match: {
          state: "open",
          labels_all: ["doing"],
          labels_none: ["paused"],
        },
      },
    });

    expect(resolveStatusFilters(configured, ["in_progress"])[0]?.match).toEqual({
      state: "open",
      labelsAll: ["doing"],
      labelsNone: ["paused"],
    });
  });

  test("fails closed for missing and ambiguous requested mappings", () => {
    expect(() => resolveStatusFilters(provider({ open: "open" }), ["done"])).toThrow(
      "No done status mapping",
    );

    const ambiguous = provider({ open: "open", in_progress: { state: "open" } });
    expect(() => resolveStatusFilters(ambiguous, ["open"])).toThrow(
      "cannot be filtered unambiguously",
    );
  });

  test("classifies exact matches and returns null for ambiguous or unmapped issues", () => {
    const explicit = provider({
      open: { match: { state: "open", labels_none: ["in-progress"] } },
      in_progress: { match: { state: "open", labels_all: ["in-progress"] } },
    });
    const ambiguous = provider({ open: "open", in_progress: { state: "open" } });

    expect(classifyCanonicalStatus(explicit, issue)).toBe("in_progress");
    expect(classifyCanonicalStatus(ambiguous, issue)).toBeNull();
    expect(classifyCanonicalStatus(provider({ done: "closed" }), issue)).toBeNull();
  });

  test("reports actionable ambiguity and missing-mapping diagnostics", () => {
    const warnings = statusFilterWarnings(provider({ open: "open", in_progress: "open" }));

    expect(warnings).toContain("open overlaps in_progress");
    expect(warnings).toContain("done has no mapping");
    expect(warnings).toContain("canceled has no mapping");
  });

  test("rejects contradictory label matches", () => {
    const contradictory = provider({
      open: { match: { state: "open", labels_all: ["blocked"], labels_none: ["BLOCKED"] } },
    });

    expect(() => resolveStatusFilters(contradictory, ["open"])).toThrow(
      "requires and excludes label blocked",
    );
    expect(statusFilterWarnings(contradictory)).toContain(
      "open requires and excludes label blocked",
    );
  });
});
