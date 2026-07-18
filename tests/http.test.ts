import { describe, expect, mock, test } from "bun:test";
import { requestJson } from "../src/providers/http.ts";

const readPolicy = {
  provider: "Example",
  allowedOrigin: "https://api.example.test",
  access: "read" as const,
};

function asFetch(fetcher: () => Promise<Response>): typeof fetch {
  return fetcher as unknown as typeof fetch;
}

function responseSequence(responses: Response[]): typeof fetch {
  const sequence = responses.values();
  return asFetch(async () => {
    const next = sequence.next();
    if (next.done) throw new Error("No response remains in the test sequence");
    return next.value;
  });
}

describe("provider HTTP safety", () => {
  test("rejects non-HTTPS and unapproved provider origins before sending credentials", async () => {
    const fetcher = mock(async () => new Response("{}")) as unknown as typeof fetch;

    await expect(
      requestJson(fetcher, "http://api.example.test/issues", {}, readPolicy),
    ).rejects.toThrow("approved HTTPS origin");
    await expect(
      requestJson(fetcher, "https://attacker.example/issues", {}, readPolicy),
    ).rejects.toThrow("approved HTTPS origin");
    expect(fetcher).not.toHaveBeenCalled();
  });

  test("retries transient reads but never retries writes", async () => {
    const readFetcher = mock(
      responseSequence([
        new Response("unavailable", { status: 503, headers: { "Retry-After": "0" } }),
        new Response('{"ok":true}', { status: 200 }),
      ]),
    ) as unknown as typeof fetch;

    await expect(
      requestJson(readFetcher, "https://api.example.test/issues", {}, readPolicy),
    ).resolves.toEqual({ ok: true });
    expect(readFetcher).toHaveBeenCalledTimes(2);

    const writeFetcher = mock(
      responseSequence([
        new Response("unavailable", { status: 503 }),
        new Response('{"ok":true}', { status: 200 }),
      ]),
    ) as unknown as typeof fetch;
    await expect(
      requestJson(
        writeFetcher,
        "https://api.example.test/issues",
        { method: "POST" },
        { ...readPolicy, access: "write" },
      ),
    ).rejects.toThrow("returned 503");
    expect(writeFetcher).toHaveBeenCalledTimes(1);
  });

  test("limits response size and redacts request details from errors", async () => {
    const largeFetcher = asFetch(
      async () =>
        new Response("{}", {
          headers: { "Content-Length": String(2 * 1024 * 1024 + 1) },
        }),
    );
    await expect(
      requestJson(
        largeFetcher,
        "https://api.example.test/issues?q=sensitive-query",
        {},
        readPolicy,
      ),
    ).rejects.toThrow("response exceeded");

    const failedFetcher = asFetch(
      async () => new Response('{"token":"sensitive-body"}', { status: 400 }),
    );
    try {
      await requestJson(
        failedFetcher,
        "https://api.example.test/issues?q=sensitive-query",
        {},
        readPolicy,
      );
      throw new Error("expected provider failure");
    } catch (error) {
      expect(String(error)).not.toContain("sensitive-query");
      expect(String(error)).not.toContain("sensitive-body");
      expect(String(error)).toContain("Example GET returned 400");
    }
  });
});
