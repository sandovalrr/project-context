import { createInterface } from "node:readline/promises";
import { ProjectContextError } from "./errors.ts";

type PromptInputResult =
  | { kind: "continue"; value: string }
  | { kind: "submit"; value: string }
  | { kind: "cancel" };

function consumePromptInput(input: string, value: string): PromptInputResult {
  const character = input.at(0);
  if (character === undefined) return { kind: "continue", value };
  if (character === "\u0003") return { kind: "cancel" };
  if (character === "\r" || character === "\n") return { kind: "submit", value };

  const remaining = input.slice(character.length);
  const nextValue =
    character === "\u007f" || character === "\b"
      ? value.slice(0, -1)
      : character >= " "
        ? `${value}${character}`
        : value;

  return consumePromptInput(remaining, nextValue);
}

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
    const cleanup = () => {
      process.stdin.setRawMode?.(false);
      process.stdin.pause();
      process.stdout.write("\n");
    };

    const listen = (value: string) => {
      process.stdin.once("data", (chunk: string | Buffer) => {
        const result = consumePromptInput(chunk.toString(), value);

        if (result.kind === "cancel") {
          cleanup();
          reject(new ProjectContextError("PROMPT_CANCELED", "Secret entry canceled"));
          return;
        }

        if (result.kind === "submit") {
          cleanup();
          resolve(result.value);
          return;
        }

        listen(result.value);
      });
    };

    listen("");
  });
}

export async function promptVisible(label: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new ProjectContextError(
      "INTERACTIVE_TERMINAL_REQUIRED",
      "A TTY is required for guided setup; use project-context setup for non-interactive setup",
    );
  }

  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await prompt.question(label)).trim();
    if (!answer)
      throw new ProjectContextError("PROMPT_VALUE_REQUIRED", `${label.trim()} is required`);
    return answer;
  } finally {
    prompt.close();
  }
}
