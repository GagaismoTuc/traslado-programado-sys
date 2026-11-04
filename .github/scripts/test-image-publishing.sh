#!/bin/sh
# shellcheck disable=SC2016 # workflow expressions are matched literally
set -eu
root=$(CDPATH="" cd -- "$(dirname "$0")/../.." && pwd)
workflow=$root/.github/workflows/ci.yml
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
mkdir "$tmp/bin"
cat > "$tmp/bin/docker" <<'MOCK'
#!/bin/sh
printf '%s\n' "$*" >> "$CALLS"
case "$1" in
  load) test -f "$3" ;;
  push) if [ "$2" = "$LOCAL_IMAGE" ]; then printf 'digest: %s size: 123\n' "$LOCAL_DIGEST"; fi ;;
esac
MOCK
chmod +x "$tmp/bin/docker"
export PATH="$tmp/bin:$PATH" CALLS="$tmp/calls" LOCAL_IMAGE=localhost:5000/test LOCAL_DIGEST=sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
script=$root/.github/scripts/publish-image.sh
export GH_TOKEN=test GITHUB_ACTOR=test
: > "$tmp/image.tar"
job() {
  awk -v start="  $1:" '$0 == start { found = 1; next } /^  [a-z-]+:$/ { found = 0 } found' "$workflow"
}
check_gate() {
  job publish | grep -qF 'needs: [image, ci-ok]' &&
  job publish | grep -qF "if: github.event_name == 'push' && github.ref == 'refs/heads/main'" &&
  ! job publish | grep -q 'always()' &&
  job ci-ok | grep -qF 'needs: [verify, e2e, deploy-tests, commitlint, gitleaks]' &&
  job ci-ok | grep -qF 'if: always()' &&
  job ci-ok | grep -qF "RESULTS: \${{ join(needs.*.result, ' ') }}"
}
check_gate || { echo 'not ok - publish gate'; exit 1; }
# Model the workflow's success-only needs gate using the actual ci-ok script.
attempt_publish() {
  if sh "$root/.github/scripts/ci-ok.sh" "$@" >/dev/null 2>&1; then
    sh "$script" ghcr.io/example/app:sha "$tmp/image.tar" "$LOCAL_DIGEST" "$LOCAL_IMAGE" >/dev/null
  fi
}
for results in 'failure success success success success' 'success success failure success success'; do
  : > "$CALLS"
  # One argument per job, just as in the workflow.
  # shellcheck disable=SC2086
  attempt_publish $results
  ! grep -q 'push ghcr.io' "$CALLS" || exit 1
done
echo 'ok - failing CI cannot publish'
for status in cancelled skipped; do
  : > "$CALLS"
  attempt_publish success success "$status" success success
  ! grep -q 'push ghcr.io' "$CALLS" || exit 1
done
echo 'ok - cancelled or skipped CI cannot publish'
: > "$CALLS"
if sh "$script" ghcr.io/example/app:sha "$tmp/missing.tar" sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa "$LOCAL_IMAGE" >/dev/null 2>&1; then exit 1; fi
! grep -q 'push ghcr.io' "$CALLS" || exit 1
: > "$CALLS"
if sh "$script" ghcr.io/example/app:sha "$tmp/image.tar" sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb "$LOCAL_IMAGE" >/dev/null 2>&1; then exit 1; fi
! grep -q 'push ghcr.io' "$CALLS" || exit 1
: > "$CALLS"
sh "$script" ghcr.io/example/app:sha "$tmp/image.tar" sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa "$LOCAL_IMAGE" >/dev/null
grep -q 'push ghcr.io/example/app:sha' "$CALLS" || exit 1
echo 'ok - missing or mismatched artifact never reaches GHCR'
: > "$CALLS"
sh "$script" ghcr.io/example/app:sha1 "$tmp/image.tar" sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa "$LOCAL_IMAGE" >/dev/null
sh "$script" ghcr.io/example/app:sha2 "$tmp/image.tar" sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa "$LOCAL_IMAGE" >/dev/null
grep -q 'push ghcr.io/example/app:sha1' "$CALLS" && grep -q 'push ghcr.io/example/app:sha2' "$CALLS" || exit 1
job image | grep -qF 'SHA: ${{ github.sha }}' || exit 1
job image | grep -qF 'image="ghcr.io/gagaismotuc/traslado-$target:$SHA"' || exit 1
job publish | grep -qF 'IMAGE: ghcr.io/gagaismotuc/traslado-${{ matrix.target }}:${{ github.sha }}' || exit 1
job image | grep -qF 'name: built-images' || exit 1
job publish | grep -qF 'name: built-images' || exit 1
echo 'ok - consecutive pushes retain their own SHA tags'
