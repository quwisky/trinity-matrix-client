import { createHash } from 'node:crypto';
import { globSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import ts from 'typescript';

const DEFAULT_PATTERN = 'e2e/protocol/**/*.spec.mjs';
const ASSERTION_METHODS = new Set(['waitFor', 'waitForFunction', 'waitForURL']);
const EXPECTED_INVENTORY = {
  files: 12,
  assertions: 189,
  fingerprint:
    'ba83ce70aab1b28afbd0aadbcb0fdb1d8f007791819b7f83ee4ed0442fb2ee8a',
};
const PRE_MIGRATION_ASSERTIONS = 209;
const APPROVED_POST_MIGRATION_ASSERTIONS = 1;
const CENTRALIZED_SHARED_CHECKS = 21;
const EXPECTED_SHARED_OWNER_FINGERPRINT =
  '71d32ffab7c5c62b8eddb23d73e6cfd72c736867627456db29ddf089f581c1f2';

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

function namedFunctionRecord(path, source, name) {
  const tree = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  let record;
  const visit = (node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name && !record) {
      record = `${path}:${name}:${normalize(node.getText(tree))}`;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  if (!record) throw new Error(`Missing shared protocol owner ${path}:${name}`);
  return record;
}

export function captureProtocolCentralizedChecks(workspaceRoot) {
  const owners = [
    ['e2e/protocol/fixtures.mts', 'fillLabeledInput'],
    ['e2e/protocol/fixtures.mts', 'login'],
    ['e2e/support/app.mts', 'clickRowToolbar'],
  ];
  const records = owners.map(([path, name]) =>
    namedFunctionRecord(
      path,
      readFileSync(join(workspaceRoot, path), 'utf8'),
      name,
    ),
  );
  return {
    legacyChecks: CENTRALIZED_SHARED_CHECKS,
    owners: records.length,
    fingerprint: createHash('sha256')
      .update(records.sort().join('\n'))
      .digest('hex'),
  };
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
  const centralized = captureProtocolCentralizedChecks(workspaceRoot);
  for (const key of ['files', 'assertions', 'fingerprint']) {
    if (observed[key] !== EXPECTED_INVENTORY[key]) {
      errors.push(
        `protocol assertion inventory ${key} drifted: expected ${EXPECTED_INVENTORY[key]}, found ${observed[key]}`,
      );
    }
  }
  if (
    observed.assertions + CENTRALIZED_SHARED_CHECKS !==
    PRE_MIGRATION_ASSERTIONS + APPROVED_POST_MIGRATION_ASSERTIONS
  ) {
    errors.push(
      'protocol assertion inventory no longer reconciles with the pre-migration baseline plus approved additions',
    );
  }
  if (centralized.fingerprint !== EXPECTED_SHARED_OWNER_FINGERPRINT) {
    errors.push(
      `protocol centralized-check owners drifted: expected ${EXPECTED_SHARED_OWNER_FINGERPRINT}, found ${centralized.fingerprint}`,
    );
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
