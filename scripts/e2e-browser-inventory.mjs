import { createHash } from 'node:crypto';
import { globSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import {
  BROWSER_CAPABILITIES,
  BROWSER_CONTRACT_TYPES,
  BROWSER_JOURNEYS,
} from '../e2e/browser/journey-catalog.mts';

const SPEC_PATTERN = 'e2e/browser/journeys/**/*.spec.mts';
const FORMER_FLAT_PATTERN = 'e2e/playwright/*.spec.mts';
const EXTRACTED_ASSERTION_SUPPORT = [
  'e2e/browser/support/multi-account-journey.mts',
  'e2e/browser/support/room-settings-journey.mts',
  'e2e/browser/support/settings-journey.mts',
];

/**
 * Counts originate from `origin/refactor/refine-architecture` at 793dbdb5 before the
 * structural move. File count intentionally grows when catch-all specs split; fingerprints
 * pin the reviewed current test and assertion sources after whitespace normalization and move
 * only with an intentional browser-contract change.
 */
export const BROWSER_ASSERTION_BASELINE = Object.freeze({
  baselineSpecFiles: 103,
  currentSpecFiles: 122,
  testDefinitions: 305,
  assertionCalls: 2505,
  testFingerprint:
    '004ed7aae9cbc6ca48783b97d6f85bcc10049ad9f2e0a0ac92e1e6eff9f1597e',
  assertionFingerprint:
    'c25bcf4158dbfe6bc5fc71d0a29ef2fca1ba2dbf9942f9bc0459ffff2ce95622',
});

const normalizeSource = (source) => source.replace(/\s+/gu, ' ').trim();
const fingerprint = (records) =>
  createHash('sha256')
    .update([...records].sort().join('\n'))
    .digest('hex');

const sourceFile = (workspaceRoot, path) => {
  const source = readFileSync(join(workspaceRoot, path), 'utf8');
  return {
    source,
    tree: ts.createSourceFile(
      path,
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    ),
  };
};

const displayedTitle = (argument, tree) =>
  ts.isStringLiteralLike(argument)
    ? argument.text
    : normalizeSource(argument.getText(tree));

const isDescribeCall = (node) =>
  ts.isCallExpression(node) &&
  ts.isPropertyAccessExpression(node.expression) &&
  ts.isIdentifier(node.expression.expression) &&
  node.expression.expression.text === 'test' &&
  node.expression.name.text === 'describe';

const isTestDefinition = (node) =>
  ts.isCallExpression(node) &&
  ts.isIdentifier(node.expression) &&
  node.expression.text === 'test';

const testRecords = (tree) => {
  const records = [];

  const visit = (node, describeTitles) => {
    let childDescribeTitles = describeTitles;
    if (isDescribeCall(node)) {
      childDescribeTitles = [
        ...describeTitles,
        displayedTitle(node.arguments[0], tree),
      ];
    }

    if (isTestDefinition(node)) {
      const callback = node.arguments.find(
        (argument) =>
          ts.isArrowFunction(argument) || ts.isFunctionExpression(argument),
      );
      if (!callback) {
        throw new Error(
          `Cannot inventory test without an inline callback: ${node.getText(tree)}`,
        );
      }
      const title = displayedTitle(node.arguments[0], tree);
      const callbackFingerprint = createHash('sha256')
        .update(normalizeSource(callback.getText(tree)))
        .digest('hex');
      records.push(
        `${[...describeTitles, title].join(' > ')}\0${callbackFingerprint}`,
      );
    }

    ts.forEachChild(node, (child) => visit(child, childDescribeTitles));
  };

  visit(tree, []);
  return records;
};

const isExpectCall = (node) => {
  if (!ts.isCallExpression(node)) return false;
  if (ts.isIdentifier(node.expression)) {
    return node.expression.text === 'expect';
  }
  return (
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === 'expect' &&
    ['poll', 'soft'].includes(node.expression.name.text)
  );
};

const assertionRecords = (tree) => {
  const records = [];
  const visit = (node) => {
    if (isExpectCall(node)) {
      let owner = node;
      while (owner.parent && !ts.isStatement(owner)) owner = owner.parent;
      records.push(normalizeSource(owner.getText(tree)));
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return records;
};

export function captureBrowserAssertionInventory(workspaceRoot) {
  const specPaths = globSync(SPEC_PATTERN, { cwd: workspaceRoot }).sort();
  const testSources = specPaths.map((path) => sourceFile(workspaceRoot, path));
  const assertionSources = [
    ...testSources,
    ...EXTRACTED_ASSERTION_SUPPORT.map((path) =>
      sourceFile(workspaceRoot, path),
    ),
  ];
  const tests = testSources.flatMap(({ tree }) => testRecords(tree));
  const assertions = assertionSources.flatMap(({ tree }) =>
    assertionRecords(tree),
  );

  return {
    specFiles: specPaths.length,
    testDefinitions: tests.length,
    assertionCalls: assertions.length,
    testFingerprint: fingerprint(tests),
    assertionFingerprint: fingerprint(assertions),
  };
}

export function validateBrowserJourneyInventory(
  errors,
  workspaceRoot,
  browserSuite,
) {
  const formerFlatSpecs = globSync(FORMER_FLAT_PATTERN, {
    cwd: workspaceRoot,
  });
  if (formerFlatSpecs.length > 0) {
    errors.push(
      `former flat canonical browser root still owns ${formerFlatSpecs.length} specs`,
    );
  }

  const filesystemPaths = globSync(SPEC_PATTERN, { cwd: workspaceRoot })
    .map((path) => path.replace(/^e2e\/browser\//u, ''))
    .sort();
  const catalogPaths = BROWSER_JOURNEYS.map(({ path }) => path).sort();
  const duplicates = catalogPaths.filter(
    (path, index) => catalogPaths.indexOf(path) !== index,
  );
  for (const duplicate of new Set(duplicates)) {
    errors.push(`duplicate browser journey annotation: ${duplicate}`);
  }
  for (const missing of filesystemPaths.filter(
    (path) => !catalogPaths.includes(path),
  )) {
    errors.push(`browser journey has no annotation: ${missing}`);
  }
  for (const stale of catalogPaths.filter(
    (path) => !filesystemPaths.includes(path),
  )) {
    errors.push(`browser journey annotation has no spec: ${stale}`);
  }

  const coveredCapabilities = new Set();
  for (const journey of BROWSER_JOURNEYS) {
    const pathCapability = journey.path.split('/')[1];
    if (journey.capability !== pathCapability) {
      errors.push(
        `${journey.path} is annotated ${journey.capability} but lives under ${pathCapability}`,
      );
    }
    coveredCapabilities.add(journey.capability);
  }
  for (const capability of BROWSER_CAPABILITIES) {
    if (!coveredCapabilities.has(capability)) {
      errors.push(`browser capability has no journey: ${capability}`);
    }
  }

  const observedContractTypes = [
    ...new Set(BROWSER_JOURNEYS.map(({ contractType }) => contractType)),
  ].sort();
  if (
    !browserSuite ||
    JSON.stringify([...browserSuite.capabilities].sort()) !==
      JSON.stringify([...BROWSER_CAPABILITIES].sort()) ||
    JSON.stringify([...browserSuite.contractTypes].sort()) !==
      JSON.stringify([...BROWSER_CONTRACT_TYPES].sort()) ||
    JSON.stringify(observedContractTypes) !==
      JSON.stringify([...BROWSER_CONTRACT_TYPES].sort())
  ) {
    errors.push(
      'browser suite capability or contract annotations drifted from the journey catalog',
    );
  }

  const observed = captureBrowserAssertionInventory(workspaceRoot);
  for (const key of [
    'currentSpecFiles',
    'testDefinitions',
    'assertionCalls',
    'testFingerprint',
    'assertionFingerprint',
  ]) {
    const observedKey = key === 'currentSpecFiles' ? 'specFiles' : key;
    if (observed[observedKey] !== BROWSER_ASSERTION_BASELINE[key]) {
      errors.push(
        `browser assertion inventory ${key} drifted: expected ${BROWSER_ASSERTION_BASELINE[key]}, found ${observed[observedKey]}`,
      );
    }
  }
}
