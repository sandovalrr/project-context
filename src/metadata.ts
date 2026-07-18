import packageMetadata from "../package.json" with { type: "json" };

export const PACKAGE_NAME = packageMetadata.name;
export const PACKAGE_VERSION = packageMetadata.version;
export const SERVER_NAME = "project-context";

export function setupCommand(): string {
  return `npx -y --package=${PACKAGE_NAME}@${PACKAGE_VERSION} project-context setup`;
}
