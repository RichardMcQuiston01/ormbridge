import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// .github/scripts/find-green-ci.sh decides whether the tag Publish run may reuse the CI run of the same commit. These
// tests run the real script with a fake `gh` first on the PATH that serves canned GitHub API answers, one "lookup
// round" after the other, so every rule of the script is checked without the network. The first line of defence of
// the Publish workflow is that reuse=true only ever comes from a green push run of exactly this commit.

const SCRIPT: string = resolve(
  __dirname,
  '../.github/scripts/find-green-ci.sh'
);
const TAG_SHA = '10ad3f9389de0cdca6af87fee2b94982896d2b38';
const OTHER_SHA = '31ea67e6d0f78a98bf3643b6ff82456b4f462676';

const probe: SpawnSyncReturns<string> = spawnSync('jq', ['--version'], {
  encoding: 'utf8',
});
const hasJq: boolean = probe.status === 0;

interface FakeRun {
  id: number;
  head_sha?: string;
  event?: string;
  status?: string;
  conclusion?: string | null;
}

interface Decision {
  status: number | null;
  reuse: string;
  reason: string;
  runId: string;
  githubOutput: string;
  stderr: string;
}

let directory: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'ormbridge-gate-'));
  // `gh api <path>`: the runs lookups are answered from runs-<round>.json (the last file repeats), the job lookups
  // from jobs-<run id>.json; a missing file is an API failure. The round counts the runs lookups.
  const gh: string = `#!/usr/bin/env bash
set -eu
dir="${directory}"
path="$2"
echo "$path" >> "$dir/requests.log"
case "$path" in
  *"/jobs?"*)
    id="\${path#*/runs/}"; id="\${id%%/*}"
    cat "$dir/jobs-$id.json"
    ;;
  *"/runs?"*)
    round="$(cat "$dir/round" 2> /dev/null || echo 0)"
    round=$((round + 1))
    echo "$round" > "$dir/round"
    file="$dir/runs-$round.json"
    [ -f "$file" ] || file="$(ls "$dir"/runs-*.json | sort -V | tail -1)"
    cat "$file"
    ;;
  *) exit 1 ;;
esac
`;
  writeFileSync(join(directory, 'gh'), gh);
  chmodSync(join(directory, 'gh'), 0o755);
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

/** One lookup answer: the push runs given, completed and green unless the fields say otherwise. */
function runsRound(round: number, runs: FakeRun[]): void {
  const full = runs.map((run: FakeRun) => ({
    head_sha: TAG_SHA,
    event: 'push',
    status: 'completed',
    conclusion: 'success',
    ...run,
  }));
  writeFileSync(
    join(directory, `runs-${round}.json`),
    JSON.stringify({ workflow_runs: full })
  );
}

function jobsOf(runId: number, jobs: Record<string, string>): void {
  const list = Object.entries(jobs).map(
    ([name, conclusion]: [string, string]) => ({
      name,
      status: conclusion === 'queued' ? 'queued' : 'completed',
      conclusion,
    })
  );
  writeFileSync(
    join(directory, `jobs-${runId}.json`),
    JSON.stringify({ jobs: list })
  );
}

const GREEN_JOBS: Record<string, string> = {
  check: 'success',
  'real-tools-python': 'success',
  'real-tools': 'success',
};

function decide(
  sha: string = TAG_SHA,
  env: Record<string, string> = {}
): Decision {
  const output: string = join(directory, 'github-output');
  writeFileSync(output, '');
  const result: SpawnSyncReturns<string> = spawnSync('bash', [SCRIPT, sha], {
    encoding: 'utf8',
    env: {
      PATH: `${directory}:${process.env['PATH'] ?? ''}`,
      GITHUB_REPOSITORY: 'owner/repo',
      GITHUB_OUTPUT: output,
      POLL_SECONDS: '0',
      NO_RUN_GRACE_SECONDS: '0',
      MAX_WAIT_SECONDS: '3600',
      ...env,
    },
  });
  const values: Map<string, string> = new Map();
  for (const line of result.stdout.split('\n')) {
    const index: number = line.indexOf('=');
    if (index > 0) values.set(line.slice(0, index), line.slice(index + 1));
  }
  return {
    status: result.status,
    reuse: values.get('reuse') ?? '',
    reason: values.get('reason') ?? '',
    runId: values.get('run_id') ?? '',
    githubOutput: readFileSync(output, 'utf8'),
    stderr: result.stderr,
  };
}

