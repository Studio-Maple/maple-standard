/** http.mjs - tiny JSON-over-fetch helpers for the package-add checks. fetchImpl is injectable; errors carry `.status`. */

export class HttpError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

/** A deadline shared by every request of one command: `remaining()` is the budget left, never below 200 ms. */
export function budget(totalMs) {
  const end = Date.now() + totalMs;
  return { remaining: () => Math.max(200, end - Date.now()) };
}

export async function getJson(fetchImpl, url, { timeoutMs = 4000, headers } = {}) {
  const res = await fetchImpl(url, { headers: { accept: "application/json", ...headers }, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new HttpError(`${new URL(url).host} answered ${res.status} for ${url.split("/").slice(-2).join("/")}`, res.status);
  return res.json();
}

export async function postJson(fetchImpl, url, body, { timeoutMs = 4000 } = {}) {
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new HttpError(`${new URL(url).host} answered ${res.status}`, res.status);
  return res.json();
}
