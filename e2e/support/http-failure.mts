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

/**
 * Matrix error codes are upper-case identifiers, optionally namespaced with dots. Anything
 * else, such as a lower-case token shape, is treated as body content and left out.
 */
const MATRIX_ERRCODE = /^[A-Z][A-Z0-9_]*(?:\.[A-Z0-9_]+)*$/;
const MAX_ERRCODE_LENGTH = 64;

/** W3C WebDriver error codes are short lower-case phrases such as `unknown error`. */
const WEBDRIVER_ERROR = /^[a-z ]{1,40}$/;

/** `"<label>: HTTP <status> <errcode?>"`, reading the body only for its `errcode`. */
export async function describeFailure(
  label: string,
  response: FailedResponse,
): Promise<string> {
  return formatFailure(label, statusOf(response), await bodyOf(response));
}

/** {@link describeFailure} for a body the caller has already read. */
export function formatFailure(
  label: string,
  status: number,
  body: string,
): string {
  return withCode(label, status, matrixErrcode(parseJson(body)));
}

/**
 * `"<label>: HTTP <status> <W3C error?> (details in appium.log)"` for a failed Appium
 * request. The WebDriver `value.message` and `value.stacktrace` are left out: they can
 * echo the request, and Appium already writes them to its own log.
 */
export async function describeAppiumFailure(
  label: string,
  response: FailedResponse,
): Promise<string> {
  const code = webDriverError(parseJson(await bodyOf(response)));
  return `${withCode(label, statusOf(response), code)} (details in appium.log)`;
}

/** The path of `url`, without the query string or fragment that can carry tokens. */
export function urlPath(url: string): string {
  return new URL(url, 'http://localhost').pathname;
}

function statusOf(response: FailedResponse): number {
  return typeof response.status === 'function'
    ? response.status()
    : response.status;
}

function bodyOf(response: FailedResponse): Promise<string> {
  return response.text().catch(() => '');
}

function withCode(
  label: string,
  status: number,
  code: string | undefined,
): string {
  return code ? `${label}: HTTP ${status} ${code}` : `${label}: HTTP ${status}`;
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

function matrixErrcode(parsed: unknown): string | undefined {
  if (typeof parsed !== 'object' || parsed === null || !('errcode' in parsed)) {
    return undefined;
  }
  const { errcode } = parsed;
  return typeof errcode === 'string' &&
    errcode.length <= MAX_ERRCODE_LENGTH &&
    MATRIX_ERRCODE.test(errcode)
    ? errcode
    : undefined;
}

function webDriverError(parsed: unknown): string | undefined {
  if (typeof parsed !== 'object' || parsed === null || !('value' in parsed)) {
    return undefined;
  }
  const { value } = parsed;
  if (typeof value !== 'object' || value === null || !('error' in value)) {
    return undefined;
  }
  const { error } = value;
  return typeof error === 'string' && WEBDRIVER_ERROR.test(error)
    ? error
    : undefined;
}
