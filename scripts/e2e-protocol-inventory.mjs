import { createHash } from 'node:crypto';
import { globSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import ts from 'typescript';

const DEFAULT_PATTERN = 'e2e/protocol/**/*.spec.mjs';
const ASSERTION_METHODS = new Set(['waitFor', 'waitForFunction', 'waitForURL']);
const EXPECTED_INVENTORY = {
  files: 12,
  assertions: 209,
  fingerprint:
    '112ce5c6f4f79c43a33383cd311bf70f45e514316a9d32cb73daf36462bc9edf',
};

const normalize = (source) => source.replace(/\s+/gu, ' ').trim();

const isOutcomeAssignment = (node) =>
  ts.isBinaryExpression(node) &&
  node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
  ts.isIdentifier(node.left) &&
  ['exit', 'exitCode'].includes(node.left.text);

const containsOutcomeAssignment = (node) => {
  let found = false;
  const visit = (child) => {
    if (isOutcomeAssignment(child)) found = true;
    if (!found) ts.forEachChild(child, visit);
  };
  visit(node);
  return found;
};

const isCaughtFailureRethrow = (node) =>
  ts.isThrowStatement(node) &&
  ts.isIdentifier(node.expression) &&
  node.expression.text === 'err';

function assertionRecords(path, source) {
  const tree = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const records = [];
  const visit = (node) => {
    // Registration lifecycle is intentionally centralized in support; the two
    // former drivers that duplicated it are excluded from the product-assertion
    // baseline so deleting those copies cannot masquerade as coverage loss.
    if (ts.isFunctionDeclaration(node) && node.name?.text === 'registerUser') {
      return;
    }
    // Re-raising a caught Playwright failure preserves the original error and
    // is runner lifecycle, not a product assertion from the legacy baseline.
    if (isCaughtFailureRethrow(node)) {
      // Intentionally excluded from the assertion inventory.
    } else if (ts.isThrowStatement(node)) {
      records.push(`throw:${normalize(node.getText(tree))}`);
    } else if (
      ts.isCallExpression(node) &&
      ((ts.isIdentifier(node.expression) && node.expression.text === 'check') ||
        (ts.isPropertyAccessExpression(node.expression) &&
          ASSERTION_METHODS.has(node.expression.name.text)))
    ) {
      records.push(`call:${normalize(node.getText(tree))}`);
    } else if (
      ts.isIfStatement(node) &&
      containsOutcomeAssignment(node.thenStatement)
    ) {
      records.push(`outcome:${normalize(node.expression.getText(tree))}`);
    } else if (
      isOutcomeAssignment(node) &&
      ts.isConditionalExpression(node.right)
    ) {
      records.push(`outcome:${normalize(node.right.condition.getText(tree))}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return records;
}

export function captureProtocolAssertionInventory(
  workspaceRoot,
  pattern = DEFAULT_PATTERN,
) {
  const files = globSync(pattern, { cwd: workspaceRoot }).sort();
  const records = files.flatMap((path) =>
    assertionRecords(path, readFileSync(join(workspaceRoot, path), 'utf8')),
  );
  return {
    files: files.length,
    assertions: records.length,
    fingerprint: createHash('sha256')
      .update(records.sort().join('\n'))
      .digest('hex'),
  };
}

export function validateProtocolAssertionInventory(errors, workspaceRoot) {
  const observed = captureProtocolAssertionInventory(workspaceRoot);
  for (const key of ['files', 'assertions', 'fingerprint']) {
    if (observed[key] !== EXPECTED_INVENTORY[key]) {
      errors.push(
        `protocol assertion inventory ${key} drifted: expected ${EXPECTED_INVENTORY[key]}, found ${observed[key]}`,
      );
    }
  }
}

if (process.argv[1] === import.meta.filename) {
  const workspaceRoot = resolve(import.meta.dirname, '..');
  const pattern = process.argv[2] ?? DEFAULT_PATTERN;
  console.log(
    JSON.stringify(
      captureProtocolAssertionInventory(workspaceRoot, pattern),
      undefined,
      2,
    ),
  );
}
