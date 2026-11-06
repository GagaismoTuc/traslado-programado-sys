#!/bin/sh
# Tests for the CI scripts, run against throwaway repositories that are never pushed.
# Needs git and docker. Usage: sh .github/scripts/test-ci-scripts.sh
# shellcheck disable=SC2016 # workflow lines are matched literally, ${{ }} included
scripts=$(cd "$(dirname "$0")" && pwd)
hook=$scripts/../../.githooks/commit-msg
workflow=$scripts/../workflows/ci.yml
images_workflow=$workflow
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

image_job() { # image_job <name>: the lines of that job in the image workflow
  awk -v start="  $1:" '$0 == start { found = 1; next } /^  [a-z-]+:$/ { found = 0 } found' "$images_workflow"
}

t="image builds are read-only and publishing is restricted to pushes to main"
ok=0
! sed -n '1,/^jobs:/p' "$images_workflow" | grep -q 'packages: write' || ok=1
image_job image | grep -q 'contents: read' || ok=1
image_job image | grep -qF 'for target in api office driver; do' || ok=1
image_job image | grep -qF 'docker build --platform linux/amd64 --provenance=false --target "$target" --tag "$image" .' || ok=1
! image_job image | grep -q 'packages: write' || ok=1
image_job publish | grep -q 'packages: write' || ok=1
[ "$(grep -c 'packages: write' "$images_workflow")" -eq 1 ] || ok=1
image_job publish | grep -qF "if: github.event_name == 'push' && github.ref == 'refs/heads/main'" || ok=1
image_job publish | grep -qF 'needs: [image, ci-ok]' || ok=1
image_job publish | grep -qF 'target: [api, office, driver]' || ok=1
! image_job publish | grep -q 'docker build' || ok=1
image_job publish | grep -qF 'sh .github/scripts/publish-image.sh' || ok=1
check "$t" $ok

sh "$scripts/test-image-publishing.sh" || failures=$((failures + 1))

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

wizard=$scripts/../../infra/wizard/hosting.sh

t="hosting.sh passes shellcheck"
ok=0
if command -v shellcheck > /dev/null 2>&1; then
  shellcheck "$wizard" > /dev/null 2>&1 || ok=1
else
  echo "shellcheck not found in PATH" >&2
  ok=1
fi
check "$t" $ok

t="hosting.sh --check lists exactly 9 stages and the contract secrets for #36 and #37"
ok=0
out=$(bash "$wizard" --check 2>&1) || ok=1
stages_count=$(printf '%s\n' "$out" | grep -cE '^[0-9]+\. ')
[ "$stages_count" -eq 9 ] || ok=1
printf '%s\n' "$out" | grep -q '^1\. Hostinger ' || ok=1
printf '%s\n' "$out" | grep -q '^2\. Hostinger ' || ok=1
if printf '%s\n' "$out" | grep -qi 'hetzner'; then ok=1; fi
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
bash "$wizard" --validate-vps-region Alemania > /dev/null 2>&1 || ok=1
bash "$wizard" --validate-vps-region "Alemania - Frankfurt" > /dev/null 2>&1 || ok=1
bash "$wizard" --validate-vps-region Germany > /dev/null 2>&1 || ok=1
out_boston=$(bash "$wizard" --validate-vps-region "Estados Unidos - Boston 2" 2>&1)
res_boston=$?
[ $res_boston -ne 0 ] && printf '%s' "$out_boston" | grep -Fq 'The VPS must be in Germany (Ley 25.326): choose Alemania' || ok=1
out_hel=$(bash "$wizard" --validate-vps-region hel1 2>&1)
res_hel=$?
[ $res_hel -ne 0 ] && printf '%s' "$out_hel" | grep -q 'Ley 25.326' || ok=1
if bash "$wizard" --validate-vps-region "Not Germany" > /dev/null 2>&1; then ok=1; fi
bash "$wizard" --validate-bucket-region fr-par > /dev/null 2>&1 || ok=1
bash "$wizard" --validate-bucket-region Paris > /dev/null 2>&1 || ok=1
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
test_bin=$tmp/clean_bin
test_state=$tmp/clean_state
test_secrets=$tmp/clean_secrets_received
mkdir -p "$test_home" "$test_tmp" "$test_bin"

for c in xdg-open explorer.exe wslview open; do
  printf '#!/bin/sh\nexit 0\n' > "$test_bin/$c"
done

cat > "$test_bin/ssh" <<'EOF'
#!/bin/sh
case "$*" in
  *PubkeyAuthentication=no*) echo 'Permission denied (publickey).' >&2; exit 255;;
  *root@*) echo 'Permission denied (publickey).' >&2; exit 255;;
  *docker\ manifest*|*docker\ pull*)
    echo '{"schemaVersion": 2, "mediaType": "application/vnd.docker.distribution.manifest.v2+json", "config": {"digest": "sha256:synthetic"}}'
    exit 0
    ;;
  *deploy@*) echo 'Docker version 27.0.0'; exit 0;;
  *) exit 0;;
esac
EOF

cat > "$test_bin/ssh-keygen" <<'EOF'
#!/bin/sh
while [ "$1" != -f ]; do shift; done; shift
printf 'SYNTHETIC_PRIVATE_KEY_SENTINEL\n' > "$1"
printf 'ssh-ed25519 SYNTHETIC_PUBLIC_KEY_SENTINEL deploy-actions\n' > "$1.pub"
EOF

