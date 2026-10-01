# Framedash self-hosted preview

This installer runs the Framedash web dashboard, ingest gateway and consumer with PostgreSQL,
ClickHouse and Redis on one Linux host, using your AWS SQS queues and private S3 bucket.
It is an experimental preview. Read `APP-LICENSE.txt` before using the application images and
`THIRD-PARTY-NOTICES.md` for separately licensed components. This package contains deployment
files and application images, including executable JavaScript. The private original development
repository is not distributed.

## Release and requirements

`release.json` records the exact version, `linux/amd64` application image names, source image IDs
and archived image config IDs,
the image-archive SHA-256 and the tested origin `http://localhost:8088`. The app origin is configured
at runtime through matching `APP_URL`, `AUTH_URL` and `NEXT_PUBLIC_APP_URL` values; the installer
examples use the tested loopback route. Custom-domain public DNS/TLS remains unverified. Use Node 22,
Docker Engine and Docker Compose 2.39.4 or newer. The initial preview requires a Linux data
filesystem and a single host with enough memory for ClickHouse, databases and the dashboard;
the AWS test used 16 GiB. No supported ARM or multi-host deployment is provided.

Download the installer, image archive, corresponding-source archive and `ASSET_SHA256SUMS.txt`
from the same reviewed release. Verify the downloaded archives with
`sha256sum --check ASSET_SHA256SUMS.txt`, then extract the installer.
`release.json` identifies the source archive under `baseSources`; it provides the exact
Debian source packages used by the application base images and the bundled native-library
sources and build recipes. Place both archives
next to `SHA256SUMS.txt`, then verify all files before loading images:

```sh
sha256sum --check SHA256SUMS.txt
docker image load --input IMAGE_ARCHIVE_FILENAME_FROM_RELEASE_JSON
docker image inspect --format '{{.Id}}' RUNTIME_IMAGE_TAG_FROM_RELEASE_JSON
docker image inspect --format '{{.Id}}' WEB_IMAGE_TAG_FROM_RELEASE_JSON
```

For each image, the inspected ID must match either its `id` or `configId` in `release.json`.
Docker stores can report a source manifest identity or the archived config identity after loading;
the image archive's SHA-256 is the authoritative check of the distributed bytes.
The Compose file uses those versioned local tags and contains
no source build instructions. Third-party service images are fetched from their upstream registries;
the application-image archive is not a complete air-gapped distribution.

## AWS and configuration

`aws/cloudformation.json` is optional infrastructure-as-code for one EC2 host, encrypted storage,
private S3 and encrypted SQS/DLQ. Supply your own account ID, VPC, public subnet and matching
availability zone. Before creating a stack, verify your authenticated account against
`ExpectedAccountId`; that parameter alone does not authenticate the caller. The default opens no
inbound ports and uses SSM administration. IMDSv2 with hop limit two lets container SDKs use the
instance role. Leave `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` and `AWS_SESSION_TOKEN` unset
when using the instance role. Off AWS, supply your reviewed credentials privately through those
configuration fields; Compose forwards them to the SDK containers. `configure.mjs --local`
generates credentials for LocalStack only, and requires a separately configured local emulator.

The default Amazon Linux 2023 bootstrap installs Node 22 and Docker. Stack creation waits up to
30 minutes for the host's completion signal. Docker requires the data filesystem mounted at
`/srv/framedash` with its recorded UUID, including after a reboot. The retained S3 bucket keeps
its policy denying insecure transport. These revised boot guards passed static and shell tests;
a new AWS host creation or reboot was not performed after the test infrastructure was deleted.

The host auto-stops eight hours after each boot by default. This is a runtime bound rather than
a spending limit. EBS, retained buckets/queues and snapshots can still incur charges after a stop
or stack deletion. The template deliberately retains data resources; inspect its retention policies
and separately remove exact resources when ending a disposable trial.

Generate a private configuration in the installer directory. These are public resource coordinates;
use your approved administrator email. The generator creates passwords and privacy keys privately,
refuses to overwrite an existing file and prints only the destination path.
The supplied `.gitignore` excludes the default private configuration and local data paths.
Exclude any custom configuration or backup paths from source control as well.

The generated ClickHouse read-only password and its matching SHA-256 hash belong in the same
private configuration. Compose provisions `framedash_readonly` from the hash and passes its URL
to the web query API. This identity has SELECT access only to `framedash.events` and
`framedash.daily_sessions_project_mv`, with no write or access-management grants. The query client
applies `readonly=1` and resource limits per request; the separate SELECT grants also prevent
writes when that request setting is absent. Preserve both generated fields in encrypted backups.

```sh
node configure.mjs --aws-test --region YOUR_AWS_REGION \
  --queue-url YOUR_QUEUE_URL --dlq-url YOUR_DLQ_URL --bucket YOUR_PRIVATE_BUCKET \
  --admin-email YOUR_ADMIN_EMAIL --output .env
node compose.mjs --configfile .env -- -f compose.yml -f compose.preview.yml config --quiet
node compose.mjs --configfile .env -- -f compose.yml -f compose.preview.yml up -d --no-build
node compose.mjs --configfile .env -- -f compose.yml -f compose.preview.yml run --rm bootstrap
```

