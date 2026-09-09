#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
import { expectedJobsForMode } from './ci-classify.mjs';

const canonical = expectedJobsForMode;

export const evaluateRequiredResult = (classification, needs) => {
  const expected = canonical(classification?.mode);
  const failures = [];
  if (
    classification?.classifierFailed ||
    classification?.ok === false ||
    classification?.error
  ) {
    failures.push('classifier failed');
  }
  const actualJobs = classification?.expectedJobs;
  const sameJobSet =
    Array.isArray(actualJobs) &&
    actualJobs.length === expected?.length &&
    new Set(actualJobs).size === actualJobs.length &&
    actualJobs.every((job) => expected.includes(job));
  if (!expected || !sameJobSet) {
    failures.push('classification expected job set is not canonical');
  }
  if (!needs || typeof needs !== 'object' || !('classify' in needs)) {
    failures.push('classify: missing');
  } else {
    const classifierEntry = needs.classify;
    const classifierStatus =
      typeof classifierEntry === 'string'
        ? classifierEntry
        : classifierEntry?.result;
    if (classifierStatus !== 'success') {
      failures.push(`classify: ${classifierStatus ?? 'missing'}`);
    }
  }
  for (const job of expected ?? []) {
    const entry = needs && typeof needs === 'object' ? needs[job] : undefined;
    const status = typeof entry === 'string' ? entry : entry?.result;
    if (status !== 'success') failures.push(`${job}: ${status ?? 'missing'}`);
  }
  return { ok: failures.length === 0, failures };
};

const append = (file, value) => {
  if (file) appendFileSync(file, `${value}\n`, 'utf8');
};

export const main = ({ env = process.env } = {}) => {
  let classification;
  let needs;
  try {
    classification = JSON.parse(env.CI_CLASSIFICATION_JSON ?? '');
    needs = JSON.parse(env.CI_NEEDS_JSON ?? '');
  } catch {
    append(
      env.GITHUB_STEP_SUMMARY,
      '## Required CI results\n\n- classifier input was malformed',
    );
    return { ok: false, failures: ['malformed evaluator input'], exitCode: 1 };
  }
  const evaluation = evaluateRequiredResult(classification, needs);
  if (env.CI_SOURCE_RESULT !== 'success') {
    evaluation.failures.unshift(
      `master source guard: ${env.CI_SOURCE_RESULT ?? 'missing'}`,
    );
    evaluation.ok = false;
  }
  const resultLines = [
    'classify',
    ...(canonical(classification?.mode) ?? []),
  ].map((job) => {
    const entry = needs?.[job];
    const status = typeof entry === 'string' ? entry : entry?.result;
    return `- ${job}: ${status ?? 'missing'}`;
  });
  const details = evaluation.ok
    ? ['all required jobs succeeded', ...resultLines].join('\n')
    : [
        ...evaluation.failures.map((failure) => `- ${failure}`),
        ...resultLines,
      ].join('\n');
  append(env.GITHUB_STEP_SUMMARY, `## Required CI results\n\n${details}`);
  append(env.GITHUB_OUTPUT, `result=${evaluation.ok ? 'success' : 'failure'}`);
  return { ...evaluation, exitCode: evaluation.ok ? 0 : 1 };
};

if (import.meta.url === `file://${process.argv[1]}`)
  process.exitCode = main().exitCode;
