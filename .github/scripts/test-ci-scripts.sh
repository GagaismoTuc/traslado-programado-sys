#!/bin/sh
# Tests for the CI scripts, run against throwaway repositories that are never pushed.
# Needs git and docker. Usage: sh .github/scripts/test-ci-scripts.sh
# shellcheck disable=SC2016 # workflow lines are matched literally, ${{ }} included
scripts=$(cd "$(dirname "$0")" && pwd)
hook=$scripts/../../.githooks/commit-msg
workflow=$scripts/../workflows/ci.yml
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
failures=0

check() { # check <test name> <condition exit code>
  if [ "$2" -eq 0 ]; then echo "ok - $1"; else echo "not ok - $1" >&2; failures=$((failures + 1)); fi
}

new_repo() { # new_repo <dir>: a repo with one base commit on main
  git init -q -b main "$1"
  git -C "$1" config user.name test
  git -C "$1" config user.email test@example.com
  git -C "$1" config commit.gpgsign false
  git -C "$1" config core.autocrlf false
  git -C "$1" commit -q --no-verify --allow-empty -m "chore: base"
}

commit() { # commit <repo> <message>: prints the new sha
  git -C "$1" commit -q --no-verify --allow-empty -m "$2"
  git -C "$1" rev-parse HEAD
}

job() { # job <name>: the lines of that job in the workflow
  awk -v start="  $1:" '$0 == start { found = 1; next } /^  [a-z-]+:$/ { found = 0 } found' "$workflow"
}

pr_range() { # pr_range <job> <script>: the job runs <script> on the PR's base..head
  job "$1" | grep -qF "run: sh .github/scripts/$2 \"\$BASE_SHA\" \"\$HEAD_SHA\"" \
    && job "$1" | grep -qF 'BASE_SHA: ${{ github.event.pull_request.base.sha }}' \
    && job "$1" | grep -qF 'HEAD_SHA: ${{ github.event.pull_request.head.sha }}'
}

lint() { # lint <repo> <base> <head>
  (cd "$1" && sh "$scripts/lint-commits.sh" "$2" "$3") > /dev/null 2>&1
}

t="lint rejects a PR commit with a non-conventional header"
repo=$tmp/rule1-red
new_repo "$repo"
base=$(git -C "$repo" rev-parse HEAD)
commit "$repo" "fix(api): valida el id" > /dev/null
head=$(commit "$repo" "agregué cosas")
lint "$repo" "$base" "$head"
red=$?
# The workflow must hand the PR range to the lint, or it takes the empty-range path and passes.
pr_range commitlint lint-commits.sh
check "$t" $((red != 1 || $? != 0))

t="lint accepts a PR whose commits all have conventional headers"
repo=$tmp/rule1-green
new_repo "$repo"
base=$(git -C "$repo" rev-parse HEAD)
commit "$repo" "feat(traslados): agrega alta de traslado" > /dev/null
head=$(commit "$repo" "fix(api): valida el id")
lint "$repo" "$base" "$head"
check "$t" $?

t="gitleaks flags a fake AWS key committed on a throwaway branch"
repo=$tmp/rule2
new_repo "$repo"
git -C "$repo" checkout -q -b descartable
base=$(git -C "$repo" rev-parse HEAD)
# Invented at run time so no key-shaped string lives in this repository.
fake=$(printf 'AKIA'; LC_ALL=C tr -dc 'A-Z2-7' < /dev/urandom | head -c 16)
printf '[default]\naws_access_key_id = %s\n' "$fake" > "$repo/credentials"
git -C "$repo" add credentials
head=$(commit "$repo" "chore: agrega credenciales")
out=$(sh "$scripts/gitleaks.sh" "$base" "$head" "$repo" 2>&1)
status=$?
[ $status -ne 0 ] && printf '%s' "$out" | grep -q 'aws-access-token' \
  && ! printf '%s' "$out" | grep -q "$fake" \
  && pr_range gitleaks gitleaks.sh
check "$t" $?

t="ci-ok passes only when every job finished in success"
ok=0
sh "$scripts/ci-ok.sh" success success success success > /dev/null || ok=1
for bad in failure cancelled skipped; do
  sh "$scripts/ci-ok.sh" success "$bad" success success > /dev/null 2>&1 && ok=1
done
sh "$scripts/ci-ok.sh" > /dev/null 2>&1 && ok=1
# Without if: always() a failed need skips ci-ok instead of failing it.
job ci-ok | grep -qF 'if: always()' || ok=1
job ci-ok | grep -qF 'needs: [verify, e2e, deploy-tests, commitlint, gitleaks]' || ok=1
job ci-ok | grep -qF "RESULTS: \${{ join(needs.*.result, ' ') }}" || ok=1
check "$t" $ok

t="lint gives the same verdict as .githooks/commit-msg"
repo=$tmp/rule4
new_repo "$repo"
ok=0
for header in "feat(traslados): agrega alta" "fix!: cambia el contrato" "agregué cosas" \
  "Fix: mayúscula" "feat(API): scope en mayúsculas" "feat:sin espacio" \
  "Merge branch 'main' into feature" "Revert \"feat: algo\"" "fixup! feat: algo"; do
  printf '%s\n' "$header" > "$tmp/msg"
  sh "$hook" "$tmp/msg" > /dev/null 2>&1
  expected=$?
  sha=$(commit "$repo" "$header")
  lint "$repo" "$sha^" "$sha"
  actual=$?
  if [ $expected -ne $actual ]; then echo "  differs: $header (hook $expected, lint $actual)" >&2; ok=1; fi
done
check "$t" $ok

t="lint passes on a push to main with no PR commits"
(cd "$tmp" && sh "$scripts/lint-commits.sh" "" "") > /dev/null
check "$t" $?

[ $failures -eq 0 ] || { echo "$failures test(s) failed" >&2; exit 1; }
