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
job ci-ok | grep -qF 'needs: [verify, e2e, commitlint, gitleaks]' || ok=1
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

wizard=$scripts/../../infra/wizard/hosting.sh

t="hosting.sh --check lists exactly 9 stages and the contract secrets for #36 and #37"
ok=0
out=$(bash "$wizard" --check 2>&1) || ok=1
stages_count=$(printf '%s\n' "$out" | grep -cE '^[0-9]+\. ')
[ "$stages_count" -eq 9 ] || ok=1
expected_secrets="DEPLOY_HOST
DEPLOY_USER
DEPLOY_SSH_KEY
DEPLOY_KNOWN_HOSTS
PRODUCTION_HOST
STAGING_HOST
SCW_ACCESS_KEY
SCW_SECRET_KEY
SCW_BUCKET"
actual_secrets=$(printf '%s\n' "$out" | awk '/^SECRETS:/{flag=1; next} flag && NF {print $1}')
[ "$actual_secrets" = "$expected_secrets" ] || ok=1
mutated_wiz=$tmp/mutated_wizard.sh
sed 's/set_secret "SCW_BUCKET"/set_secret "WRONG_BUCKET"/' "$wizard" > "$mutated_wiz"
mutated_out=$(bash "$mutated_wiz" --check 2>&1)
mutated_secrets=$(printf '%s\n' "$mutated_out" | awk '/^SECRETS:/{flag=1; next} flag && NF {print $1}')
if [ "$mutated_secrets" = "$actual_secrets" ] || ! printf '%s\n' "$mutated_secrets" | grep -q 'WRONG_BUCKET'; then
  ok=1
fi
check "$t" $ok

t="hosting.sh region validation permits Germany and Paris and rejects others citing Ley 25.326"
ok=0
bash "$wizard" --validate-vps-region nbg1 > /dev/null 2>&1 || ok=1
bash "$wizard" --validate-vps-region fsn1 > /dev/null 2>&1 || ok=1
out_fsn_hel=$(bash "$wizard" --validate-vps-region fsn1-hel1 2>&1)
res_fsn_hel=$?
[ $res_fsn_hel -ne 0 ] && printf '%s' "$out_fsn_hel" | grep -q 'Ley 25.326' || ok=1
out_hel=$(bash "$wizard" --validate-vps-region hel1 2>&1)
res_hel=$?
[ $res_hel -ne 0 ] && printf '%s' "$out_hel" | grep -q 'Ley 25.326' || ok=1
out_ash=$(bash "$wizard" --validate-vps-region ash 2>&1)
res_ash=$?
[ $res_ash -ne 0 ] && printf '%s' "$out_ash" | grep -q 'Ley 25.326' || ok=1
bash "$wizard" --validate-bucket-region fr-par > /dev/null 2>&1 || ok=1
out_fr_ams=$(bash "$wizard" --validate-bucket-region fr-par-nl-ams 2>&1)
res_fr_ams=$?
[ $res_fr_ams -ne 0 ] && printf '%s' "$out_fr_ams" | grep -q 'Ley 25.326' || ok=1
out_scw=$(bash "$wizard" --validate-bucket-region nl-ams 2>&1)
res_scw=$?
[ $res_scw -ne 0 ] && printf '%s' "$out_scw" | grep -q 'Ley 25.326' || ok=1
check "$t" $ok

t="hosting.sh maintains clean repository status and leaves no secrets on disk"
ok=0
test_home=$tmp/clean_home
test_tmp=$tmp/clean_tmp
test_state=$tmp/clean_state
mkdir -p "$test_home" "$test_tmp"
git_status_before=$(git status --porcelain)
printf 'STAGE_1_CONFIRMED=true\nHETZNER_IPV4=192.0.2.1\nSTAGE_2_CONFIRMED=true\nSTAGE_3_CONFIRMED=true\nSTAGE_4_CONFIRMED=true\n' > "$test_state"
printf '\ny\ny\ny\ny\nfr-par\nbkt\nAKSENTINEL\nSKSENTINEL\n' | HOME="$test_home" TMPDIR="$test_tmp" WIZARD_STATE_FILE="$test_state" bash "$wizard" > /dev/null 2>&1 || true
if grep -rq 'SENTINEL' "$test_state" "$test_home" "$test_tmp"; then ok=1; fi
git_status_after=$(git status --porcelain)
[ "$git_status_before" = "$git_status_after" ] || ok=1
[ ! -f "$scripts/../../.env" ] || ok=1
check "$t" $ok

t="hosting.sh halts on verification failure and does not continue to next stage"
ok=0
test_halt_state=$tmp/halt_state
test_halt_home=$tmp/halt_home
mkdir -p "$test_halt_home"
printf 'STAGE_1_CONFIRMED=true\nHETZNER_IPV4=192.0.2.1\nSTAGE_2_CONFIRMED=true\nSTAGE_3_CONFIRMED=true\nSTAGE_4_CONFIRMED=true\nSTAGE_5_CONFIRMED=true\nSCW_BUCKET=bkt\n' > "$test_halt_state"
halt_out=$(printf '\ny\ny\ny\ny\ny\nnope.invalid\n\n\n\nn\n' | HOME="$test_halt_home" WIZARD_STATE_FILE="$test_halt_state" bash "$wizard" 2>&1 || true)
if grep -q '^STAGE_6_CONFIRMED=true' "$test_halt_state"; then ok=1; fi
if printf '%s' "$halt_out" | grep -q 'Stage 7/9'; then ok=1; fi
if ! printf '%s' "$halt_out" | grep -q 'Verification failed'; then ok=1; fi
check "$t" $ok

t="hosting.sh resumes from unconfirmed stages and cleans up on interruption"
ok=0
test_resume_state=$tmp/resume_state
test_resume_home=$tmp/resume_home
mkdir -p "$test_resume_home"
printf 'STAGE_1_CONFIRMED=true\nHETZNER_IPV4=192.0.2.1\nSTAGE_2_CONFIRMED=true\n' > "$test_resume_state"
resume_out=$(printf '\ny\ny\n' | HOME="$test_resume_home" WIZARD_STATE_FILE="$test_resume_state" bash "$wizard" 2>&1 || true)
if ! printf '%s' "$resume_out" | grep -q 'Stage 3/9'; then ok=1; fi
test_sigint_dir=$tmp/sigint_test
mkdir -p "$test_sigint_dir"
mkfifo "$test_sigint_dir/fifo" 2>/dev/null || true
if [ -p "$test_sigint_dir/fifo" ]; then
  perl -e '$SIG{INT}="DEFAULT"; exec @ARGV' bash "$wizard" < "$test_sigint_dir/fifo" > "$test_sigint_dir/out" 2>&1 &
  sig_pid=$!
  exec 9>"$test_sigint_dir/fifo"
  sleep 0.5
  kill -INT "$sig_pid" 2>/dev/null || true
  sleep 0.5
  if kill -0 "$sig_pid" 2>/dev/null; then
    kill -9 "$sig_pid" 2>/dev/null || true
    ok=1
  fi
  exec 9>&-
fi
check "$t" $ok

[ $failures -eq 0 ] || { echo "$failures test(s) failed" >&2; exit 1; }
