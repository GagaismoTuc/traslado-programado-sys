#!/bin/sh
# Checks filesystem usage and sends a PII-free alert when usage reaches DISK_ALERT_THRESHOLD_PERCENT.
set -eu

DISK_MOUNT=${DISK_MOUNT:-/}
DISK_ALERT_THRESHOLD_PERCENT=${DISK_ALERT_THRESHOLD_PERCENT:-80}
DISK_ALERT_WEBHOOK_URL=${DISK_ALERT_WEBHOOK_URL:-}
GLITCHTIP_DSN=${GLITCHTIP_DSN:-}

case "$DISK_ALERT_THRESHOLD_PERCENT" in
  ''|*[!0-9]*)
    echo "check-disk: DISK_ALERT_THRESHOLD_PERCENT must be an integer between 1 and 100" >&2
    exit 2
    ;;
esac

if [ "$DISK_ALERT_THRESHOLD_PERCENT" -lt 1 ] || [ "$DISK_ALERT_THRESHOLD_PERCENT" -gt 100 ]; then
  echo "check-disk: DISK_ALERT_THRESHOLD_PERCENT must be between 1 and 100" >&2
  exit 2
fi

if [ -z "$DISK_ALERT_WEBHOOK_URL" ]; then
  echo "check-disk: DISK_ALERT_WEBHOOK_URL is required for off-host alerting" >&2
  exit 2
fi

used_percent=$(df -Pk "$DISK_MOUNT" | awk 'END { for (i = 1; i <= NF; i++) if ($i ~ /^[0-9]+%$/) { sub(/%/, "", $i); print $i; exit } }')
case "$used_percent" in
  ''|*[!0-9]*)
    echo "check-disk: failed to read numeric capacity from df for $DISK_MOUNT" >&2
    exit 1
    ;;
esac

if [ "$used_percent" -lt "$DISK_ALERT_THRESHOLD_PERCENT" ]; then
  exit 0
fi

escaped_mount=$(printf '%s' "$DISK_MOUNT" | sed 's/\\/\\\\/g; s/"/\\"/g')

webhook_payload=$(printf '{"alert":"disk_usage_high","mount":"%s","usedPercent":%s,"thresholdPercent":%s}' \
  "$escaped_mount" "$used_percent" "$DISK_ALERT_THRESHOLD_PERCENT")
curl -fsS -m 10 -X POST \
  -H "Content-Type: application/json" \
  --data "$webhook_payload" \
  "$DISK_ALERT_WEBHOOK_URL" >/dev/null

if [ -n "$GLITCHTIP_DSN" ]; then
  scheme=${GLITCHTIP_DSN%%://*}
  rest=${GLITCHTIP_DSN#*://}
  sentry_key=${rest%%@*}
  host_and_path=${rest#*@}
  host_and_path=${host_and_path%/}
  project_id=${host_and_path##*/}
  base_url="${scheme}://${host_and_path%/*}"
  envelope_url="${base_url}/api/${project_id}/envelope/"

  event_id=$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')
  sent_at=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  header_line=$(printf '{"event_id":"%s","sent_at":"%s"}' "$event_id" "$sent_at")
  item_line='{"type":"event"}'
  event_line=$(printf '{"event_id":"%s","timestamp":"%s","level":"warning","platform":"other","message":"Disk usage high: %s%% on %s (threshold %s%%)","tags":{"alert":"disk_usage"}}' \
    "$event_id" "$sent_at" "$used_percent" "$escaped_mount" "$DISK_ALERT_THRESHOLD_PERCENT")

  printf '%s\n%s\n%s\n' "$header_line" "$item_line" "$event_line" | curl -fsS -m 10 -X POST \
    -H "Content-Type: application/x-sentry-envelope" \
    -H "X-Sentry-Auth: Sentry sentry_version=7, sentry_key=${sentry_key}, sentry_client=traslado-disk-alert/1.0" \
    --data-binary @- \
    "$envelope_url" >/dev/null || echo "check-disk: warning: secondary GlitchTip delivery failed" >&2
fi
