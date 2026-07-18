import { ProjectContextError } from "./errors.ts";

export async function promptHidden(label: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY || !process.stdin.setRawMode) {
    throw new ProjectContextError(
      "INTERACTIVE_TERMINAL_REQUIRED",
      "A TTY is required for secret entry; secrets are never accepted as command-line arguments",
    );
  }

  process.stdout.write(label);
  process.stdin.setEncoding("utf8");
  process.stdin.setRawMode(true);
  process.stdin.resume();

  return new Promise<string>((resolve, reject) => {
    let value = "";
    const cleanup = () => {
      process.stdin.off("data", onData);
      process.stdin.setRawMode?.(false);
      process.stdin.pause();
      process.stdout.write("\n");
    };
    const onData = (chunk: string | Buffer) => {
      const text = chunk.toString();
      for (const character of text) {
        if (character === "\u0003") {
          cleanup();
          reject(new ProjectContextError("PROMPT_CANCELED", "Secret entry canceled"));
          return;
        }
        if (character === "\r" || character === "\n") {
          cleanup();
          resolve(value);
          return;
        }
        if (character === "\u007f" || character === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        if (character >= " ") value += character;
      }
    };
    process.stdin.on("data", onData);
  });
}
