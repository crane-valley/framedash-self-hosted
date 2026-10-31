# Hosted and self-hosted parity

This document compares hosted Framedash with self-hosted v1.1.0. Rows reflect code review plus
the checks in the release notes, not exhaustive testing.

## Ingestion

| Feature | Hosted | Self-hosted | Notes |
| --- | --- | --- | --- |
| Event ingestion and SDK endpoint (UE5/Unity/Godot) with retry deduplication | Available | Same | `/v1/events` |
| Dead-letter handling | Automatic | Replaced | Manual operator discard (`--discard-dlq`, see DEPLOY-AWS.md) |

## Analytics and maps

| Feature | Hosted | Self-hosted | Notes |
| --- | --- | --- | --- |
| Dashboards, heatmaps, map upload | Available | Same | |
| Usage-funnel reports | Available | Not available | Vendor business metrics for the hosted service. The project Funnels analytics page is a separate feature and is not affected. |

## API and tooling

| Feature | Hosted | Self-hosted | Notes |
| --- | --- | --- | --- |
| Comparison API, CLI and perf-diff CI gate | Available | Same | |
| REST API and scoped API keys | Available | Same | |
| Hosted MCP endpoint and OAuth authorization server | Available | Same | |

## Accounts and access

| Feature | Hosted | Self-hosted | Notes |
| --- | --- | --- | --- |
| Project, member and invitation management | Available | Same | |
| Platform admin pages | Available | Same | |
| Sign-up | Open | Replaced | Invite-only |
| Workspace creation | Self-service | Replaced | One bootstrap workspace |
| Bot protection on sign-up (Turnstile) | Available | Not available | Unnecessary because sign-up is invite-only. |
| Sign-in with Google/GitHub/Microsoft | Available | Not available | By default; Compose passes no provider credentials, and invite-only blocks new OAuth identities. Password sign-in works. |

## Billing and plans

| Feature | Hosted | Self-hosted | Notes |
| --- | --- | --- | --- |
| Billing and plans | Stripe | Replaced | Administrator-managed; see Entitlements. |
| Stripe checkout, credit packs, trials and currency switching | Available | Not available | |

## Infrastructure

| Feature | Hosted | Self-hosted | Notes |
| --- | --- | --- | --- |
| Storage | R2 | Replaced | Your S3 |
| Queues | Cloudflare Queues | Replaced | Your SQS |
| Email | Resend | Replaced | Your SMTP |
| Database and cache | Managed | Replaced | PostgreSQL, ClickHouse and Redis on the host |

## Telemetry and monitoring

| Feature | Hosted | Self-hosted | Notes |
| --- | --- | --- | --- |
| Alerts (email, Slack, webhook) | Available | Same | See Known limits. |
| GA4 and the cookie banner | Available | Not available | |
| Vendor monitoring (Sentry, Checkly, ops alerts) | Available | Not available | |

## Legal

| Feature | Hosted | Self-hosted | Notes |
| --- | --- | --- | --- |
| Player data export and erasure APIs | Available | Same | |
| Terms and legal pages | Hosted | Replaced | ELv2 self-hosted terms |

## Entitlements

- A new installation bootstraps on the Enterprise plan: 365-day raw retention, no event, member,
  alert-rule or API-call caps. Enterprise ingest rate limits still apply.
- `configure.mjs --raw-retention-days N` (1-3650) sets `SELF_HOSTED_RAW_RETENTION_DAYS`. It is read
  at runtime. To change it later, edit the configuration file and recreate the web service; a plain
  restart does not re-read the file:

  ```sh
  node compose.mjs --configfile .env -- -f compose.yml -f compose.preview.yml up -d --no-build web
  ```

  ALB installations use `compose.alb.yml` in place of `compose.preview.yml`.
- `configure.mjs --monthly-event-limit N` (1-2147483647) sets `SELF_HOSTED_MONTHLY_EVENT_LIMIT`,
  applied once at bootstrap to `tenants.monthly_event_limit`. To change it later run this in
  PostgreSQL:

  ```sql
  UPDATE tenants SET monthly_event_limit = N;
  ```

  Use NULL for no cap. Wait for the ingest API-key cache to expire (30 seconds).
- Installations bootstrapped from a preview stay on Team until `plan_id` is changed.

## Known limits

- Alert webhook and Slack targets must be public https URLs: `validate-url.ts` rejects http and
  private addresses.
- Dead-lettered messages keep their budget claims until the month rolls over, unless `--discard-dlq`
  rolls them back (it attempts a rollback for decodable messages). This matters only with a monthly cap.
- No built-in external monitoring. Monitor `/api/health` and the authenticated `/api/health/cron`
  (reports only scheduled crons) yourself.
- S3 object versions are not erased by the application.
