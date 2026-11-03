# Framedash self-hosted

Framedash provides a dashboard for game performance data collected through its SDK. This installer
runs the web dashboard, ingest gateway, and consumer on one Linux host with PostgreSQL, ClickHouse,
and Redis, using your AWS SQS queues and private S3 bucket.

Read `APP-LICENSE.txt` before using the application images and `THIRD-PARTY-NOTICES.md` for
separately licensed components. This package contains deployment files and application images,
including executable JavaScript; the private original development repository is not distributed.
See [PARITY.md](PARITY.md) for differences from hosted Framedash.

## Release and requirements

The app origin is configured at runtime through matching `APP_URL`, `AUTH_URL` and
`NEXT_PUBLIC_APP_URL` values; the installer examples use the tested loopback route. Caddy's own
public-HTTPS mode remains a reference only. Use Node 22, Docker Engine and Docker Compose 2.39.4 or
newer. This release requires a Linux data filesystem and a single host; no supported ARM or
multi-host deployment is provided.

Release 1.2.1 is a patch release of 1.2.0 that adds the consumer pause on a full Redis (budget
store). It provides an always-on production deployment with alarms, nightly backup and upgrades
from 1.1.0 or 1.2.0, on one host with no high availability. Production uses m7i.xlarge with 16 GiB
memory.

