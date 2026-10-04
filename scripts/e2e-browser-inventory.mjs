import { globSync } from 'node:fs';
import {
  BROWSER_CAPABILITIES,
  BROWSER_CONTRACT_TYPES,
  BROWSER_JOURNEYS,
} from '../e2e/browser/journey-catalog.mts';

const SPEC_PATTERN = 'e2e/browser/journeys/**/*.spec.mts';
const FORMER_FLAT_PATTERN = 'e2e/playwright/*.spec.mts';

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
}
