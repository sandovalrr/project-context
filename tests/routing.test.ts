import { describe, expect, test } from "bun:test";
import { loadProjectsConfig } from "../src/core/config.ts";
import { routeIssueProvider } from "../src/core/routing.ts";

async function fixture() {
  const config = await loadProjectsConfig("examples/projects.example.yaml");
  const project = config.projects["github.com/example/example-repository"];
  if (!project) throw new Error("missing fixture");
  return { config, project };
}

describe("deterministic provider routing", () => {
  test("uses explicit provider before all other signals", async () => {
    const { config, project } = await fixture();
    const route = routeIssueProvider(project, config.providers, {
      explicitProvider: "github",
      reference: "ENG-1",
    });
    expect(route.alias).toBe("github");
    expect(route.reason).toBe("explicit");
  });

  test("routes qualified and configured identifier references", async () => {
    const { config, project } = await fixture();
    expect(
      routeIssueProvider(project, config.providers, { reference: "github:#12" }),
    ).toMatchObject({
      alias: "github",
      reason: "qualified",
      reference: "#12",
    });
    expect(routeIssueProvider(project, config.providers, { reference: "ENG-12" })).toMatchObject({
      alias: "linear",
      reason: "identifier-pattern",
    });
  });

  test("routes issue URLs and rejects unconfigured URLs", async () => {
    const { config, project } = await fixture();
    expect(
      routeIssueProvider(project, config.providers, {
        reference: "https://github.com/example/example-repository/issues/12",
      }).alias,
    ).toBe("github");
    expect(() =>
      routeIssueProvider(project, config.providers, {
        reference: "https://jira.example.net/browse/OPS-1",
      }),
    ).toThrow("does not match");
  });

  test("falls back only to the configured default", async () => {
    const { config, project } = await fixture();
    expect(
      routeIssueProvider(project, config.providers, { reference: "vague words" }),
    ).toMatchObject({
      alias: "linear",
      reason: "default",
    });
  });

  test("fails on ambiguous identifier patterns", async () => {
    const { config, project } = await fixture();
    const github = project.issues.providers.github;
    if (!github) throw new Error("missing fixture");
    github.identifiers = ["^ENG-[0-9]+$"];
    expect(() => routeIssueProvider(project, config.providers, { reference: "ENG-9" })).toThrow(
      "multiple configured",
    );
  });
});
