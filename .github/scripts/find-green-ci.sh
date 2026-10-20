#!/usr/bin/env bash
# Decides whether the tag Publish run can reuse a CI run that already passed for the same commit.
#
# Usage: .github/scripts/find-green-ci.sh <commit sha>
#
# It asks GitHub for the runs of ci.yml whose head commit is the given SHA and whose event is `push` (runs of the
# `pull_request` event are about a merge ref, not about this commit, and are ignored), and prints
#
#   reuse=true|false
#   reason=<one line>
#   run_id=<id of the run that was reused, empty otherwise>
#
# (also appended to $GITHUB_OUTPUT when that is set). The rules, in order:
#
#   - a completed run with conclusion `success` whose `check` and `real-tools` jobs both succeeded -> reuse=true
#     (any run counts, so a run that failed once and was re-run to green is reused; a success never turns false)
#   - otherwise, a run that is queued, waiting or in progress -> wait for it (polling), then decide again
#   - otherwise (no run, failed, cancelled, timed out, skipped, or the API cannot be read) -> reuse=false
#
# So the only way to get reuse=true is a green push run of exactly this commit; every doubt (including an API error
# or waiting longer than MAX_WAIT_SECONDS) gives reuse=false, which makes the Publish workflow run the whole CI itself.
# The exit status is 0 whenever a decision was printed, and 2 for a bad call.
#
# Environment (all optional except the repository and a token for `gh`):
#   GITHUB_REPOSITORY  owner/name (set by Actions)
#   GH_TOKEN           token for `gh api` (the job's GITHUB_TOKEN with `actions: read` is enough)
#   CI_WORKFLOW        workflow file name, default ci.yml
#   REQUIRED_JOBS      space-separated job names that must have succeeded in the reused run, default "check real-tools"
#   MAX_WAIT_SECONDS   longest wait for a run that is still going, default 1500 (25 minutes)
#   POLL_SECONDS       pause between two lookups, default 30
#   NO_RUN_GRACE_SECONDS  how long to keep looking when no run exists yet (a tag pushed seconds after the merge can
#                      beat the creation of the push run), default 60
set -euo pipefail

sha="${1:-}"
if ! [[ "${sha}" =~ ^[0-9a-f]{40}$ ]]; then
  echo "Usage: $0 <40-character commit sha>" >&2
  exit 2
fi
repo="${GITHUB_REPOSITORY:-}"
if [ -z "${repo}" ]; then
  echo "GITHUB_REPOSITORY (owner/name) is not set" >&2
  exit 2
fi
workflow="${CI_WORKFLOW:-ci.yml}"
required_jobs="${REQUIRED_JOBS:-check real-tools}"
max_wait="${MAX_WAIT_SECONDS:-1500}"
poll="${POLL_SECONDS:-30}"
grace="${NO_RUN_GRACE_SECONDS:-60}"

log() { echo "find-green-ci: $*" >&2; }

# Prints the decision and ends the script.
decide() {
  local reuse="$1" reason="$2" run_id="${3:-}"
  echo "reuse=${reuse}"
  echo "reason=${reason}"
  echo "run_id=${run_id}"
  if [ -n "${GITHUB_OUTPUT:-}" ]; then
    {
      echo "reuse=${reuse}"
      echo "reason=${reason}"
      echo "run_id=${run_id}"
    } >> "${GITHUB_OUTPUT}"
  fi
  if [ "${reuse}" = "true" ]; then
    log "reusing CI run ${run_id}: ${reason}"
  else
    log "not reusing: ${reason}"
  fi
  exit 0
}

# gh api with a few retries; prints the JSON, or nothing (and returns 1) when GitHub cannot be read.
api() {
  local attempt output
  for attempt in 1 2 3; do
    if output="$(gh api "$1" 2> /dev/null)"; then
      printf '%s' "${output}"
      return 0
    fi
    log "request failed (attempt ${attempt}/3): $1"
    [ "${attempt}" = 3 ] || sleep "${poll}"
  done
  return 1
}

# Succeeds when every required job of the run concluded `success` (a job that is missing or was skipped is not enough).
jobs_succeeded() {
  local run_id="$1" jobs_json
  jobs_json="$(api "repos/${repo}/actions/runs/${run_id}/jobs?filter=latest&per_page=100")" || return 1
  local name
  for name in ${required_jobs}; do
    if ! printf '%s' "${jobs_json}" | jq -e --arg name "${name}" \
      'any(.jobs[]?; .name == $name and .status == "completed" and .conclusion == "success")' > /dev/null; then
      log "run ${run_id}: job '${name}' did not succeed"
      return 1
    fi
  done
  return 0
}

started="${SECONDS}"
while true; do
  runs_json="$(api "repos/${repo}/actions/workflows/${workflow}/runs?head_sha=${sha}&event=push&per_page=100")" ||
    decide false "the workflow runs of ${sha} could not be read from the GitHub API"

  # Only runs of this exact commit and of the push event count, whatever the API returned.
  summary="$(printf '%s' "${runs_json}" | jq -c --arg sha "${sha}" '
    [.workflow_runs[]? | select(.head_sha == $sha and .event == "push")] as $runs
    | {
        green: [$runs[] | select(.status == "completed" and .conclusion == "success") | .id],
        pending: [$runs[] | select(.status != "completed") | .id],
        other: [$runs[] | select(.status == "completed" and .conclusion != "success") | "\(.id):\(.conclusion)"]
      }')" || decide false "the answer of the GitHub API could not be parsed"
  log "runs of ${sha}: ${summary}"

  for run_id in $(printf '%s' "${summary}" | jq -r '.green[]'); do
    if jobs_succeeded "${run_id}"; then
      decide true "the push run of ${workflow} for this commit succeeded" "${run_id}"
    fi
  done

  pending="$(printf '%s' "${summary}" | jq -r '.pending | length')"
  other="$(printf '%s' "${summary}" | jq -r '.other | join(", ")')"
  green="$(printf '%s' "${summary}" | jq -r '.green | length')"
  elapsed=$((SECONDS - started))

  if [ "${pending}" -gt 0 ]; then
    if [ "${elapsed}" -ge "${max_wait}" ]; then
      decide false "a push run of ${workflow} for this commit was still running after ${max_wait} seconds"
    fi
    log "a push run is still going; waiting ${poll}s (${elapsed}s of ${max_wait}s used)"
    sleep "${poll}"
    continue
  fi

  if [ "${green}" -gt 0 ]; then
    decide false "a push run succeeded but its required jobs (${required_jobs}) did not all succeed"
  fi
  if [ -n "${other}" ]; then
    decide false "the push run(s) of ${workflow} for this commit did not succeed (${other})"
  fi
  # No push run at all: it may be about to be created.
  if [ "${elapsed}" -lt "${grace}" ]; then
    log "no push run yet; looking again in ${poll}s"
    sleep "${poll}"
    continue
  fi
  decide false "there is no push run of ${workflow} for this commit"
done