cat > "$test_bin/ssh-keyscan" <<'EOF'
#!/bin/sh
echo '192.0.2.1 ssh-ed25519 SYNTHETIC_KNOWN_HOSTS_SENTINEL'
EOF

cat > "$test_bin/gh" <<'EOF'
#!/bin/sh
case "$1 $2" in
  'auth status') exit 0;;
  'secret set')
    val=$(cat)
    printf '%s=%s\n' "$3" "$val" >> "$RECORD_SECRETS"
    exit 0;;
  'secret list') printf '%s\n' DEPLOY_HOST DEPLOY_USER DEPLOY_SSH_KEY DEPLOY_KNOWN_HOSTS PRODUCTION_HOST STAGING_HOST SCW_ACCESS_KEY SCW_SECRET_KEY SCW_BUCKET; exit 0;;
esac
EOF

cat > "$test_bin/curl" <<'EOF'
#!/bin/sh
case "$*" in
  *s3.fr-par.scw.cloud*) printf 200;;
  *api.uptimerobot.com*) printf '{"stat":"ok","pagination":{"total":1},"monitors":[{"id":1,"friendly_name":"traslado-prod-health","url":"https://example.test/health","interval":300,"status":2,"alert_contacts":[{"value":"alerts@external.test"}]}]}';;
  *) printf 200;;
esac
EOF

cat > "$test_bin/dig" <<'EOF'
#!/bin/sh
echo '192.0.2.1'
EOF
cat > "$test_bin/nslookup" <<'EOF'
#!/bin/sh
echo 'Address: 192.0.2.1'
EOF
chmod +x "$test_bin/"*

repo_root=$(cd "$scripts/../.." && pwd -P)
preexisting_ignored=$(mktemp "$repo_root/.env.preexisting_ignored_XXXXXX")
printf 'PREEXISTING_KEY=preexisting_value\n' > "$preexisting_ignored"
git_status_before=$(git -C "$repo_root" status --porcelain --ignored)

full_run_input=$(printf '%s\n' \
  "" \
  "Alemania" \
  "192.0.2.1" \
  "" \
  "TCP 22, TCP 80, TCP 443" \
  "y" \
  "" \
  "" \
  "" \
  "" \
  "" \
  "fr-par" \
  "bkt-synthetic" \
  "SCW_SYNTHETIC_ACCESS_KEY_SENTINEL" \
  "SCW_SYNTHETIC_SECRET_KEY_SENTINEL" \
  "" \
  "example.test" \
  "example.test" \
  "staging.example.test" \
  "" \
  "" \
  "alerts@external.test" \
  "UR_SYNTHETIC_KEY_SENTINEL" \
  "" \
  "" \
  "")

full_out=$(printf '%s' "$full_run_input" | HOSTINGER_API_TOKEN=HOSTINGER_SYNTHETIC_API_TOKEN_SENTINEL PATH="$test_bin:$PATH" HOME="$test_home" TMPDIR="$test_tmp" WIZARD_STATE_FILE="$test_state" RECORD_SECRETS="$test_secrets" bash "$wizard" 2>&1 || true)

if ! grep -q '^STAGE_9_CONFIRMED=true' "$test_state"; then ok=1; fi
if ! printf '%s' "$full_out" | grep -q 'Setup complete'; then ok=1; fi
if ! grep -q 'SCW_ACCESS_KEY=SCW_SYNTHETIC_ACCESS_KEY_SENTINEL' "$test_secrets"; then ok=1; fi
if ! grep -q 'SCW_SECRET_KEY=SCW_SYNTHETIC_SECRET_KEY_SENTINEL' "$test_secrets"; then ok=1; fi
if ! grep -q 'DEPLOY_SSH_KEY=SYNTHETIC_PRIVATE_KEY_SENTINEL' "$test_secrets"; then ok=1; fi
if grep -rq 'SENTINEL' "$test_state" "$test_home" "$test_tmp"; then ok=1; fi
if printf '%s' "$full_out" | grep -E -q 'SYNTHETIC_PRIVATE_KEY_SENTINEL|SCW_SYNTHETIC_SECRET_KEY_SENTINEL|UR_SYNTHETIC_KEY_SENTINEL|SCW_SYNTHETIC_ACCESS_KEY_SENTINEL|HOSTINGER_SYNTHETIC_API_TOKEN_SENTINEL'; then ok=1; fi

git_status_after=$(git -C "$repo_root" status --porcelain --ignored)
[ "$git_status_before" = "$git_status_after" ] || ok=1
[ ! -f "$scripts/../../.env" ] || ok=1
[ ! -f "$scripts/../../infra/wizard/.env" ] || ok=1
if git -C "$repo_root" grep -q 'SYNTHETIC_PRIVATE_KEY_SENTINEL' -- ':!.github/scripts/test-ci-scripts.sh' 2>/dev/null; then ok=1; fi

if grep -q 'SENTINEL' "$preexisting_ignored" 2>/dev/null; then ok=1; fi
rm -f "$preexisting_ignored"

leaked_sentinel_files=$(find "$repo_root" -maxdepth 4 \( -name "node_modules" -o -name "dist" -o -name ".git" \) -prune -o -type f -print | while IFS= read -r f; do
  case "$f" in
    */test-ci-scripts.sh|*/pr-107-body.md|*/odd/tasks/issue-105.md) continue ;;
    *)
      if grep -q 'SENTINEL' "$f" 2>/dev/null; then
        echo "$f"
      fi
      ;;
  esac
