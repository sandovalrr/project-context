export default {
  branches: ["main"],
  // biome-ignore lint/suspicious/noTemplateCurlyInString: semantic-release expands this placeholder.
  tagFormat: "v${version}",
  plugins: [
    ["./scripts/release-analyzer.mjs", { preset: "conventionalcommits" }],
    ["@semantic-release/release-notes-generator", { preset: "conventionalcommits" }],
    ["@semantic-release/changelog", { changelogFile: "CHANGELOG.md" }],
    "./scripts/release-prepare.mjs",
    [
      "@semantic-release/github",
      {
        draftRelease: true,
        successComment: false,
        failComment: false,
        assets: [
          { path: "release/*.tgz", label: "Exact npm package tarball" },
          { path: "release/*.sbom.cdx.json", label: "CycloneDX JSON SBOM" },
          { path: "release/*.sha256", label: "SHA-256 checksums" },
        ],
      },
    ],
  ],
};
