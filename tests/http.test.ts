import { describe, expect, test } from "bun:test";
import { requestJson } from "../src/providers/http.ts";

const readPolicy = {
  provider: "Example",
  allowedOrigin: "https://api.example.test",
  access: "read" as const,
};

function asFetch(fetcher: () => Promise<Response>): typeof fetch {
  return fetcher as unknown as typeof fetch;
}

describe("provider HTTP safety", () => {
  test("rejects non-HTTPS and unapproved provider origins before sending credentials", async () => {
    const requests: string[] = [];
    const fetcher = (async (url: string | URL | Request) => {
      requests.push(String(url));
      return new Response("{}");
    }) as typeof fetch;

    await expect(
      requestJson(fetcher, "http://api.example.test/issues", {}, readPolicy),
    ).rejects.toThrow("approved HTTPS origin");
    await expect(
      requestJson(fetcher, "https://attacker.example/issues", {}, readPolicy),
    ).rejects.toThrow("approved HTTPS origin");
    expect(requests).toEqual([]);
  });

  test("retries transient reads but never retries writes", async () => {
    const readResponses = [
      new Response("unavailable", { status: 503, headers: { "Retry-After": "0" } }),
      new Response('{"ok":true}', { status: 200 }),
    ];
    const readFetcher = asFetch(async () => readResponses.shift() as Response);

    await expect(
      requestJson(readFetcher, "https://api.example.test/issues", {}, readPolicy),
    ).resolves.toEqual({ ok: true });
    expect(readResponses).toHaveLength(0);

    const writeResponses = [
      new Response("unavailable", { status: 503 }),
      new Response('{"ok":true}', { status: 200 }),
    ];
    const writeFetcher = asFetch(async () => writeResponses.shift() as Response);
    await expect(
      requestJson(
        writeFetcher,
        "https://api.example.test/issues",
        { method: "POST" },
        { ...readPolicy, access: "write" },
      ),
    ).rejects.toThrow("returned 503");
    expect(writeResponses).toHaveLength(1);
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