done)
if [ -n "$leaked_sentinel_files" ]; then ok=1; fi
check "$t" $ok

t="hosting.sh halts on verification failure and does not continue to next stage"
ok=0
test_halt_state=$tmp/halt_state
test_halt_home=$tmp/halt_home
test_halt_bin=$tmp/halt_bin
mkdir -p "$test_halt_home" "$test_halt_bin"
for c in dig nslookup wslview explorer.exe xdg-open open; do printf '#!/bin/sh\nexit 1\n' > "$test_halt_bin/$c"; done
chmod +x "$test_halt_bin/"*
printf 'STAGE_1_CONFIRMED=true\nHETZNER_IPV4=192.0.2.1\nSTAGE_2_CONFIRMED=true\nSTAGE_3_CONFIRMED=true\nSTAGE_4_CONFIRMED=true\nSTAGE_5_CONFIRMED=true\nSCW_BUCKET=bkt\n' > "$test_halt_state"
halt_out=$(printf '\ny\ny\ny\ny\ny\nnope.invalid\n\n\n\ny\nn\n' | PATH="$test_halt_bin:$PATH" HOME="$test_halt_home" WIZARD_STATE_FILE="$test_halt_state" bash "$wizard" 2>&1 || true)
if grep -q '^STAGE_6_CONFIRMED=true' "$test_halt_state"; then ok=1; fi
if printf '%s' "$halt_out" | grep -q 'Stage 7/9'; then ok=1; fi
if ! printf '%s' "$halt_out" | grep -q 'Verification failed'; then ok=1; fi
check "$t" $ok

t="hosting.sh resumes from unconfirmed stages and cleans up on interruption"
ok=0
test_resume_state=$tmp/resume_state
test_resume_home=$tmp/resume_home
test_resume_bin=$tmp/resume_bin
mkdir -p "$test_resume_home" "$test_resume_bin"
for c in ssh wslview explorer.exe xdg-open open; do printf '#!/bin/sh\nexit 1\n' > "$test_resume_bin/$c"; done
chmod +x "$test_resume_bin/"*
printf 'STAGE_1_CONFIRMED=true\nHETZNER_IPV4=192.0.2.1\nSTAGE_2_CONFIRMED=true\n' > "$test_resume_state"
resume_out=$(printf '\ny\ny\n' | PATH="$test_resume_bin:$PATH" HOME="$test_resume_home" WIZARD_STATE_FILE="$test_resume_state" bash "$wizard" 2>&1 || true)
if ! printf '%s' "$resume_out" | grep -q 'Stage 3/9'; then ok=1; fi

# Interruption test while temporary deploy key exists on disk (covers INT and HUP)
for test_sig in INT HUP; do
  test_sig_dir=$tmp/sig_test_${test_sig}
  test_sig_bin=$test_sig_dir/bin
  test_sig_home=$test_sig_dir/home
  test_sig_tmp=$test_sig_dir/tmp
  test_sig_state=$test_sig_dir/state
  mkdir -p "$test_sig_bin" "$test_sig_home" "$test_sig_tmp"
  for c in xdg-open explorer.exe wslview open; do
    printf '#!/bin/sh\nexit 0\n' > "$test_sig_bin/$c"
  done
  cat > "$test_sig_bin/ssh" <<'EOF'
#!/bin/sh
exit 0
EOF

  printf 'STAGE_1_CONFIRMED=true\nHETZNER_IPV4=192.0.2.1\nSTAGE_2_CONFIRMED=true\nSTAGE_3_CONFIRMED=true\nSTAGE_4_CONFIRMED=true\nSTAGE_5_CONFIRMED=true\nSCW_BUCKET=bkt\nSTAGE_6_CONFIRMED=true\nPRODUCTION_HOST=example.test\nSTAGING_HOST=staging.example.test\nSTAGE_7_CONFIRMED=true\n' > "$test_sig_state"

  cat > "$test_sig_bin/gh" <<'EOF'
#!/bin/sh
case "$1 $2" in
  'auth status') exit 0;;
  'secret set') exit 0;;
  'secret list') printf '%s\n' DEPLOY_HOST DEPLOY_USER DEPLOY_SSH_KEY DEPLOY_KNOWN_HOSTS PRODUCTION_HOST STAGING_HOST SCW_ACCESS_KEY SCW_SECRET_KEY SCW_BUCKET; exit 0;;
esac
EOF

  cat > "$test_sig_bin/ssh-keygen" <<'EOF'
#!/bin/sh
while [ "$1" != -f ]; do shift; done; shift
printf '%s\n' "$1" > "$KEY_RECORD"
printf 'PRIVATE_KEY_SENTINEL_DURING_RUN\n' > "$1"
printf 'ssh-ed25519 PUBLIC_KEY_SENTINEL_DURING_RUN deploy-actions\n' > "$1.pub"
EOF

  cat > "$test_sig_bin/ssh-keyscan" <<EOF
#!/bin/sh
key_file=\$(cat "\$KEY_RECORD" 2>/dev/null || true)
if [ -n "\$key_file" ] && [ -f "\$key_file" ]; then
  printf 'KEY_EXISTED_ON_DISK\n' > "\$KEY_EXISTED_RECORD"
fi
target_pid="\${WIZARD_PID:-\$PPID}"
if [ -n "\$target_pid" ]; then
  kill -$test_sig "\$target_pid" 2>/dev/null || true
