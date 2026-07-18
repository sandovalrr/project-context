import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { getPaths } from "./paths.ts";

export interface AuditEvent {
  operation: string;
  outcome: "success" | "failure";
  repositoryId: string;
  providerAlias: string;
  providerType: string;
  identityId: string;
  issueIdentifier?: string;
  issueId?: string;
  errorCode?: string;
}

export async function appendAuditEvent(event: AuditEvent): Promise<void> {
  const path = getPaths().auditFile;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await appendFile(path, `${JSON.stringify({ timestamp: new Date().toISOString(), ...event })}\n`, {
    mode: 0o600,
  });
}
