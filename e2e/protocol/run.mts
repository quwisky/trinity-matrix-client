#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { runPlaywright } from '../support/run-playwright.mts';
import {
  PROTOCOL_MODE_ENV,
  PROTOCOL_SUITE_ENV,
  isProtocolSuiteId,
  protocolMode,
  protocolResources,
} from './runtime.mts';

export async function runProtocol(
  argv: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const suiteArgument = argv.find((argument) =>
    argument.startsWith('--suite='),
  );
  const suiteId = suiteArgument?.slice('--suite='.length);
  if (!suiteId || !isProtocolSuiteId(suiteId)) {
    throw new Error('Protocol runner requires --suite=<registered-suite-id>');
  }
  const forwarded = argv.filter((argument) => argument !== suiteArgument);
  const mode = protocolMode(environment);
  const resources = protocolResources(suiteId, mode, environment);
  environment[PROTOCOL_SUITE_ENV] = suiteId;
  environment[PROTOCOL_MODE_ENV] = mode;
  return runPlaywright([
    '--config=e2e/protocol/playwright.config.mts',
    '--build=trinity:build:development',
    ...resources.map((resource) => `--resource=${resource}`),
    '--',
    ...forwarded,
  ]);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await runProtocol(process.argv.slice(2));
  } catch (error) {
    console.error('[e2e] protocol invocation failed:', error);
    process.exitCode = 1;
  }
}