fi
exit 1
EOF
  chmod +x "$test_sig_bin/"*

  sig_inputs=$(printf '%s\n' "" "y" "y" "y" "y" "y" "y" "y" "access" "secret" "")
  printf '%s' "$sig_inputs" | KEY_RECORD="$test_sig_dir/key_file" KEY_EXISTED_RECORD="$test_sig_dir/key_existed" PATH="$test_sig_bin:$PATH" HOME="$test_sig_home" TMPDIR="$test_sig_tmp" WIZARD_STATE_FILE="$test_sig_state" bash "$wizard" >/dev/null 2>&1 || true

  if [ ! -f "$test_sig_dir/key_existed" ] || ! grep -q 'KEY_EXISTED_ON_DISK' "$test_sig_dir/key_existed"; then
    ok=1
  fi
  key_path=$(cat "$test_sig_dir/key_file" 2>/dev/null || true)
  if [ -n "$key_path" ] && [ -e "$key_path" ]; then
    ok=1
  fi
  if grep -rq 'PRIVATE_KEY_SENTINEL_DURING_RUN' "$test_sig_home" "$test_sig_tmp" "$test_sig_state"; then
    ok=1
  fi
  if grep -q '^STAGE_8_CONFIRMED=true' "$test_sig_state"; then
    ok=1
  fi

  retest_inputs=$(printf '%s\n' "" "y" "y" "y" "y" "y" "y" "y")
  retest_out=$(printf '%s' "$retest_inputs" | PATH="$test_sig_bin:$PATH" HOME="$test_sig_home" TMPDIR="$test_sig_tmp" WIZARD_STATE_FILE="$test_sig_state" bash "$wizard" 2>&1 || true)
  if ! printf '%s' "$retest_out" | grep -q 'Stage 8/9'; then
    ok=1
  fi
done

check "$t" $ok

t="hosting.sh stage 7 halts when monitor interval does not match within the same object"
ok=0
test_ur_dir=$tmp/ur_test
mkdir -p "$test_ur_dir/bin" "$test_ur_dir/home"
for c in wslview explorer.exe xdg-open open; do printf '#!/bin/sh\nexit 0\n' > "$test_ur_dir/bin/$c"; done
cat > "$test_ur_dir/bin/curl" <<'EOF'
#!/bin/sh
# Monitor URL matches but interval is 5 instead of required 300 seconds
printf '%s' '{"stat":"ok","monitors":[{"url":"https://example.test/health","interval":5},{"url":"https://other.test/health","interval":300}]}'
EOF
chmod +x "$test_ur_dir/bin/"*
test_ur_state=$test_ur_dir/state
printf "HETZNER_IPV4='192.0.2.1'\nSCW_BUCKET='bucket'\nDOMAIN_NAME='example.test'\nPRODUCTION_HOST='example.test'\nSTAGING_HOST='staging.example.test'\n" > "$test_ur_state"
for i in 1 2 3 4 5 6; do echo "STAGE_${i}_CONFIRMED=true" >> "$test_ur_state"; done
ur_out=$(printf '\ny\ny\ny\ny\ny\ny\nalerts@external.test\nsynthetic-key\nn\n' | \
  PATH="$test_ur_dir/bin:$PATH" HOME="$test_ur_dir/home" WIZARD_STATE_FILE="$test_ur_state" bash "$wizard" 2>&1 || true)
if grep -q '^STAGE_7_CONFIRMED=true' "$test_ur_state"; then
  ok=1
fi
if ! printf '%s' "$ur_out" | grep -q 'UptimeRobot monitor verification failed'; then
  ok=1
fi
check "$t" $ok

t="hosting.sh stage 7 halts when monitor has empty alert contacts"
ok=0
test_ur_nocontacts_dir=$tmp/ur_nocontacts_test
mkdir -p "$test_ur_nocontacts_dir/bin" "$test_ur_nocontacts_dir/home"
for x in wslview explorer.exe xdg-open open; do printf '#!/bin/sh\nexit 0\n' > "$test_ur_nocontacts_dir/bin/$x"; done
cat > "$test_ur_nocontacts_dir/bin/curl" <<'STUB'
#!/bin/sh
cat >/dev/null
printf '%s' '{"stat":"ok","monitors":[{"url":"https://example.test/health","interval":300,"alert_contacts":[]}]}'
STUB
chmod +x "$test_ur_nocontacts_dir/bin/"*
printf "HETZNER_IPV4='192.0.2.1'\nSCW_BUCKET='bucket'\nDOMAIN_NAME='example.test'\nPRODUCTION_HOST='example.test'\nSTAGING_HOST='staging.example.test'\n" > "$test_ur_nocontacts_dir/state"
for i in 1 2 3 4 5 6; do echo "STAGE_${i}_CONFIRMED=true" >> "$test_ur_nocontacts_dir/state"; done
printf '\ny\ny\ny\ny\ny\ny\nalerts@outside.test\ntoken\n\n' | PATH="$test_ur_nocontacts_dir/bin:$PATH" HOME="$test_ur_nocontacts_dir/home" WIZARD_STATE_FILE="$test_ur_nocontacts_dir/state" bash "$wizard" > "$test_ur_nocontacts_dir/out" 2>&1 || true
if grep -q '^STAGE_7_CONFIRMED=true' "$test_ur_nocontacts_dir/state"; then
  ok=1
fi
check "$t" $ok

