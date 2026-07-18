import { ProjectContextError } from "./errors.ts";
import type { ProjectConfig, ProjectProvider, ProjectsConfig } from "./types.ts";

export interface ProviderRoute {
  alias: string;
  provider: ProjectProvider;
  reference?: string;
  reason: "explicit" | "url" | "qualified" | "identifier-pattern" | "default";
}

function select(
  project: ProjectConfig,
  alias: string,
  reason: ProviderRoute["reason"],
  reference?: string,
) {
  const provider = project.issues.providers[alias];
  if (!provider) {
    throw new ProjectContextError(
      "PROVIDER_NOT_CONFIGURED",
      `Issue provider ${alias} is not configured for this repository`,
    );
  }
  return { alias, provider, reason, ...(reference === undefined ? {} : { reference }) };
}

function uniqueRoute(
  matches: Array<{ alias: string; provider: ProjectProvider }>,
  reason: ProviderRoute["reason"],
  reference: string,
): ProviderRoute | undefined {
  if (matches.length > 1) {
    throw new ProjectContextError(
      "PROVIDER_ROUTE_AMBIGUOUS",
      `Reference ${reference} matches multiple configured issue providers: ${matches
        .map((match) => match.alias)
        .join(", ")}`,
    );
  }
  const match = matches[0];
  return match ? { ...match, reason, reference } : undefined;
}

function referenceFromUrl(url: URL, provider: ProjectProvider): string {
  if (provider.type === "github") {
    const number = /\/issues\/(\d+)/.exec(url.pathname)?.[1];
    return number ? `#${number}` : url.toString();
  }
  if (provider.type === "jira-cloud") {
    return /\/browse\/([^/]+)/.exec(url.pathname)?.[1] ?? url.toString();
  }
  return /\/issue\/([^/]+)/.exec(url.pathname)?.[1] ?? url.toString();
}

function urlMatches(
  url: URL,
  provider: ProjectProvider,
  profiles: ProjectsConfig["providers"],
): boolean {
  const profile = profiles[provider.profile];
  if (!profile) return false;
  if (provider.type === "linear" && profile.type === "linear") return url.hostname === "linear.app";
  if (provider.type === "jira-cloud" && profile.type === "jira-cloud") {
    return url.hostname === profile.expected_identity.site;
  }
  if (provider.type !== "github" || profile.type !== "github") return false;
  if (url.hostname !== profile.expected_identity.host) return false;
  if (!url.pathname.includes("/issues/")) return false;
  if (provider.target.repository === "inherit") return true;
  const prefix = `/${provider.target.repository.owner}/${provider.target.repository.name}/issues/`;
  return url.pathname.startsWith(prefix);
}

export function routeIssueProvider(
  project: ProjectConfig,
  profiles: ProjectsConfig["providers"],
  options: { explicitProvider?: string; reference?: string } = {},
): ProviderRoute {
  if (options.explicitProvider) {
    return select(project, options.explicitProvider, "explicit", options.reference);
  }

  const reference = options.reference?.trim();
  if (reference) {
    try {
      const url = new URL(reference);
      if (url.protocol === "https:" || url.protocol === "http:") {
        const matches = Object.entries(project.issues.providers)
          .filter(([, provider]) => urlMatches(url, provider, profiles))
          .map(([alias, provider]) => ({ alias, provider }));
        const route = uniqueRoute(matches, "url", reference);
        if (route) return { ...route, reference: referenceFromUrl(url, route.provider) };
        throw new ProjectContextError(
          "URL_PROVIDER_NOT_CONFIGURED",
          `URL ${reference} does not match a configured issue provider`,
        );
      }
    } catch (error) {
      if (error instanceof ProjectContextError) throw error;
    }

    const qualified = /^([a-z][a-z0-9-]*):(.*)$/i.exec(reference);
    if (qualified?.[1] && qualified[2]) {
      const prefix = qualified[1].toLowerCase();
      const aliases = Object.entries(project.issues.providers).filter(([alias, provider]) => {
        if (alias === prefix) return true;
        if (prefix === "jira") return provider.type === "jira-cloud";
        return provider.type === prefix;
      });
      const route = uniqueRoute(
        aliases.map(([alias, provider]) => ({ alias, provider })),
        "qualified",
        qualified[2],
      );
      if (route) return route;
      throw new ProjectContextError(
        "QUALIFIED_PROVIDER_NOT_CONFIGURED",
        `Qualified provider ${prefix} is not uniquely configured for this repository`,
      );
    }

    const patternMatches = Object.entries(project.issues.providers)
      .filter(([, provider]) =>
        (provider.identifiers ?? []).some((pattern) => new RegExp(pattern).test(reference)),
      )
      .map(([alias, provider]) => ({ alias, provider }));
    const route = uniqueRoute(patternMatches, "identifier-pattern", reference);
    if (route) return route;
  }

  return select(project, project.issues.default, "default", reference);
}
