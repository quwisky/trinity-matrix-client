import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory())
      return entry.name === 'node_modules' ? [] : sourceFiles(path);
    return /\.m?[jt]s$/u.test(entry.name) && !/\.spec\.mjs$/u.test(path)
      ? [path]
      : [];
  });
}

/**
 * Playwright records a custom `expect` message as the step title of every
 * assertion, passing or not, and serializes titles, attachments and console
 * output into the blob, HTML and JUnit reports. A response body used there
 * published Synapse login responses, access tokens included. These sinks
 * therefore never receive a response body or a credential, test-account
 * passwords included; a failure message built only after a failed status
 * check may still carry the response body.
 */
const CREDENTIAL_NAME =
  /^(?:(?:access|refresh)_?tokens?|tokens?|bearer|authorization|auth|headers|session_?token|(?:\w*_)?pass|\w*pass(?:word|phrase)s?|pw|pwd)$/iu;
/** Response body readers; `JSON.stringify` also counts in titles and messages. */
const BODY_READERS = new Set(['text', 'json', 'body']);
const LOG_METHODS = new Set(['log', 'info', 'warn', 'error', 'debug', 'trace']);

/** A value passed through a redaction helper, such as `redact(message.text())`. */
const isRedaction = (node) =>
  ts.isCallExpression(node) && /redact|scrub/iu.test(node.expression.getText());

function leaks(node, { stringify, bodies = true }) {
  let found;
  const visit = (current) => {
    if (found || isRedaction(current)) return;
    if (ts.isIdentifier(current) && CREDENTIAL_NAME.test(current.text))
      found = current.text;
    else if (
      ts.isPropertyAccessExpression(current) &&
      CREDENTIAL_NAME.test(current.name.text)
    )
      found = current.getText();
    else if (
      ts.isStringLiteralLike(current) &&
      /\bBearer\s/u.test(current.text)
    )
      found = 'Bearer';
    else if (
      ts.isCallExpression(current) &&
      ts.isPropertyAccessExpression(current.expression) &&
      ((bodies && BODY_READERS.has(current.expression.name.text)) ||
        (stringify &&
          current.expression.expression.getText() === 'JSON' &&
          current.expression.name.text === 'stringify'))
    )
      found = current.getText();
    if (!found) ts.forEachChild(current, visit);
  };
  visit(node);
  return found;
}

/** `expect(...)`, `expect.soft(...)` or `expect.poll(...)`, however `expect` is named. */
function expectCall(node) {
  const callee = node.expression;
  if (ts.isIdentifier(callee)) return callee.text === 'expect' ? 'expect' : '';
  if (
    ts.isPropertyAccessExpression(callee) &&
    ts.isIdentifier(callee.expression) &&
    callee.expression.text === 'expect' &&
    ['soft', 'poll'].includes(callee.name.text)
  )
    return `expect.${callee.name.text}`;
  return '';
}

function sinks(file) {
  const text = readFileSync(file, 'utf8');
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const findings = [];
  const report = (node, sink, value) => {
    const { line } = source.getLineAndCharacterOfPosition(node.getStart());
    findings.push(`${relative(root, file)}:${line + 1} ${sink}: ${value}`);
  };
  const visit = (node) => {
    // A thrown error is the report's failure message. A failed response's
    // body may explain it, but a credential never does.
    if (ts.isNewExpression(node) && /Error$/u.test(node.expression.getText())) {
      const found = (node.arguments ?? [])
        .map((argument) => leaks(argument, { stringify: false, bodies: false }))
        .find(Boolean);
      if (found) report(node, 'error message', found);
    }
    if (ts.isCallExpression(node)) {
      const [first, second] = node.arguments;
      const assertion = expectCall(node);
      const callee = node.expression;
      const method = ts.isPropertyAccessExpression(callee)
        ? callee.name.text
        : '';
      if (assertion && second) {
        // expect(value, message) / expect.poll(fn, { message })
        const found = leaks(second, { stringify: true });
        if (found) report(node, `${assertion} message`, found);
      } else if (method === 'step' && first) {
        const found = leaks(first, { stringify: true });
        if (found) report(node, 'test.step title', found);
      } else if (method === 'attach') {
        const found = node.arguments
          .map((argument) => leaks(argument, { stringify: false }))
          .find(Boolean);
        if (found) report(node, 'attachment', found);
      } else if (
        LOG_METHODS.has(method) &&
        ts.isIdentifier(callee.expression) &&
        callee.expression.text === 'console'
      ) {
        const found = node.arguments
          .map((argument) => leaks(argument, { stringify: false }))
          .find(Boolean);
        if (found) report(node, `console.${method}`, found);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return findings;
}

const files = sourceFiles(join(root, 'e2e'));

describe('E2E report credential sinks', () => {
  it('scans the E2E sources', () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it('never puts a response body or credential into a report sink', () => {
    expect(files.flatMap(sinks)).toEqual([]);
  });
});