t="hosting.sh stage 1 halts when port 22 is unreachable with No route to host"
ok=0
test_p22_dir=$tmp/p22_test
mkdir -p "$test_p22_dir/bin" "$test_p22_dir/home"
for c in wslview explorer.exe xdg-open open; do printf '#!/bin/sh\nexit 0\n' > "$test_p22_dir/bin/$c"; done
cat > "$test_p22_dir/bin/ssh" <<'EOF'
#!/bin/sh
echo 'ssh: connect to host 192.0.2.1 port 22: No route to host' >&2
exit 255
EOF
chmod +x "$test_p22_dir/bin/"*
test_p22_state=$test_p22_dir/state
printf '\nAlemania\n192.0.2.1\nn\n' | \
  PATH="$test_p22_dir/bin:$PATH" HOME="$test_p22_dir/home" WIZARD_STATE_FILE="$test_p22_state" bash "$wizard" >/dev/null 2>&1 || true
if [ -f "$test_p22_state" ] && grep -q '^STAGE_1_CONFIRMED=true' "$test_p22_state"; then
  ok=1
fi
check "$t" $ok

t="hosting.sh stage 1 refuses a VPS outside Germany and does not mark the stage done"
ok=0
loc_dir=$tmp/loc_test
mkdir -p "$loc_dir/bin" "$loc_dir/home"
for c in wslview explorer.exe xdg-open open ssh; do printf '#!/bin/sh\nexit 0\n' > "$loc_dir/bin/$c"; done
chmod +x "$loc_dir/bin/"*
loc_rc=0
printf '\nEstados Unidos - Boston 2\nn\n' | \
  PATH="$loc_dir/bin:$PATH" HOME="$loc_dir/home" WIZARD_STATE_FILE="$loc_dir/state" bash "$wizard" > "$loc_dir/out" 2>&1 || loc_rc=$?
[ "$loc_rc" -ne 0 ] || ok=1
grep -Fq 'The VPS must be in Germany (Ley 25.326): choose Alemania' "$loc_dir/out" || ok=1
if [ -f "$loc_dir/state" ] && grep -q '^STAGE_1_CONFIRMED=' "$loc_dir/state"; then ok=1; fi
if grep -q 'Stage 2/9' "$loc_dir/out"; then ok=1; fi
check "$t" $ok

t="hosting.sh stages 1 and 2 only open hPanel, never call a Hostinger API, and pass with exactly TCP 22, 80 and 443"
ok=0
hp_dir=$tmp/hpanel_test
mkdir -p "$hp_dir/bin" "$hp_dir/home"
for c in wslview explorer.exe xdg-open open; do
  printf '#!/bin/sh\nprintf "%%s\n" "$1" >> "$URL_RECORD"\n' > "$hp_dir/bin/$c"
done
for c in curl wget; do
  printf '#!/bin/sh\nprintf "%%s\n" "$*" >> "$NET_RECORD"\nexit 1\n' > "$hp_dir/bin/$c"
done
printf '#!/bin/sh\nexit 0\n' > "$hp_dir/bin/ssh"
chmod +x "$hp_dir/bin/"*
printf '\nAlemania\n192.0.2.1\n\nTCP 22 Any, TCP 80 Any, TCP 443 Any\ny\n\n' | \
  URL_RECORD="$hp_dir/urls" NET_RECORD="$hp_dir/net" PATH="$hp_dir/bin:$PATH" HOME="$hp_dir/home" \
  WIZARD_STATE_FILE="$hp_dir/state" bash "$wizard" > "$hp_dir/out" 2>&1 || true
grep -q '^STAGE_1_CONFIRMED=true' "$hp_dir/state" || ok=1
grep -q '^STAGE_2_CONFIRMED=true' "$hp_dir/state" || ok=1
grep -qx "VPS_IPV4='192.0.2.1'" "$hp_dir/state" || ok=1
grep -qx "VPS_LOCATION='Alemania'" "$hp_dir/state" || ok=1
grep -q 'Stage 3/9' "$hp_dir/out" || ok=1
for hp_step in 'KVM 2' 'Location: choose Alemania' 'Ubuntu 24.04 LTS' 'SSH public key' 'public IPv4' 'TCP 22 (SSH)' 'TCP 80 (HTTP)' 'TCP 443 (HTTPS)'; do
  grep -Fq "$hp_step" "$hp_dir/out" || { echo "  hPanel steps: missing '$hp_step'" >&2; ok=1; }
done
[ -s "$hp_dir/urls" ] || ok=1
if grep -qv '^https://hpanel\.hostinger\.com' "$hp_dir/urls"; then ok=1; fi
if [ -f "$hp_dir/net" ] && grep -qi 'hostinger' "$hp_dir/net"; then ok=1; fi
check "$t" $ok

