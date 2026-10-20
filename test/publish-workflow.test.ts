import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// publish.yml publishes to npm from a tag. These tests evaluate the `if` expressions of its `ci` and `publish` jobs
// for every combination of the results the runner can report and check the one rule that matters: nothing is
// published unless the CI was reused from a green push run (the `ci` job skipped because the gate said so) or the
// `ci` job itself ran and succeeded. They also check that the older safeguards are still in the workflow.

const WORKFLOW: string = readFileSync(
  resolve(__dirname, '../.github/workflows/publish.yml'),
  'utf8'
);

/** The text of one top-level job (from "  name:" to the next job). */
function job(name: string): string {
  const match: RegExpMatchArray | null = WORKFLOW.match(
    new RegExp(`\\n  ${name}:\\n([\\s\\S]*?)(?=\\n  [a-z][a-z-]*:\\n|$)`)
  );
  if (!match) throw new Error(`job ${name} not found in publish.yml`);
  return match[1] ?? '';
}

/** The expression of the job's `if:` (a single line or a `>-` block), without `${{ }}`. */
function condition(name: string): string {
  const text: string = job(name);
  const block: RegExpMatchArray | null = text.match(
    /\n {4}if: >-\n((?: {6}.*\n?)+)/
  );
  const single: RegExpMatchArray | null = text.match(/\n {4}if: (.*)\n/);
  const raw: string = (block ? block[1] : single ? single[1] : '') ?? '';
  const expression: string = raw
    .split('\n')
    .map((line: string) => line.trim())
    .join(' ')
    .trim();
  if (expression === '') throw new Error(`job ${name} has no if`);
  return expression
    .replace(/^\$\{\{/, '')
    .replace(/\}\}$/, '')
    .trim();
}

interface Needs {
  gate: { result: string; outputs: { reuse: string } };
  ci?: { result: string };
}

function evaluate(expression: string, needs: Needs): boolean {
  // The expressions only use needs.*, string literals, ==, !=, && and ||, which mean the same in JavaScript.
  const run = new Function(
    'needs',
    'always',
    `return Boolean(${expression});`
  ) as (needs: Needs, always: () => boolean) => boolean;
  return run(needs, () => true);
}

const GATE_RESULTS: string[] = ['success', 'failure', 'cancelled', 'skipped'];
const REUSE_VALUES: string[] = ['true', 'false', ''];
const CI_OUTCOMES: string[] = ['success', 'failure', 'cancelled'];

interface Scenario {
  gate: string;
  reuse: string;
  ciOutcome: string;
  ciRan: boolean;
  ciResult: string;
  publishes: boolean;
}

function scenarios(): Scenario[] {
  const ciCondition: string = condition('ci');
  const publishCondition: string = condition('publish');
  const all: Scenario[] = [];
  for (const gate of GATE_RESULTS) {
    for (const reuse of REUSE_VALUES) {
      for (const ciOutcome of CI_OUTCOMES) {
        // A job with `if` and no status function only runs while its needs succeeded.
        const ciRan: boolean =
          gate === 'success' &&
          evaluate(ciCondition, { gate: { result: gate, outputs: { reuse } } });
        const ciResult: string = ciRan ? ciOutcome : 'skipped';
        const publishes: boolean = evaluate(publishCondition, {
          gate: { result: gate, outputs: { reuse } },
          ci: { result: ciResult },
        });
        all.push({ gate, reuse, ciOutcome, ciRan, ciResult, publishes });
      }
    }
  }
  return all;
}

describe('publish.yml gate', () => {
  it('publishes only when the CI was reused from a green run or the CI job ran and succeeded', () => {
    for (const s of scenarios()) {
      const reused: boolean =
        s.gate === 'success' && s.reuse === 'true' && !s.ciRan;
      const ranGreen: boolean =
        s.gate === 'success' &&
        s.reuse !== 'true' &&
        s.ciRan &&
        s.ciOutcome === 'success';
      expect(s.publishes, JSON.stringify(s)).toBe(reused || ranGreen);
    }
  });

  it('never publishes after a failed or cancelled CI, a failed gate or a skipped CI without reuse', () => {
    for (const s of scenarios()) {
      if (s.gate !== 'success')
        expect(s.publishes, JSON.stringify(s)).toBe(false);
      if (s.reuse !== 'true' && s.ciOutcome !== 'success')
        expect(s.publishes, JSON.stringify(s)).toBe(false);
      if (s.reuse !== 'true')
        expect(s.ciRan, JSON.stringify(s)).toBe(s.gate === 'success');
    }
  });

  it('skips the CI only when the gate succeeded with reuse=true', () => {
    for (const s of scenarios()) {
      if (s.gate === 'success')
        expect(s.ciRan, JSON.stringify(s)).toBe(s.reuse !== 'true');
      else expect(s.ciRan, JSON.stringify(s)).toBe(false);
    }
  });

  it('gives the gate read-only permissions and keeps the npm token in the publish job only', () => {
    const gate: string = job('gate');
    expect(gate).toMatch(/permissions:\n\s+contents: read\n\s+actions: read\n/);
    expect(gate).not.toMatch(/id-token/);
    expect(gate).not.toMatch(/secrets\./);
    expect(gate).not.toMatch(/npm publish/);
    expect(job('ci')).not.toMatch(/secrets\./);
    expect(job('publish')).toContain('secrets.NPM_TOKEN');
    expect(WORKFLOW.match(/secrets\.NPM_TOKEN/g)).toHaveLength(1);
  });

  it('keeps the publish safeguards: tag version, commit on main, provenance and dist-tags', () => {
    const publish: string = job('publish');
    expect(publish).toContain('needs: [gate, ci]');
    expect(publish).toContain('does not match package.json version');
    expect(publish).toContain(
      'git merge-base --is-ancestor "$GITHUB_SHA" origin/main'
    );
    expect(publish).toContain(
      'npm publish --provenance --access public --tag next'
    );
    expect(publish).toContain('npm publish --provenance --access public\n');
    expect(WORKFLOW).toMatch(/id-token: write/);
    expect(WORKFLOW).toMatch(/tags:\n\s+- 'v\*\.\*\.\*'/);
  });

  it('runs the whole CI workflow when the gate does not say reuse', () => {
    expect(job('ci')).toContain('uses: ./.github/workflows/ci.yml');
    expect(job('ci')).toContain('needs: gate');
  });
});
