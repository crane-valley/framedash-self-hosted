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
`NEXT_PUBLIC_APP_URL` values; the installer examples use the tested loopback route. HTTPS on a
custom domain through the ALB with an ACM certificate passed on real AWS (see
[HTTPS through an Application Load Balancer](DEPLOY-AWS.md#https-through-an-application-load-balancer)).
Caddy's own public-HTTPS mode remains a reference only. Use Node 22, Docker Engine and Docker
Compose 2.39.4 or newer. This release requires a Linux data filesystem and a single host with enough
memory for ClickHouse, databases and the dashboard; the AWS test used 16 GiB. No supported ARM or
multi-host deployment is provided.

## Choose a route

- Loopback through SSM for a trial: uses `http://localhost:8088` directly on the host or through
  an SSM port-forwarding session.
- HTTPS through an Application Load Balancer for devices on a network: uses an ACM certificate,
  an internet-facing or internal ALB, and real SMTP (see
  [HTTPS through an Application Load Balancer](DEPLOY-AWS.md#https-through-an-application-load-balancer)).

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
workstation and proceed only if they pass. GitHub CLI 2.81 or newer is required, signed in with
`gh auth login` or a token in `GH_TOKEN`, even though this repository is public. FILE stands for
each downloaded file; run `verify-asset` for each one. Checksums alone prove integrity only, and
releases are immutable with GitHub-signed attestations:

```sh
gh release verify v1.0.0 --repo crane-valley/framedash-self-hosted
gh release verify-asset v1.0.0 FILE --repo crane-valley/framedash-self-hosted
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

- [DEPLOY-AWS.md](DEPLOY-AWS.md) - CloudFormation deployment, data volume preparation, runtime
  configuration, and ALB setup.
- [OPERATIONS.md](OPERATIONS.md) - Checks, updates, backups, AWS host replacement and disposal,
  and volume resizing.
- [PARITY.md](PARITY.md) - Feature parity comparison with hosted Framedash, plan entitlements,
  and known limits.

## Validation and limits

The loopback and ALB routes were tested; the included Caddy public-HTTPS configuration is a
reference only. Local restoration was tested for PostgreSQL, ClickHouse, and Redis only.

Enterprise SSO, sustained load and long-duration operation, AWS disaster recovery, queue replay,
durable erasure replay, the internal ALB scheme on AWS, and in-place upgrades remain unverified.
See [OPERATIONS.md](OPERATIONS.md) for the validation details and limitations.

## Security reports

Report suspected vulnerabilities privately to `security@framedash.dev`. Avoid posting configuration,
credentials, customer/player data or exploit details in public issues. This release is not
a production support or uptime commitment.