t="hosting.sh stage 2 fails and names any inbound rule other than exactly TCP 22, 80 and 443"
ok=0
for scenario in extra missing udp inactive; do
  fwr_dir=$tmp/fw_rules_$scenario
  mkdir -p "$fwr_dir/bin" "$fwr_dir/home"
  for c in wslview explorer.exe xdg-open open ssh; do printf '#!/bin/sh\nexit 0\n' > "$fwr_dir/bin/$c"; done
  chmod +x "$fwr_dir/bin/"*
  printf "STAGE_1_CONFIRMED=true\nVPS_IPV4='192.0.2.1'\n" > "$fwr_dir/state"
  case "$scenario" in
    extra) fwr_input='\ny\nTCP 22, TCP 80, TCP 443, TCP 3000\nn\n'; fwr_expect='Remove these inbound rules: TCP 3000' ;;
    missing) fwr_input='\ny\nTCP 22, TCP 80\nn\n'; fwr_expect='Add these inbound rules: TCP 443' ;;
    udp) fwr_input='\ny\nTCP 22, TCP 80, TCP 443, UDP 53\nn\n'; fwr_expect='Remove these inbound rules: UDP 53' ;;
    inactive) fwr_input='\ny\nTCP 22, TCP 80, TCP 443\nn\nn\n'; fwr_expect='The firewall is not activated on the VPS 192.0.2.1' ;;
  esac
  # shellcheck disable=SC2059
  printf "$fwr_input" | PATH="$fwr_dir/bin:$PATH" HOME="$fwr_dir/home" WIZARD_STATE_FILE="$fwr_dir/state" bash "$wizard" > "$fwr_dir/out" 2>&1 || true
  if grep -q '^STAGE_2_CONFIRMED=' "$fwr_dir/state" || grep -q 'Stage 3/9' "$fwr_dir/out"; then ok=1; fi
  grep -Fq "$fwr_expect" "$fwr_dir/out" || { echo "  stage 2 $scenario: missing '$fwr_expect'" >&2; ok=1; }
done
check "$t" $ok

t="hosting.sh reads a Hetzner-era state file and offers to skip stage 1 with the saved IPv4"
ok=0
legacy_dir=$tmp/legacy_state_test
mkdir -p "$legacy_dir/bin" "$legacy_dir/home"
for c in wslview explorer.exe xdg-open open ssh; do printf '#!/bin/sh\nexit 0\n' > "$legacy_dir/bin/$c"; done
chmod +x "$legacy_dir/bin/"*
printf 'STAGE_1_CONFIRMED=true\nHETZNER_IPV4=192.0.2.1\n' > "$legacy_dir/state"
printf '\ny\n' | PATH="$legacy_dir/bin:$PATH" HOME="$legacy_dir/home" WIZARD_STATE_FILE="$legacy_dir/state" bash "$wizard" > "$legacy_dir/out" 2>&1 || true
grep -Fq 'Stage 1 already completed (IPv4: 192.0.2.1). Skip to next stage?' "$legacy_dir/out" || ok=1
grep -q 'Stage 2/9' "$legacy_dir/out" || ok=1
grep -qx "VPS_IPV4='192.0.2.1'" "$legacy_dir/state" || ok=1
check "$t" $ok

t="hosting.sh stage 3 halts if root login with ssh key is accepted"
ok=0
test_root_dir=$tmp/root_test
mkdir -p "$test_root_dir/bin" "$test_root_dir/home"
for c in wslview explorer.exe xdg-open open; do printf '#!/bin/sh\nexit 0\n' > "$test_root_dir/bin/$c"; done
cat > "$test_root_dir/bin/ssh" <<'EOF'
#!/bin/sh
case "$*" in
  *PreferredAuthentications=none*deploy@*)
    echo 'Permission denied (publickey).' >&2
    exit 255
    ;;
  *root@*)
    echo 'Linux hetzner 6.8.0'
    exit 0
    ;;
  *deploy@*)
    echo 'Docker version 27.0.0'
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
EOF
chmod +x "$test_root_dir/bin/"*
test_root_state=$test_root_dir/state
printf 'STAGE_1_CONFIRMED=true\nHETZNER_IPV4=192.0.2.1\nSTAGE_2_CONFIRMED=true\n' > "$test_root_state"
root_out=$(printf '\ny\ny\ny\nn\n' | \
  PATH="$test_root_dir/bin:$PATH" HOME="$test_root_dir/home" WIZARD_STATE_FILE="$test_root_state" bash "$wizard" 2>&1 || true)
if grep -q '^STAGE_3_CONFIRMED=true' "$test_root_state"; then
  ok=1
fi
if ! printf '%s' "$root_out" | grep -q 'Verifying root login'; then
  ok=1
fi
if ! printf '%s' "$root_out" | grep -q 'Root login was accepted'; then
  ok=1
fi
check "$t" $ok

t="hosting.sh stage 4 rejects unsafe OSRM_IMAGE before SSH"
ok=0
image_dir=$tmp/image_validation
mkdir -p "$image_dir/bin" "$image_dir/home"
for c in wslview explorer.exe xdg-open open; do printf '#!/bin/sh\nexit 0\n' > "$image_dir/bin/$c"; done
cat > "$image_dir/bin/ssh" <<'EOF'
#!/bin/sh
printf '%s\n' "$*" >> "$SSH_CALLS"
echo '{"schemaVersion":2}'
EOF
chmod +x "$image_dir/bin/"*
for image in 'x y' 'x; rm -rf ~' 'x$(touch sentinel)' 'x`touch sentinel`'; do
  printf 'STAGE_1_CONFIRMED=true\nHETZNER_IPV4=192.0.2.1\nSTAGE_2_CONFIRMED=true\nSTAGE_3_CONFIRMED=true\n' > "$image_dir/state"
  rm -f "$image_dir/calls"
  printf '\ny\ny\ny\n\nn\n' | PATH="$image_dir/bin:$PATH" HOME="$image_dir/home" WIZARD_STATE_FILE="$image_dir/state" SSH_CALLS="$image_dir/calls" OSRM_IMAGE="$image" bash "$wizard" > "$image_dir/out" 2>&1 && ok=1
  [ ! -e "$image_dir/calls" ] || ok=1
  grep -q 'OSRM_IMAGE' "$image_dir/out" || ok=1
  ! grep -q '^STAGE_4_CONFIRMED=true' "$image_dir/state" || ok=1
