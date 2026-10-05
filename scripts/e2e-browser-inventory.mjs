import { globSync } from 'node:fs';
import { BROWSER_CAPABILITIES } from '../e2e/registry/browser-classification.mts';

const SPEC_PATTERN = 'e2e/browser/journeys/**/*.spec.mts';
const FORMER_FLAT_PATTERN = 'e2e/playwright/*.spec.mts';

export function validateBrowserJourneyInventory(errors, workspaceRoot) {
  const formerFlatSpecs = globSync(FORMER_FLAT_PATTERN, {
    cwd: workspaceRoot,
  });
  if (formerFlatSpecs.length > 0) {
    errors.push(
      `former flat canonical browser root still owns ${formerFlatSpecs.length} specs`,
    );
  }

  const covered = new Set();
  for (const path of globSync(SPEC_PATTERN, { cwd: workspaceRoot })) {
    const [, , , capability, file, ...rest] = path.split('/');
    if (!BROWSER_CAPABILITIES.includes(capability) || !file || rest.length) {
      errors.push(
        `browser spec must live directly under journeys/<capability>/: ${path}`,
      );
    } else {
      covered.add(capability);
    }
  }
  for (const capability of BROWSER_CAPABILITIES) {
    if (!covered.has(capability)) {
      errors.push(`browser capability has no journey: ${capability}`);
    }
  }
}
