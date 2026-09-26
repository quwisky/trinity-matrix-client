import { redactMatrixIdentifiers } from './matrix-identifiers.mts';

/**
 * Whether an error is a Node assertion. An error nested in an AggregateError
 * crosses the test runner's process boundary as a plain Error without its
 * `code`, but its stack header still names the assertion.
 */
function isAssertionError(error: Error): boolean {
  return (
    Reflect.get(error, 'code') === 'ERR_ASSERTION' ||
    error.name === 'AssertionError' ||
    /^AssertionError\b/u.test(error.stack ?? '')
  );
}

/**
 * The message of one error as the job log may show it. Node appends an
 * assertion's actual and expected values to its message even when a custom
 * message is given, and those values were never registered as secrets, so an
 * assertion keeps only its first line, or its operator when Node generated
 * the whole message. Other errors keep their message.
 */
export function publicErrorMessage(error: Error): string {
  if (!isAssertionError(error)) return error.message;
  if (Reflect.get(error, 'generatedMessage') === true)
    return `${String(Reflect.get(error, 'operator'))} assertion failed`;
  return error.message.split('\n')[0] ?? '';
}

/**
 * One `name: message` line per error of a stage's failures, flattening nested
 * AggregateErrors. Non-error values are named only by their type.
 */
export function publicFailureLines(failures: readonly unknown[]): string[] {
  const lines: string[] = [];
  const visit = (value: unknown): void => {
    if (value instanceof AggregateError) {
      lines.push(`${value.name}: ${value.message}`);
      for (const nested of value.errors) visit(nested);
    } else if (value instanceof Error) {
      lines.push(`${value.name}: ${publicErrorMessage(value)}`);
    } else {
      lines.push(typeof value);
    }
  };
  for (const failure of failures) visit(failure);
  return lines;
}

/** The error a stage rethrows to the job log: a heading plus its public failure lines. */
export function publicStageFailure(
  heading: string,
  failures: readonly unknown[],
  redact: (text: string) => string = (text) => text,
): Error {
  return new Error(
    redactMatrixIdentifiers(
      redact(`${heading}\n${publicFailureLines(failures).join('\n')}`),
    ),
  );
}

const MAX_DEPTH = 6;

/**
 * A reporter's account of a failed test: each error's name, public message and
 * stack frames, through nested AggregateErrors and causes. Stack headers repeat
 * the full message, so only `at …` frames are kept. Node's test wrapper repeats
 * its cause's message and is named by its failure type instead.
 */
export function publicFailureText(error: unknown): string {
  const lines: string[] = [];
  const seen = new Set<unknown>();
  const visit = (value: unknown, depth: number, label: string): void => {
    const indent = '  '.repeat(depth);
    if (!(value instanceof Error)) {
      lines.push(`${indent}${label}${typeof value}`);
      return;
    }
    if (seen.has(value) || depth > MAX_DEPTH) {
      lines.push(`${indent}${label}${value.name}: <omitted>`);
      return;
    }
    seen.add(value);
    const code = Reflect.get(value, 'code');
    const cause: unknown = Reflect.get(value, 'cause');
    const wrapper = code === 'ERR_TEST_FAILURE' && cause instanceof Error;
    const message = wrapper
      ? `test failed (${String(Reflect.get(value, 'failureType'))})`
      : publicErrorMessage(value);
    const name =
      value.name === 'Error' && isAssertionError(value)
        ? 'AssertionError'
        : value.name;
    lines.push(
      `${indent}${label}${name}${typeof code === 'string' ? ` [${code}]` : ''}: ${message}`,
    );
    if (!wrapper)
      for (const frame of (value.stack ?? '').split('\n'))
        if (/^\s+at /u.test(frame)) lines.push(`${indent}  ${frame.trim()}`);
    // Errors cross the test runner's process boundary serialized, so an
    // AggregateError is recognised by its `errors` array, not its class.
    const nested: unknown = Reflect.get(value, 'errors');
    if (Array.isArray(nested))
      nested.forEach((entry: unknown, index) =>
        visit(entry, depth + 1, `[errors][${index}] `),
      );
    if (cause !== undefined) visit(cause, depth + 1, '[cause] ');
  };
  visit(error, 0, '');
  return redactMatrixIdentifiers(lines.join('\n'));
}