done
check "$t" $ok

t="hosting.sh stage 4 passes valid OSRM_IMAGE as one quoted remote argument"
ok=0
for image in 'ghcr.io/gagaismotuc/traslado-osrm:tucuman-260101-osrm26.4.0-r1' '[::1]:5000/osrm:latest' 'Registry.EXAMPLE.com/osrm:latest'; do
  printf 'STAGE_1_CONFIRMED=true\nHETZNER_IPV4=192.0.2.1\nSTAGE_2_CONFIRMED=true\nSTAGE_3_CONFIRMED=true\n' > "$image_dir/state"
  rm -f "$image_dir/calls"
  printf '\ny\ny\ny\n\n\n\n' | PATH="$image_dir/bin:$PATH" HOME="$image_dir/home" WIZARD_STATE_FILE="$image_dir/state" SSH_CALLS="$image_dir/calls" OSRM_IMAGE="$image" bash "$wizard" > "$image_dir/out" 2>&1 || true
  grep -q '^STAGE_4_CONFIRMED=true' "$image_dir/state" || ok=1
  grep -Fq "docker manifest inspect '$image' 2>&1 || docker pull '$image' 2>&1" "$image_dir/calls" || ok=1
done
check "$t" $ok

t="hosting.sh stage 4 accepts valid registry hosts and digest algorithms"
ok=0
sha512=$(printf 'b%.0s' $(seq 128))
for image in 'xn--80ak6aa92e.com:443/osrm:latest' 'my--registry.example.com:5000/osrm:latest' "registry.example.com/osrm@sha512:$sha512"; do
  printf 'STAGE_1_CONFIRMED=true\nHETZNER_IPV4=192.0.2.1\nSTAGE_2_CONFIRMED=true\nSTAGE_3_CONFIRMED=true\n' > "$image_dir/state"
  rm -f "$image_dir/calls"
  printf '\ny\ny\ny\n\n\n\n' | PATH="$image_dir/bin:$PATH" HOME="$image_dir/home" WIZARD_STATE_FILE="$image_dir/state" SSH_CALLS="$image_dir/calls" OSRM_IMAGE="$image" bash "$wizard" > "$image_dir/out" 2>&1 || true
  if ! grep -q '^STAGE_4_CONFIRMED=true' "$image_dir/state"; then
    echo "rejected valid image: $image" >&2
    ok=1
  fi
  grep -Fq "docker manifest inspect '$image' 2>&1 || docker pull '$image' 2>&1" "$image_dir/calls" || ok=1
done
check "$t" $ok

t="hosting.sh stage 4 halts when GHCR docker access check fails"
ok=0
test_ghcr_dir=$tmp/ghcr_test
mkdir -p "$test_ghcr_dir/bin" "$test_ghcr_dir/home"
for c in wslview explorer.exe xdg-open open; do printf '#!/bin/sh\nexit 0\n' > "$test_ghcr_dir/bin/$c"; done
cat > "$test_ghcr_dir/bin/ssh" <<'EOF'
#!/bin/sh
case "$*" in
  *docker\ manifest*|*docker\ pull*)
    echo 'Error response from daemon: unauthorized: authentication required' >&2
    exit 1
    ;;
  *)
    exit 0
    ;;
esac
EOF
chmod +x "$test_ghcr_dir/bin/"*
test_ghcr_state=$test_ghcr_dir/state
printf 'STAGE_1_CONFIRMED=true\nHETZNER_IPV4=192.0.2.1\nSTAGE_2_CONFIRMED=true\nSTAGE_3_CONFIRMED=true\n' > "$test_ghcr_state"
ghcr_out=$(printf '\ny\ny\ny\n\nn\n' | \
  PATH="$test_ghcr_dir/bin:$PATH" HOME="$test_ghcr_dir/home" WIZARD_STATE_FILE="$test_ghcr_state" bash "$wizard" 2>&1 || true)
if grep -q '^STAGE_4_CONFIRMED=true' "$test_ghcr_state"; then
  ok=1
fi
if ! printf '%s' "$ghcr_out" | grep -q 'GHCR access verification failed'; then
  ok=1
fi
check "$t" $ok

t="hosting.sh stage 5 halts on Scaleway HTTP 403 Forbidden"
ok=0
test_s3_dir=$tmp/s3_test
mkdir -p "$test_s3_dir/bin" "$test_s3_dir/home"
for c in wslview explorer.exe xdg-open open; do printf '#!/bin/sh\nexit 0\n' > "$test_s3_dir/bin/$c"; done
cat > "$test_s3_dir/bin/curl" <<'EOF'
#!/bin/sh
case "$*" in
  *s3.fr-par.scw.cloud*) printf 403;;
  *) printf 200;;
