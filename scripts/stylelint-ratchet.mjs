#!/usr/bin/env node
// Lowers stylelint-suppressions.json to the stylesheets' current token violations after a fix.
// Unlike `stylelint --suppress`, it never raises a count or adds an entry.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  SUPPRESSIONS,
  committedSuppressions,
  currentSuppressions,
  ratchet,
  workspaceRoot,
} from './stylelint-suppressions.mjs';

const { next, lowered } = ratchet(
  committedSuppressions(),
  await currentSuppressions(),
);
if (lowered.length === 0) {
  console.log(`${SUPPRESSIONS} already matches the stylesheets.`);
} else {
  writeFileSync(
    join(workspaceRoot, SUPPRESSIONS),
    `${JSON.stringify(next, null, 2)}\n`,
  );
  console.log(
    `Lowered ${SUPPRESSIONS}:\n${lowered.map((l) => `  ${l}`).join('\n')}`,
  );
}