The preview override exposes HTTP only on host loopback `127.0.0.1:8088` and Mailpit on
`127.0.0.1:8025`. Access the dashboard at `http://localhost:8088` directly on the host or through
an authorized SSM port-forwarding session. Port forwarding requires the local Session Manager
plugin. The default security group exposes no public dashboard port. Database and Redis ports
remain private to Docker. The reserved proxy IP and Compose subnet must not overlap other networks.

Bootstrap creates one verified administrator, workspace and project only on an empty instance.
It refuses to modify an existing installation. Terms acceptance remains in the administrator's
sign-in flow. Sign in using `ADMIN_EMAIL` and `ADMIN_PASSWORD` from your private configuration;
the generator does not print the password. Bootstrap prints the new project ID. The generated
`SDK_API_KEY` is restricted to event ingestion. Point the SDK at your instance's `/v1/events`
endpoint and use that project ID and key through your approved secret mechanism.

For the separately published Framedash CLI, select this instance explicitly with
`--base-url http://localhost:8088` or `FRAMEDASH_BASE_URL`. Interactive `framedash login`
uses the selected origin. For automation, create a key with the required read/analytics scopes
on this instance's project API Keys page and supply it using `--api-key-file`; the generated
SDK ingest key does not grant analytics access. Non-loopback CLI origins require HTTPS.

Optional labels `ADMIN_NAME`, `WORKSPACE_NAME`, `WORKSPACE_SLUG`, `PROJECT_NAME`
and `SDK_API_KEY_NAME` can be set in the private file before bootstrap. Store that file with mode
0600 and encrypted backups; restrict ACLs separately on Windows. Do not publish it, print container
environments or render `compose config` without `--quiet`. `compose.mjs` gives file settings priority
over shell settings and suppresses detailed Docker stderr; use status checks for recorded diagnostics.

For agent-operated configuration, follow the owner's secret-management policy. An optional
`FRAMEDASH_CONFIG_SEED` may be supplied only inside an `asm-exec` child using a Secrets Manager
dynamic reference, for example `{{resolve:secretsmanager:YOUR_SECRET:SecretString:configSeed}}`.
The seed must be 64 alphanumeric characters. Retain the original seed or generated privacy keys
for recovery; changing them can prevent decryption and break audit continuity. Never place the
resolved seed in command arguments, recorded logs or SSM parameters.

## Checks, updates and backups

Optionally set `SELF_HOSTED_PRIVACY_CONTACT` to the installation operator's privacy email in
your private configuration. Account-deletion notices use that address when supplied, or direct
the recipient to their installation operator when it is unset.

After startup, inspect service status and check the dashboard health endpoint:

```sh
node compose.mjs --configfile .env -- -f compose.yml -f compose.preview.yml ps
curl --fail http://localhost:8088/api/health
```

The image migrations are the canonical PostgreSQL and ClickHouse migrations and run before the
application starts. Never edit migration files or reset their journals to bypass a failed upgrade.
Runtime containers have a three-minute Compose stop grace. Ingest drains accepted requests and
background work; consumers drain the current SQS batch, then close native database connections.
The default SQS visibility lease is 120 seconds and renews during processing. This is bounded,
best-effort shutdown: work exceeding the stop grace or an interrupted host shutdown can be killed
and replayed after visibility expires. Retain queues and rely on the tested deduplication path.
Keep the original configuration and privacy keys when updating. The preview has no supported
upgrade or downgrade contract: test a new version against a restored copy before upgrading an
installation containing data, and do not assume replacing old images rolls back a migrated schema.
Check the new release's archive SHA-256 and image IDs, then use its Compose file and image version.

Before replacing a host or image version, stop writes and take a consistent backup of PostgreSQL,
ClickHouse, Redis and the private configuration to encrypted off-host storage. Record the image
version and migration state. Test restoration into a separate empty installation before depending
on the backup. The data directory alone does not back up S3 objects or queue messages. Account for
S3 versions, queued events and permanent player erasure when defining your recovery process.

Local restoration was tested for PostgreSQL, ClickHouse and Redis only. This release does not claim
AWS disaster recovery, S3-version erasure, queue replay or durable erasure replay coverage. Mailpit
was used for email tests; real SMTP delivery, enterprise SSO, public DNS/TLS, browser rendering,
long-duration operation and load limits remain unverified. The included HTTPS Caddy configuration
is a deployment reference; the loopback preview remains the tested route. In particular, the optional
AWS template's restricted inbound CIDR does not support public HTTP ACME validation without a
separately reviewed certificate setup.

## Security reports

Report suspected vulnerabilities privately to `security@framedash.dev`. Avoid posting configuration,
credentials, customer/player data or exploit details in public issues. Preview availability is not
a production support or uptime commitment.
