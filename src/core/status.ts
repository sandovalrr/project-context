import type { IssueSnapshot } from "../providers/types.ts";
import { ProjectContextError } from "./errors.ts";
import {
  CANONICAL_STATUSES,
  type CanonicalStatus,
  type CanonicalStatusFilter,
  type ProjectProvider,
  type StatusMapping,
  type StatusMatch,
} from "./types.ts";

function sameName(left: string, right: string): boolean {
  return left.localeCompare(right, undefined, { sensitivity: "accent" }) === 0;
}

function derivedMatch(mapping: StatusMapping): StatusMatch {
  if (typeof mapping === "string") {
    return { state: mapping, labelsAll: [], labelsNone: [] };
  }
  if (mapping.match) {
    return {
      ...(mapping.match.state ? { state: mapping.match.state } : {}),
      ...(mapping.match.states ? { states: mapping.match.states } : {}),
      labelsAll: mapping.match.labels_all ?? [],
      labelsNone: mapping.match.labels_none ?? [],
    };
  }
  return {
    ...(mapping.state ? { state: mapping.state } : {}),
    labelsAll: mapping.add_labels ?? [],
    labelsNone: mapping.remove_labels ?? [],
  };
}

function configuredStatusFilters(provider: ProjectProvider): CanonicalStatusFilter[] {
  return CANONICAL_STATUSES.flatMap((canonicalStatus) => {
    const mapping = provider.mappings?.status?.[canonicalStatus];

    return mapping ? [{ canonicalStatus, match: derivedMatch(mapping) }] : [];
  });
}

function matchingStates(match: StatusMatch): string[] | undefined {
  return match.states ?? (match.state ? [match.state] : undefined);
}

function statesOverlap(left: StatusMatch, right: StatusMatch): boolean {
  const leftStates = matchingStates(left);
  const rightStates = matchingStates(right);

  return (
    leftStates === undefined ||
    rightStates === undefined ||
    leftStates.some((state) => containsName(rightStates, state))
  );
}

function containsName(names: string[], candidate: string): boolean {
  return names.some((name) => sameName(name, candidate));
}

function predicatesOverlap(left: StatusMatch, right: StatusMatch): boolean {
  const labelConflict =
    left.labelsAll.some((label) => containsName(right.labelsNone, label)) ||
    right.labelsAll.some((label) => containsName(left.labelsNone, label));

  return statesOverlap(left, right) && !labelConflict;
}

function overlappingPairs(
  filters: CanonicalStatusFilter[],
): Array<[CanonicalStatus, CanonicalStatus]> {
  return filters.flatMap((left, index) =>
    filters
      .slice(index + 1)
      .flatMap((right) =>
        predicatesOverlap(left.match, right.match)
          ? [[left.canonicalStatus, right.canonicalStatus] as [CanonicalStatus, CanonicalStatus]]
          : [],
      ),
  );
}

function issueMatches(match: StatusMatch, issue: IssueSnapshot): boolean {
  const states = matchingStates(match);
  const stateMatches = states === undefined || containsName(states, issue.status);
  const includesLabels = match.labelsAll.every((label) => containsName(issue.labels, label));
  const excludesLabels = match.labelsNone.every((label) => !containsName(issue.labels, label));

  return stateMatches && includesLabels && excludesLabels;
}

function contradictoryLabel(match: StatusMatch): string | undefined {
  return match.labelsAll.find((label) => containsName(match.labelsNone, label));
}

export function resolveStatusFilters(
  provider: ProjectProvider,
  statuses: CanonicalStatus[],
): CanonicalStatusFilter[] {
  if (new Set(statuses).size !== statuses.length) {
    throw new ProjectContextError(
      "STATUS_FILTER_DUPLICATE",
      "Canonical status filters must be unique",
    );
  }

  const filters = configuredStatusFilters(provider);
  const requested = statuses.map((canonicalStatus) => {
    const filter = filters.find((candidate) => candidate.canonicalStatus === canonicalStatus);
    if (filter) {
      const contradictory = contradictoryLabel(filter.match);
      if (!contradictory) return filter;

      throw new ProjectContextError(
        "STATUS_FILTER_INVALID",
        `Canonical status ${canonicalStatus} requires and excludes label ${contradictory}`,
      );
    }

    throw new ProjectContextError(
      "STATUS_MAPPING_MISSING",
      `No ${canonicalStatus} status mapping is configured for ${provider.type}`,
    );
  });
  const ambiguous = overlappingPairs(filters).find(([left, right]) =>
    statuses.some((status) => status === left || status === right),
  );
  if (ambiguous) {
    throw new ProjectContextError(
      "STATUS_FILTER_AMBIGUOUS",
      `Canonical status ${ambiguous[0]} cannot be filtered unambiguously because it overlaps ${ambiguous[1]}; configure explicit match predicates`,
    );
  }

  return requested;
}

export function classifyCanonicalStatus(
  provider: ProjectProvider,
  issue: IssueSnapshot,
): CanonicalStatus | null {
  const matches = configuredStatusFilters(provider).filter((filter) =>
    issueMatches(filter.match, issue),
  );

  return matches.length === 1 ? (matches[0]?.canonicalStatus ?? null) : null;
}

export function statusFilterWarnings(provider: ProjectProvider): string[] {
  const filters = configuredStatusFilters(provider);
  const configured = new Set(filters.map((filter) => filter.canonicalStatus));
  const missing = CANONICAL_STATUSES.filter((status) => !configured.has(status)).map(
    (status) => `${status} has no mapping`,
  );
  const invalid = filters.flatMap((filter) => {
    const contradictory = contradictoryLabel(filter.match);

    return contradictory
      ? [`${filter.canonicalStatus} requires and excludes label ${contradictory}`]
      : [];
  });
  const ambiguous = overlappingPairs(filters).map(([left, right]) => `${left} overlaps ${right}`);

  return [...missing, ...invalid, ...ambiguous];
}
