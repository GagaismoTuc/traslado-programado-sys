# GlitchTip & Error Tracking Infrastructure

Self-hosted error tracking stack with PII sanitization and container log rotation.

## Architecture

- **PostgreSQL**: Internal database for GlitchTip (`postgres:16.15-alpine`), not exposed to host ports.
- **GlitchTip**: Error tracking application (`glitchtip/glitchtip:6.2.6`), not exposed directly to host ports.
- **Caddy**: Reverse proxy on `127.0.0.1:8080`:
  - **Envelope Ingest** (`/api/<project_id>/envelope/`): Publicly ingest scrubbed error events from browser and API SDKs using DSN public key. Upstream client IP headers (`X-Forwarded-For`, `X-Real-IP`, `Forwarded`) are stripped.
  - **API Token Endpoints** (`/api/0/*`): Forwarded with `Authorization: Bearer <token>` to GlitchTip for native token verification (used for automated project/event checks).
  - **Admin UI & Other Routes**: Protected at the proxy edge by HTTP Basic Auth (`GLITCHTIP_ADMIN_USER` and `GLITCHTIP_ADMIN_PASSWORD_HASH`).

## Environment Variables

### Compose Stack (`infra/glitchtip/compose.yaml`)

| Variable | Description | Default |
|---|---|---|
| `GLITCHTIP_POSTGRES_DB` | Database name | `glitchtip` |
| `GLITCHTIP_POSTGRES_USER` | Database user | `glitchtip` |
| `GLITCHTIP_POSTGRES_PASSWORD` | Database password | **Required** |
| `GLITCHTIP_SECRET_KEY` | Django secret key | **Required** |
| `GLITCHTIP_DOMAIN` | Public base URL | `http://127.0.0.1:8080` |
| `GLITCHTIP_ALLOWED_HOSTS` | Allowed host headers | `127.0.0.1,localhost,glitchtip` |
| `GLITCHTIP_ADMIN_PATH` | Prefix for GlitchTip UI & API | `/_glitchtip` |
| `GLITCHTIP_ADMIN_USER` | Basic auth username for Caddy | **Required** |
| `GLITCHTIP_ADMIN_PASSWORD_HASH` | Bcrypt hash for Caddy basic auth | **Required** (generate via `caddy hash-password`) |
| `GLITCHTIP_PORT` | Host port bound to `127.0.0.1` | `8080` |
| `GLITCHTIP_RETENTION_DAYS` | Event retention window | `30` |
| `GLITCHTIP_EMAIL_URL` | Email backend URL | `consolemail://` |

### Application SDK Clients

| Variable | Target | Description |
|---|---|---|
| `GLITCHTIP_DSN` | `packages/api`, `infra/monitoring` | DSN for server-side error reporter and disk check alert |
| `VITE_GLITCHTIP_DSN` | `apps/office`, `apps/driver` | Public DSN for browser error reporting |

## Systemd Monitoring Installation

To install the disk check alert service and timer on a VPS:

```bash
sudo cp infra/monitoring/traslado-disk-alert.service /etc/systemd/system/
sudo cp infra/monitoring/traslado-disk-alert.timer /etc/systemd/system/
sudo mkdir -p /etc/traslado
sudo chmod 700 /etc/traslado

# Configure /etc/traslado/monitoring.env:
# DISK_MOUNT=/
# DISK_ALERT_THRESHOLD_PERCENT=80
# DISK_ALERT_WEBHOOK_URL=https://hooks.slack.com/services/... (or local mock)
# GLITCHTIP_DSN=http://<key>@127.0.0.1:8080/_glitchtip/<project_id>

sudo systemctl daemon-reload
sudo systemctl enable --now traslado-disk-alert.timer
```

