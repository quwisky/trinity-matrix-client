import type { ProtocolCredentials } from './runtime.mts';

const REDACTED = '[REDACTED]';

function secretVariants(value: string): readonly string[] {
  return [...new Set([value, encodeURIComponent(value)])].filter(Boolean);
}

/** Remove supplied remote secrets before text can reach Playwright output. */
export function redactProtocolDiagnostic(
  value: unknown,
  credentials: ProtocolCredentials,
): string {
  let text = value instanceof Error ? value.message : String(value);
  const secrets = [credentials.pass, credentials.secondary?.pass].filter(
    (secret): secret is string => Boolean(secret),
  );
  for (const secret of secrets.flatMap(secretVariants)) {
    text = text.replaceAll(secret, REDACTED);
  }
  return text;
}

/**
 * Keep remote response bodies out of diagnostics. They are controlled by the
 * remote server and may echo credentials or tokens supplied with the request.
 */
export function protocolResponseFailure(
  operation: string,
  response: Pick<Response, 'status'>,
): Error {
  return new Error(`${operation} → ${response.status}`);
}

export function redactProtocolError(
  error: unknown,
  credentials: ProtocolCredentials,
): Error {
  if (!(error instanceof Error)) {
    return new Error(redactProtocolDiagnostic(error, credentials));
  }
  error.message = redactProtocolDiagnostic(error.message, credentials);
  if (error.stack) {
    error.stack = redactProtocolDiagnostic(error.stack, credentials);
  }
  return error;
}
