/**
 * Failure messages for e2e HTTP helpers that keep the response body out.
 *
 * Thrown messages reach Playwright and WebdriverIO reports, CI logs and uploaded
 * artifacts, and a server's error body can echo user ids, room ids, tokens or session
 * fields from the request. A message keeps only the label, the HTTP status and, when the
 * body is a Matrix error, its `errcode`.
 */

/** A failed response: Playwright's `APIResponse` (`status()`) or fetch's `Response`. */
export interface FailedResponse {
  readonly status: number | (() => number);
  text(): Promise<string>;
}

/** Matrix error codes are upper-case identifiers, optionally namespaced with dots. */
const MATRIX_ERRCODE = /^[A-Za-z][A-Za-z0-9_.]{0,63}$/;

/** `"<label>: HTTP <status> <errcode?>"`, reading the body only for its `errcode`. */
export async function describeFailure(
  label: string,
  response: FailedResponse,
): Promise<string> {
  const status =
    typeof response.status === 'function' ? response.status() : response.status;
  const body = await response.text().catch(() => '');
  return formatFailure(label, status, body);
}

/** {@link describeFailure} for a body the caller has already read. */
export function formatFailure(
  label: string,
  status: number,
  body: string,
): string {
  const errcode = matrixErrcode(body);
  return errcode
    ? `${label}: HTTP ${status} ${errcode}`
    : `${label}: HTTP ${status}`;
}

/** The path of `url`, without the query string or fragment that can carry tokens. */
export function urlPath(url: string): string {
  return new URL(url, 'http://localhost').pathname;
}

function matrixErrcode(body: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || !('errcode' in parsed)) {
    return undefined;
  }
  const { errcode } = parsed;
  return typeof errcode === 'string' && MATRIX_ERRCODE.test(errcode)
    ? errcode
    : undefined;
}
