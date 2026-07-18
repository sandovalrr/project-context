import { ProjectContextError } from "../core/errors.ts";

export interface ProviderRequestPolicy {
  provider: string;
  allowedOrigin: string;
  access: "read" | "write";
}

const REQUEST_TIMEOUT_MS = 20_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_READ_ATTEMPTS = 3;
const MAX_RETRY_DELAY_MS = 2_000;
const RETRYABLE_STATUSES = new Set([429, 502, 503, 504]);

function methodOf(init: RequestInit): string {
  return (init.method ?? "GET").toUpperCase();
}

function assertApprovedOrigin(url: string, policy: ProviderRequestPolicy): URL {
  const target = new URL(url);
  if (target.protocol !== "https:" || target.origin !== new URL(policy.allowedOrigin).origin) {
    throw new ProjectContextError(
      "PROVIDER_ORIGIN_UNSAFE",
      `${policy.provider} credentials may only be sent to the approved HTTPS origin`,
    );
  }
  return target;
}

function safeRequestId(response: Response): string | undefined {
  const value =
    response.headers.get("x-github-request-id") ??
    response.headers.get("x-request-id") ??
    response.headers.get("atl-traceid");
  return value && /^[a-zA-Z0-9._:-]{1,100}$/.test(value) ? value : undefined;
}

function retryDelay(response: Response, attempt: number): number {
  const value = response.headers.get("retry-after");
  const seconds = value && /^\d+(?:\.\d+)?$/.test(value) ? Number(value) : undefined;
  const date = value && seconds === undefined ? Date.parse(value) : Number.NaN;
  const requested =
    seconds === undefined
      ? Number.isNaN(date)
        ? 100 * 2 ** attempt
        : Math.max(0, date - Date.now())
      : seconds * 1_000;
  return Math.min(requested, MAX_RETRY_DELAY_MS);
}

async function wait(milliseconds: number): Promise<void> {
  if (milliseconds === 0) return;
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function readBoundedBody(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  chunks: Uint8Array[] = [],
  total = 0,
): Promise<Uint8Array> {
  const next = await reader.read();
  if (next.done) return Buffer.concat(chunks, total);
  const nextTotal = total + next.value.byteLength;
  if (nextTotal > MAX_RESPONSE_BYTES) {
    await reader.cancel();
    throw new ProjectContextError(
      "PROVIDER_RESPONSE_TOO_LARGE",
      `Provider response exceeded ${MAX_RESPONSE_BYTES} bytes`,
    );
  }
  return readBoundedBody(reader, [...chunks, next.value], nextTotal);
}

async function responseJson<T>(response: Response): Promise<T> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new ProjectContextError(
      "PROVIDER_RESPONSE_TOO_LARGE",
      `Provider response exceeded ${MAX_RESPONSE_BYTES} bytes`,
    );
  }
  if (!response.body) return undefined as T;
  const body = new TextDecoder().decode(await readBoundedBody(response.body.getReader()));
  try {
    return JSON.parse(body) as T;
  } catch {
    throw new ProjectContextError(
      "PROVIDER_RESPONSE_INVALID",
      "Provider returned an invalid JSON response",
    );
  }
}

async function requestAttempt<T>(
  fetcher: typeof fetch,
  target: URL,
  init: RequestInit,
  policy: ProviderRequestPolicy,
  attempt: number,
): Promise<T> {
  const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const signal = init.signal ? AbortSignal.any([init.signal, timeoutSignal]) : timeoutSignal;
  const response = await fetcher(target, {
    ...init,
    redirect: "error",
    signal,
  }).catch((error) => {
    const timedOut = timeoutSignal.aborted;
    throw new ProjectContextError(
      timedOut ? "PROVIDER_TIMEOUT" : "PROVIDER_NETWORK_ERROR",
      timedOut
        ? `${policy.provider} ${methodOf(init)} request exceeded 20 seconds`
        : `${policy.provider} ${methodOf(init)} request failed`,
      { cause: error },
    );
  });

  const shouldRetry =
    policy.access === "read" &&
    RETRYABLE_STATUSES.has(response.status) &&
    attempt < MAX_READ_ATTEMPTS - 1;
  if (shouldRetry) {
    const delay = retryDelay(response, attempt);
    await response.body?.cancel();
    await wait(delay);
    return requestAttempt(fetcher, target, init, policy, attempt + 1);
  }

  if (!response.ok) {
    const requestId = safeRequestId(response);
    await response.body?.cancel();
    throw new ProjectContextError(
      "PROVIDER_HTTP_ERROR",
      `${policy.provider} ${methodOf(init)} returned ${response.status}${requestId ? ` (request id: ${requestId})` : ""}`,
    );
  }
  if (response.status === 204) return undefined as T;
  return responseJson<T>(response);
}

export async function requestJson<T>(
  fetcher: typeof fetch,
  url: string,
  init: RequestInit,
  policy: ProviderRequestPolicy,
): Promise<T> {
  return requestAttempt(fetcher, assertApprovedOrigin(url, policy), init, policy, 0);
}

export function versionOf(updatedAt: string, id: string): string {
  return `${id}:${updatedAt}`;
}
