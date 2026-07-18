import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

export function absolutePath(path: string, base = process.cwd()): string {
  const expanded = expandHome(path);
  return isAbsolute(expanded) ? expanded : resolve(base, expanded);
}

export function getPaths() {
  const configDirectory = absolutePath(
    process.env.PROJECT_CONTEXT_CONFIG_DIR ?? "~/.agents/config/project-context",
  );
  const stateDirectory = absolutePath(
    process.env.PROJECT_CONTEXT_STATE_DIR ?? "~/.local/state/project-context",
  );

  return {
    configDirectory,
    projectsFile: join(configDirectory, "projects.yaml"),
    credentialsFile: join(configDirectory, "credentials.yaml"),
    templatesDirectory: join(configDirectory, "templates"),
    secretsDirectory: join(configDirectory, "secrets"),
    stateDirectory,
    backupsDirectory: join(stateDirectory, "backups"),
    pendingDirectory: join(stateDirectory, "pending"),
    previewKeyFile: join(stateDirectory, "preview.key"),
    auditFile: join(stateDirectory, "audit.jsonl"),
    lockFile: join(stateDirectory, "config.lock"),
  };
}
