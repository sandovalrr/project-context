import { ProjectContextError } from "../core/errors.ts";

export async function requestJson<T>(
  fetcher: typeof fetch,
  url: string,
  init: RequestInit,
): Promise<T> {
  const response = await fetcher(url, init).catch((error) => {
    throw new ProjectContextError("PROVIDER_NETWORK_ERROR", `Provider request failed: ${url}`, {
      cause: error,
    });
  });

  if (!response.ok) {
    throw new ProjectContextError(
      "PROVIDER_HTTP_ERROR",
      `Provider request failed: ${init.method ?? "GET"} ${url} returned ${response.status}`,
    );
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export function versionOf(updatedAt: string, id: string): string {
  return `${id}:${updatedAt}`;
}
