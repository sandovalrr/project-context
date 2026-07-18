import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { promisify } from "node:util";

const executeFile = promisify(execFile);
const directory = await mkdtemp(join(tmpdir(), "project-context-pack-"));

try {
  await mkdir(directory, { recursive: true });
  const packed = await executeFile(
    "npm",
    ["pack", "--json", "--ignore-scripts", "--pack-destination", directory],
    { maxBuffer: 16 * 1024 * 1024 },
  );
  const result = JSON.parse(packed.stdout)[0];
  if (!result?.filename) throw new Error("npm pack did not report a tarball filename");

  await executeFile(
    process.execPath,
    ["scripts/test-package.mjs", relative(process.cwd(), join(directory, result.filename))],
    {
      stdio: "inherit",
    },
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