The 1.2.0 production stack was rehearsed on AWS on an m7i.xlarge host with an internal ALB and
alarms: every accepted event was inserted at up to 3,000 events/s over 10 minutes. See
[Validation details](OPERATIONS.md#validation-details).

## Choose a route

- Loopback through SSM for a trial: uses `http://localhost:8088` directly on the host or through
  an SSM port-forwarding session.
- HTTPS through an Application Load Balancer for devices on a network: uses an ACM certificate,
  an internet-facing or internal ALB, and real SMTP (see
  [HTTPS through an Application Load Balancer](DEPLOY-AWS.md#https-through-an-application-load-balancer)).
- Production: the ALB route with the host in a private subnet, alarms and nightly backup (see
  [Production deployment](DEPLOY-AWS.md#production-deployment)).

On the default AWS host, Session Manager opens a shell as `ssm-user`, which is not in the Docker
group. Before Docker, Compose, or host-maintenance commands, enter an authorized root shell with
`sudo -i`. Once the installer has been extracted, change to its directory as well:

```sh
sudo -i
cd /srv/framedash/YOUR_EXTRACTED_INSTALLER_DIRECTORY
```

Repeat these steps after reconnecting; `sudo -i` changes the working directory. Adding `ssm-user`
to the Docker group is unnecessary. If your Session Manager policy removes sudo access,
use your installation administrator's approved privileged access. See
[AWS's ssm-user permissions guidance](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-getting-started-ssm-user-permissions.html).

## Download and verification

### On the workstation: download, verify, and extract

Download the installer, image archive, corresponding-source archive and `ASSET_SHA256SUMS.txt`
from the same reviewed release. After downloading all four files, run the following on a
workstation and proceed only if they pass. GitHub CLI 2.83.0 or newer is required, signed in with
`gh auth login` or a token in `GH_TOKEN`, even though this repository is public. FILE stands for
each downloaded file; run `verify-asset` for each one. Checksums alone prove integrity only, and
releases are immutable with GitHub-signed attestations:

```sh
gh release verify v1.2.1 --repo crane-valley/framedash-self-hosted
gh release verify-asset v1.2.1 FILE --repo crane-valley/framedash-self-hosted
sha256sum --check ASSET_SHA256SUMS.txt
```

Extract the installer into its own directory without applying archive ownership or permissions,
and change into it:

```sh
tar --extract --gzip --no-same-owner --no-same-permissions \
  --file framedash-installer-VERSION.tar.gz
cd framedash-installer-VERSION
```

### On the host: extract, verify, and load

Extract the installer on the host using the same extraction command. Place both archives next to
`SHA256SUMS.txt`, then verify all files before loading images:

```sh
sha256sum --check SHA256SUMS.txt
docker image load --input IMAGE_ARCHIVE_FILENAME_FROM_RELEASE_JSON
docker image inspect --format '{{.Id}}' RUNTIME_IMAGE_TAG_FROM_RELEASE_JSON
docker image inspect --format '{{.Id}}' WEB_IMAGE_TAG_FROM_RELEASE_JSON
```

For each image, the inspected ID must match either its `id` or `configId` in `release.json`.
Recheck identities after loading or retagging images.
See [Release contents and image identity](OPERATIONS.md#release-contents-and-image-identity) for image identities and upstream registry access.

## Install sequence

1. Check the requirements, then follow "Download and verification" on the workstation through
   extraction.
2. On AWS, optionally create the host with `aws/cloudformation.json` from that extracted installer
   and prepare its data volume (see
   [Initial data-volume preparation](DEPLOY-AWS.md#initial-data-volume-preparation)).
3. On the host, extract the installer and load the images as described in "Download and verification".
4. Choose the commands for your route:
   - **Loopback:** Generate the private configuration with `configure.mjs`, start the services
     with `compose.mjs`, and run the one-time bootstrap (see
     [Runtime configuration](DEPLOY-AWS.md#runtime-configuration)) using the commands below:
   - **ALB:** Use the commands in
     [HTTPS through an Application Load Balancer](DEPLOY-AWS.md#https-through-an-application-load-balancer)
     instead of the loopback commands below.

```sh
node configure.mjs --aws-test --region YOUR_AWS_REGION \
  --queue-url YOUR_QUEUE_URL --dlq-url YOUR_DLQ_URL --bucket YOUR_PRIVATE_BUCKET \
  --admin-email YOUR_ADMIN_EMAIL --output .env
node compose.mjs --configfile .env -- -f compose.yml -f compose.preview.yml config --quiet
node compose.mjs --configfile .env -- -f compose.yml -f compose.preview.yml up -d --no-build
node compose.mjs --configfile .env -- -f compose.yml -f compose.preview.yml run --rm bootstrap
```

5. Sign in, rotate the generated administrator password, and point the SDK at `/v1/events`.
6. Review [OPERATIONS.md](OPERATIONS.md) before storing data you need to keep.

## Where to go next

- [DEPLOY-AWS.md](DEPLOY-AWS.md) - CloudFormation deployment, production deployment, data volume
  preparation, runtime configuration, and ALB setup.
- [OPERATIONS.md](OPERATIONS.md) - Operating model, checks, backups, alarm response, upgrades, OS
  maintenance, disk growth, capacity, CLI and MCP use, and AWS host replacement and disposal.
- [PARITY.md](PARITY.md) - Feature parity comparison with hosted Framedash, plan entitlements,
  and known limits.

## Validation and limits

The included Caddy public-HTTPS configuration is a reference only.

The local backup drill passed on 1.2.0 final candidate images. An earlier candidate's restore drill
passed on a separate AWS stack (6m41s to full service, small data). On AWS, 1.2.0 final candidate
images verified private-subnet deployment, internal ALB routing, nightly backup, and up to 3,000
events/s for 10 minutes. Upgrading in place from 1.1.0 to 1.2.0 was tested locally with data
preserved, but has not been rehearsed on AWS. Enterprise SSO, browser visual checks, AWS upgrades,
DLQ redrive on AWS (verified locally only), and replay into a restored installation remain
unverified.

Release 1.2.1 was validated locally only (not rehearsed on AWS).

A fresh install from the 1.2.1 images passed ingest smoke, account smoke, MCP 401, deep and cron
health, retry smoke, and the backup and restore drill. An in-place upgrade from 1.2.0 to 1.2.1,
killed mid-stop and rerun, kept data. With Redis forced full, no batch reached the dead-letter
queue, the consumer stayed paused across a restart, and every accepted event was inserted after the
limit was restored.

An AWS soak ran 15h35m at 200 events/s with zero failures (zero failed batches after sender retries
and nothing lost; the nightly backup returned 502 for about 3m16s while the sender retried) and
exact counts, stopped early by cost decision instead of the planned 72 hours. A final restore drill
into a separate AWS stack succeeded
with full service 7m17s after the second stack completed (stack creation itself took 5m12s) and
exact count matching. A 72 hour soak and more than one nightly backup on AWS remain unverified.

See [Validation details](OPERATIONS.md#validation-details) for full results and operational limits.

## Security reports

Report suspected vulnerabilities privately to `security@framedash.dev`. Avoid posting configuration,
credentials, customer/player data or exploit details in public issues. This release is not
a production support or uptime commitment.
