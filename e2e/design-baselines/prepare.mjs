import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const captureRoot = resolve(
  import.meta.dirname,
  '../../dist/.playwright/current-baselines/captures',
);

rmSync(captureRoot, { force: true, recursive: true });
mkdirSync(captureRoot, { recursive: true });