esac
EOF
chmod +x "$test_s3_dir/bin/"*
test_s3_state=$test_s3_dir/state
printf 'STAGE_1_CONFIRMED=true\nHETZNER_IPV4=192.0.2.1\nSTAGE_2_CONFIRMED=true\nSTAGE_3_CONFIRMED=true\nSTAGE_4_CONFIRMED=true\n' > "$test_s3_state"
printf '\ny\ny\ny\ny\nfr-par\nbkt\nscw_key\nscw_secret\nn\n' | \
  PATH="$test_s3_dir/bin:$PATH" HOME="$test_s3_dir/home" WIZARD_STATE_FILE="$test_s3_state" bash "$wizard" > "$test_s3_dir/out" 2>&1 || true
if grep -q '^STAGE_5_CONFIRMED=true' "$test_s3_state"; then
  ok=1
fi
grep -q 'Verifying Scaleway Object Storage bucket' "$test_s3_dir/out" || ok=1
grep -q 'HTTP 403 Forbidden' "$test_s3_dir/out" || ok=1
if grep -q 'Stage 6/9' "$test_s3_dir/out"; then ok=1; fi
check "$t" $ok

t="hosting.sh stage 7 rejects paused and unknown monitor statuses"
ok=0
status_dir=$tmp/ur_status_test
mkdir -p "$status_dir/bin" "$status_dir/home"
for x in wslview explorer.exe xdg-open open; do printf '#!/bin/sh\nexit 0\n' > "$status_dir/bin/$x"; done
cat > "$status_dir/bin/curl" <<'STUB'
#!/bin/sh
cat >/dev/null
printf '{"stat":"ok","monitors":[{"url":"https://example.test/health","interval":300,"status":%s,"alert_contacts":[{"value":"alerts@outside.test"}]}]}' "$MONITOR_STATUS"
STUB
chmod +x "$status_dir/bin/"*
for status in 0 1 2 8 9 99; do
  printf "HETZNER_IPV4='192.0.2.10'\nSCW_BUCKET='bkt'\nDOMAIN_NAME='example.test'\nPRODUCTION_HOST='example.test'\nSTAGING_HOST='staging.example.test'\n" > "$status_dir/state"
  for i in 1 2 3 4 5 6 8; do echo "STAGE_${i}_CONFIRMED=true" >> "$status_dir/state"; done
  printf '\ny\ny\ny\ny\ny\ny\nalerts@outside.test\ntoken\n\ny\n' | PATH="$status_dir/bin:$PATH" HOME="$status_dir/home" WIZARD_STATE_FILE="$status_dir/state" MONITOR_STATUS="$status" bash "$wizard" > "$status_dir/out" 2>&1 || true
  grep -q 'Verifying UptimeRobot monitor for' "$status_dir/out" || ok=1
  case "$status" in
    0|99) if grep -q '^STAGE_7_CONFIRMED=true' "$status_dir/state" || grep -q 'Stage 8/9' "$status_dir/out"; then ok=1; fi
          grep -q 'UptimeRobot monitor verification failed' "$status_dir/out" || ok=1 ;;
    *) grep -q '^STAGE_7_CONFIRMED=true' "$status_dir/state" || ok=1 ;;
  esac
done
check "$t" $ok

t="hosting.sh stage 8 halts when dedicated deploy key is rejected by server"
ok=0
test_st8_dir=$tmp/st8_test
mkdir -p "$test_st8_dir/bin" "$test_st8_dir/home" "$test_st8_dir/tmp"
cat > "$test_st8_dir/bin/gh" <<'EOF'
#!/bin/sh
case "$1 $2" in
  'auth status') exit 0;;
  'secret set') exit 0;;
  'secret list') printf '%s\n' DEPLOY_HOST DEPLOY_USER DEPLOY_SSH_KEY DEPLOY_KNOWN_HOSTS PRODUCTION_HOST STAGING_HOST SCW_ACCESS_KEY SCW_SECRET_KEY SCW_BUCKET; exit 0;;
esac
EOF
cat > "$test_st8_dir/bin/ssh" <<'EOF'
#!/bin/sh
echo 'Permission denied (publickey).' >&2
exit 255
EOF
cat > "$test_st8_dir/bin/ssh-keyscan" <<'EOF'
#!/bin/sh
echo '192.0.2.1 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDUMMY'
EOF
for c in wslview explorer.exe xdg-open open; do printf '#!/bin/sh\nexit 0\n' > "$test_st8_dir/bin/$c"; done
chmod +x "$test_st8_dir/bin/"*
test_st8_state=$test_st8_dir/state
printf "HETZNER_IPV4='192.0.2.1'\nSCW_BUCKET='bucket'\nDOMAIN_NAME='example.test'\nPRODUCTION_HOST='example.test'\nSTAGING_HOST='staging.example.test'\n" > "$test_st8_state"
for i in 1 2 3 4 5 6 7; do echo "STAGE_${i}_CONFIRMED=true" >> "$test_st8_state"; done
st8_out=$(printf '\ny\ny\ny\ny\ny\ny\ny\nsynthetic_access\nsynthetic_secret\n\nn\n' | \
  PATH="$test_st8_dir/bin:$PATH" HOME="$test_st8_dir/home" TMPDIR="$test_st8_dir/tmp" WIZARD_STATE_FILE="$test_st8_state" bash "$wizard" 2>&1 || true)
if grep -q '^STAGE_8_CONFIRMED=true' "$test_st8_state"; then
  ok=1
fi
if ! printf '%s' "$st8_out" | grep -q 'Server rejected authentication with the new dedicated deploy SSH key'; then
  ok=1
fi
check "$t" $ok

[ $failures -eq 0 ] || { echo "$failures test(s) failed" >&2; exit 1; }