describe.skipIf(!hasJq)('find-green-ci.sh', () => {
  describe('reuse=true', () => {
    it('reuses a completed, successful push run of the commit', () => {
      runsRound(1, [{ id: 101 }]);
      jobsOf(101, GREEN_JOBS);
      const decision: Decision = decide();
      expect(decision.status).toBe(0);
      expect(decision.reuse).toBe('true');
      expect(decision.runId).toBe('101');
      expect(decision.githubOutput).toContain('reuse=true');
      expect(decision.githubOutput).toContain('run_id=101');
    });

    it('asks only for push runs of the commit, with the head_sha filter', () => {
      runsRound(1, [{ id: 101 }]);
      jobsOf(101, GREEN_JOBS);
      decide();
      const requests: string = readFileSync(
        join(directory, 'requests.log'),
        'utf8'
      );
      expect(requests).toContain(
        `repos/owner/repo/actions/workflows/ci.yml/runs?head_sha=${TAG_SHA}&event=push`
      );
      expect(requests).toContain('repos/owner/repo/actions/runs/101/jobs');
    });

    it('reuses a run that was re-run to green even if another run of the commit failed', () => {
      runsRound(1, [{ id: 100, conclusion: 'failure' }, { id: 101 }]);
      jobsOf(101, GREEN_JOBS);
      expect(decide().reuse).toBe('true');
    });

    it('waits for a run that is still going, then reuses it when it turns green', () => {
      runsRound(1, [{ id: 101, status: 'in_progress', conclusion: null }]);
      runsRound(2, [{ id: 101, status: 'in_progress', conclusion: null }]);
      runsRound(3, [{ id: 101 }]);
      jobsOf(101, GREEN_JOBS);
      const decision: Decision = decide();
      expect(decision.reuse).toBe('true');
      expect(decision.stderr).toContain('still going');
      expect(readFileSync(join(directory, 'round'), 'utf8').trim()).toBe('3');
    });

    it('waits for a queued run too', () => {
      runsRound(1, [{ id: 101, status: 'queued', conclusion: null }]);
      runsRound(2, [{ id: 101 }]);
      jobsOf(101, GREEN_JOBS);
      expect(decide().reuse).toBe('true');
    });

    it('finds a push run that appears a moment after the tag (grace period)', () => {
      runsRound(1, []);
      runsRound(2, [{ id: 101 }]);
      jobsOf(101, GREEN_JOBS);
      expect(
        decide(TAG_SHA, { NO_RUN_GRACE_SECONDS: '60', POLL_SECONDS: '0' }).reuse
      ).toBe('true');
    });
  });

  describe('reuse=false', () => {
    it('does not reuse when no run exists for the commit', () => {
      runsRound(1, []);
      const decision: Decision = decide();
      expect(decision.status).toBe(0);
      expect(decision.reuse).toBe('false');
      expect(decision.reason).toContain('no push run');
      expect(decision.runId).toBe('');
      expect(decision.githubOutput).toContain('reuse=false');
    });

    it.each([
      'failure',
      'cancelled',
      'timed_out',
      'skipped',
      'neutral',
      'action_required',
    ])('does not reuse a run that concluded %s', (conclusion: string) => {
      runsRound(1, [{ id: 101, conclusion }]);
      jobsOf(101, GREEN_JOBS);
      const decision: Decision = decide();
      expect(decision.reuse).toBe('false');
      expect(decision.reason).toContain(conclusion);
    });

    it('ignores pull_request runs of the same commit (a green PR run is not the push run)', () => {
      runsRound(1, [{ id: 101, event: 'pull_request' }]);
      jobsOf(101, GREEN_JOBS);
      expect(decide().reuse).toBe('false');
    });

    it('ignores runs of another commit, even if the API returned them', () => {
      runsRound(1, [{ id: 101, head_sha: OTHER_SHA }]);
      jobsOf(101, GREEN_JOBS);
      expect(decide().reuse).toBe('false');
    });

    it('ignores other events: schedule, workflow_dispatch, workflow_call', () => {
      runsRound(1, [
        { id: 101, event: 'schedule' },
        { id: 102, event: 'workflow_dispatch' },
        { id: 103, event: 'workflow_call' },
      ]);
      expect(decide().reuse).toBe('false');
    });

    it('does not reuse a green run whose real-tools job was skipped', () => {
      runsRound(1, [{ id: 101 }]);
      jobsOf(101, { ...GREEN_JOBS, 'real-tools': 'skipped' });
      const decision: Decision = decide();
      expect(decision.reuse).toBe('false');
      expect(decision.reason).toContain('required jobs');
    });

    it('does not reuse a green run that has no check job', () => {
      runsRound(1, [{ id: 101 }]);
      jobsOf(101, { 'real-tools': 'success' });
      expect(decide().reuse).toBe('false');
    });

    it('does not reuse when the jobs of the run cannot be read', () => {
      runsRound(1, [{ id: 101 }]);
      expect(decide().reuse).toBe('false');
    });

    it('does not reuse when a run that was going finishes red', () => {
      runsRound(1, [{ id: 101, status: 'in_progress', conclusion: null }]);
      runsRound(2, [{ id: 101, conclusion: 'failure' }]);
      const decision: Decision = decide();
      expect(decision.reuse).toBe('false');
      expect(decision.reason).toContain('failure');
    });

    it('gives up waiting after MAX_WAIT_SECONDS and does not reuse', () => {
      runsRound(1, [{ id: 101, status: 'in_progress', conclusion: null }]);
      const decision: Decision = decide(TAG_SHA, { MAX_WAIT_SECONDS: '0' });
      expect(decision.reuse).toBe('false');
      expect(decision.reason).toContain('still running');
    });

    it('does not reuse when the runs cannot be read from the API', () => {
      // No runs-*.json: the fake gh fails on every request.
      writeFileSync(join(directory, 'gh'), '#!/usr/bin/env bash\nexit 1\n');
      const decision: Decision = decide();
      expect(decision.status).toBe(0);
      expect(decision.reuse).toBe('false');
      expect(decision.reason).toContain('could not be read');
    });

    it('does not reuse when the API answers with something that is not JSON', () => {
      writeFileSync(
        join(directory, 'runs-1.json'),
        '<html>502 Bad Gateway</html>'
      );
      expect(decide().reuse).toBe('false');
    });
  });

  describe('bad calls', () => {
    it('exits 2 without a decision for a missing or malformed sha', () => {
      for (const sha of [
        '',
        'main',
        'v0.12.0',
        TAG_SHA.slice(0, 12),
        TAG_SHA.toUpperCase(),
      ]) {
        const decision: Decision = decide(sha);
        expect(decision.status).toBe(2);
        expect(decision.reuse).toBe('');
        expect(decision.githubOutput).toBe('');
      }
    });

    it('exits 2 without GITHUB_REPOSITORY', () => {
      const decision: Decision = decide(TAG_SHA, { GITHUB_REPOSITORY: '' });
      expect(decision.status).toBe(2);
      expect(decision.reuse).toBe('');
    });
  });
});
