# Framedash self-hosted preview

This installer runs the Framedash web dashboard, ingest gateway and consumer with PostgreSQL,
ClickHouse and Redis on one Linux host, using your AWS SQS queues and private S3 bucket.
It is an experimental preview. Read `APP-LICENSE.txt` before using the application images and
`THIRD-PARTY-NOTICES.md` for separately licensed components. This package contains deployment
files and application images, including executable JavaScript. The private original development
repository is not distributed.

Installation overview:

1. Check the requirements below and, on AWS, optionally create the host with
   `aws/cloudformation.json` and prepare its data volume.
2. Download and verify the release archives, extract the installer and load the images.
3. Generate the private configuration with `configure.mjs`, start the services with
   `compose.mjs` and run the one-time bootstrap (see "Runtime configuration").
4. Sign in, rotate the generated administrator password and point the SDK at `/v1/events`.
5. Review the checks, update and backup guidance before storing data you need to keep.

## Release and requirements

`release.json` records the exact version, `linux/amd64` application image names, source image IDs
and archived image config IDs,
the image-archive SHA-256 and the tested origin `http://localhost:8088`. The app origin is configured
at runtime through matching `APP_URL`, `AUTH_URL` and `NEXT_PUBLIC_APP_URL` values; the installer
examples use the tested loopback route. Custom-domain public DNS/TLS remains unverified. Use Node 22,
Docker Engine and Docker Compose 2.39.4 or newer. The initial preview requires a Linux data
filesystem and a single host with enough memory for ClickHouse, databases and the dashboard;
the AWS test used 16 GiB. No supported ARM or multi-host deployment is provided.

The shipped installer disables external web telemetry. Browser Sentry is disabled at build time
and cannot be enabled through runtime configuration. The internal runtime
`SELF_HOSTED_TELEMETRY_ENABLED` flag controls server/edge Sentry and optional dashboard collectors;
changing it does not change the compiled browser Sentry or build-plugin settings. Custom telemetry
opt-in is not a supported path for this binary preview. Keep the shipped disabled settings.

On the default AWS host, Session Manager opens a shell as `ssm-user`, which is not in the
Docker group. Before any Docker, Compose or host-maintenance commands in this guide, enter
an authorized root shell and change to the extracted installer directory:

```sh
sudo -i
cd /srv/framedash/YOUR_EXTRACTED_INSTALLER_DIRECTORY
```

Repeat this after reconnecting; `sudo -i` changes the working directory. Adding `ssm-user`
to the Docker group is unnecessary. If your Session Manager policy removes sudo access,
use your installation administrator's approved privileged access. See
[AWS's ssm-user permissions guidance](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-getting-started-ssm-user-permissions.html).

Download the installer, image archive, corresponding-source archive and `ASSET_SHA256SUMS.txt`
from the same reviewed release. Verify the downloaded archives with
`sha256sum --check ASSET_SHA256SUMS.txt`, then extract the installer into its own directory
without applying archive ownership or permissions, and change into it:

```sh
tar --extract --gzip --no-same-owner --no-same-permissions \
  --file framedash-installer-VERSION.tar.gz
cd framedash-installer-VERSION
```

The installer archive contains a single `framedash-installer-VERSION/` directory whose
root-owned entries carry no group or other write permission.
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
The Compose file uses those versioned local tags with `pull_policy: never`: a missing application
image fails instead of pulling an unverified registry image. Recheck identities after loading or
retagging images. It contains no source build instructions. Third-party service images are fetched from their upstream registries;
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

The default Amazon Linux 2023 bootstrap installs Node 22 and Docker, verifying the Docker Compose
plugin against a SHA-256 pinned in the template. Stack creation waits up to 45 minutes for the
host's completion signal. Bootstrap never formats a disk: after finding the
exact data volume, it waits up to 20 minutes for an operator-created ext4 filesystem. An existing
ext4 volume proceeds without formatting. Complete the initial-volume procedure below while the
new stack is `CREATE_IN_PROGRESS`; do not wait for `CREATE_COMPLETE` before connecting.
Docker requires the data filesystem mounted at
`/srv/framedash` with its recorded UUID, including after a reboot. On hosts created from this
template, a missing data disk does not block boot (`nofail`), so Session Manager remains available
for recovery while Docker refuses to start. A stack update does not rerun user data: a host
created from an earlier template keeps its blocking entry until an operator adds `nofail` to the
options of its `/srv/framedash` line in `/etc/fstab` and confirms `findmnt --verify` succeeds.
The retained S3 bucket keeps its policy denying insecure transport. By default it keeps replaced
and deleted object versions indefinitely. Setting `NoncurrentVersionRetentionDays` above zero
expires them after that many days; on an existing bucket this immediately makes older versions
eligible for permanent deletion, so back up or inventory any versions you need first.
These revised boot guards passed static and shell tests; a new AWS host creation or reboot was
not performed after the test infrastructure was deleted.

### Initial data-volume preparation

On the account-verified operator workstation, identify the new stack and its exact physical
`DataVolume` and `Instance` before connecting through Session Manager:

```sh
set -eu
EXPECTED_ACCOUNT_ID=YOUR_12_DIGIT_ACCOUNT_ID
AWS_REGION=YOUR_AWS_REGION
STACK_ID=YOUR_NEW_STACK_ARN
test "$(aws sts get-caller-identity --query Account --output text)" = "$EXPECTED_ACCOUNT_ID"
aws cloudformation describe-stacks --region "$AWS_REGION" --stack-name "$STACK_ID" \
  --query 'Stacks[0].{Id:StackId,Status:StackStatus,Created:CreationTime}'
DATA_VOLUME_ID=$(aws cloudformation describe-stack-resource --region "$AWS_REGION" \
  --stack-name "$STACK_ID" --logical-resource-id DataVolume \
  --query StackResourceDetail.PhysicalResourceId --output text)
INSTANCE_ID=$(aws cloudformation describe-stack-resource --region "$AWS_REGION" \
  --stack-name "$STACK_ID" --logical-resource-id Instance \
  --query StackResourceDetail.PhysicalResourceId --output text)
aws ec2 describe-volumes --region "$AWS_REGION" --volume-ids "$DATA_VOLUME_ID" \
  --query 'Volumes[].{Id:VolumeId,Created:CreateTime,Snapshot:SnapshotId,Attachments:Attachments,Tags:Tags}'
aws ec2 describe-instances --region "$AWS_REGION" --instance-ids "$INSTANCE_ID" \
  --query 'Reservations[].Instances[].{Id:InstanceId,Tags:Tags,Disks:BlockDeviceMappings}'
```

Proceed only for this initial stack creation: match its ARN account/Region, both resource tags
and attachment to the recorded instance. Confirm the volume was newly created for this operation,
has no snapshot source, has never held an installation and contains no data to preserve. An empty
filesystem probe alone cannot prove that. Stop on an update/replacement, reused volume, unknown
history or mismatch; preserve and investigate that disk instead.

Connect to the recorded instance, run `sudo -i`, then use the recorded volume ID in this Bash
inspection. No installer directory exists yet:

```bash
set -eu
DATA_VOLUME_ID=YOUR_VERIFIED_NEW_DATA_VOLUME_ID
udevadm settle --timeout=10
DATA_DEVICE=$(readlink -f "/dev/disk/by-id/nvme-Amazon_Elastic_Block_Store_${DATA_VOLUME_ID//-/}")
test -b "$DATA_DEVICE"
test "$(lsblk -nr -o TYPE "$DATA_DEVICE")" = disk
test -z "$(lsblk -nr -o MOUNTPOINTS "$DATA_DEVICE")"
lsblk -b -o NAME,SERIAL,TYPE,SIZE,FSTYPE,MOUNTPOINTS "$DATA_DEVICE"
wipefs --no-act "$DATA_DEVICE"
file -s "$DATA_DEVICE"
```

Match the displayed serial to the recorded volume ID and size to the new stack's capacity.
Require no partitions, mounts or signatures, and a `file` result of plain `data`, in addition to
the verified fresh-volume history above. Only then explicitly run `mkfs.ext4 "$DATA_DEVICE"`
without a force option. This erases any contents on that device. Never format an existing or
uncertain volume. Bootstrap detects ext4, mounts it, starts Docker and signals completion;
verify `CREATE_COMPLETE` before extracting the installer under `/srv/framedash` and following
the configuration steps. If the window expires, inspect the failed stack and retained resources;
do not format a volume to repair an unknown installation. See
[AWS's volume preparation guidance](https://docs.aws.amazon.com/ebs/latest/userguide/ebs-using-volumes.html).

A failed creation signal makes CloudFormation roll back, and the instance's termination
protection stops that rollback from deleting it: the stack reaches `ROLLBACK_FAILED` and the
host keeps running. From the account-verified workstation, record the stack and instance as
above, disable protection only on that recorded instance with the `modify-instance-attribute`
command under "AWS replacement and disposal", then run `delete-stack` for the recorded stack.
The data volume is snapshotted and the bucket and queues are retained as described there.

### Runtime configuration

The host auto-stops eight hours after each boot by default. This is a runtime bound rather than
a spending limit. `AutoStopHours` configures the timer only during initial host bootstrap.
Changing it on an existing stack does not update the installed timer: EC2 user data is not
automatically rerun after an update or stop/start. Keep its original value during stack updates.
Changing an existing host's runtime limit requires separately reviewed privileged timer maintenance;
that workflow is not supported or tested by this preview. Inspect the installed unit with
`systemctl cat framedash-autostop.timer` and its next deadline with
`systemctl list-timers --all framedash-autostop.timer` before relying on a runtime limit. See
[EC2 user-data execution](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/user-data.html).
EBS, retained buckets/queues and snapshots can still incur charges after a stop
or stack deletion. The template deliberately retains data resources; inspect its retention policies
and separately remove exact resources when ending a disposable trial.

The default consumer polls only the main queue. Messages that exhaust its configured retries
remain in the DLQ for operator diagnosis, subject to the template's 14-day SQS retention expiry.
Monitor that queue and arrange any required preservation before expiry. Budget claims may remain
held for failed messages. This preview does not provide or validate an automatic replay workflow.

After diagnosing failures and reviewing the exact DLQ configured in `.env`, an authorized operator
can explicitly discard its visible messages from the privileged installer shell:

```sh
node compose.mjs --configfile .env -- -f compose.yml -f compose.preview.yml \
  run --rm --no-deps consumer node apps/self-hosted/dist/consumer.js --discard-dlq
```

This command polls only the configured DLQ. It invokes the shared terminal-failure handler,
which logs diagnostic metadata, attempts budget rollback for decodable messages and acknowledges
them even if rollback fails. Malformed envelopes are acknowledged without rollback. Acknowledged
messages are deleted irreversibly. The command exits after an empty long poll; invisible or
concurrently arriving messages can remain, so inspect the queue again and repeat only after review.
Stopping the command drains its current batch. Retaining queues after stack deletion cannot restore
expired or already acknowledged messages. Supported replay and longer retention require a separate
reviewed recovery design.

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
the generator does not print the password. After the first sign-in, set a new password through
the sign-in page's password-reset flow; the generated value stays in the configuration file,
which Compose still reads, and stops granting access. Bootstrap prints the new project ID.
The generated `SDK_API_KEY` is restricted to event ingestion. Point the SDK at your instance's `/v1/events`
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
over shell settings and shows Docker stderr with configured secret values, inherited secret
variables and URL credentials replaced by `[REDACTED]`. Its normal output is not redacted.

For automated configuration, follow the owner's secret-management policy. An optional
`FRAMEDASH_CONFIG_SEED` may be supplied only to the `configure.mjs` child process by a
secret-injection wrapper that resolves it from your secret store, for example a Secrets Manager
value such as `{{resolve:secretsmanager:YOUR_SECRET:SecretString:configSeed}}`.
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

### AWS replacement and disposal

The template enables EC2 termination protection (`DisableApiTermination=true`), which can
block CloudFormation deletion or replacement of the instance. Perform AWS lifecycle operations
from an operator workstation authenticated to the intended account with the required management
permissions; the host's application role does not provide those permissions. Stop writes and
complete the backup/restore checks above before an approved replacement or disposal.

First identify the exact account, Region, stack ARN and physical instance, and record the resource
inventory outside the installer directory before stack deletion removes its outputs:

```sh
set -eu
EXPECTED_ACCOUNT_ID=YOUR_12_DIGIT_ACCOUNT_ID
AWS_REGION=YOUR_AWS_REGION
STACK_ID=YOUR_REVIEWED_STACK_ARN
test "$(aws sts get-caller-identity --query Account --output text)" = "$EXPECTED_ACCOUNT_ID"
aws cloudformation describe-stacks --region "$AWS_REGION" --stack-name "$STACK_ID" \
  --query 'Stacks[0].{Id:StackId,Protection:EnableTerminationProtection,Outputs:Outputs}'
aws cloudformation list-stack-resources --region "$AWS_REGION" --stack-name "$STACK_ID"
INSTANCE_ID=$(aws cloudformation describe-stack-resource --region "$AWS_REGION" \
  --stack-name "$STACK_ID" --logical-resource-id Instance \
  --query StackResourceDetail.PhysicalResourceId --output text)
aws ec2 describe-instances --region "$AWS_REGION" --instance-ids "$INSTANCE_ID" \
  --query 'Reservations[].Instances[].{Id:InstanceId,State:State.Name,Tags:Tags,Disks:BlockDeviceMappings}'
```

Match the returned stack ARN's account/Region and the instance's CloudFormation stack tags to
the intended target before continuing. Disable protection only on that recorded instance:

```sh
aws ec2 modify-instance-attribute --region "$AWS_REGION" --instance-id "$INSTANCE_ID" \
  --attribute disableApiTermination --value false
```

For replacement, review the CloudFormation change set before executing it; the replacement
instance receives termination protection from the template. An existing attached data disk
needs an operator-managed detach/reattach and recovery plan, so host replacement is not an
automatic preview upgrade. If the operation is canceled and the original instance survives,
restore its protection with the same command using `--attribute disableApiTermination --value true`.

For disposal, separately disable CloudFormation stack termination protection if the earlier
inspection reports it enabled, then delete only the reviewed stack:

```sh
aws cloudformation update-termination-protection --region "$AWS_REGION" \
  --stack-name "$STACK_ID" --no-enable-termination-protection
aws cloudformation delete-stack --region "$AWS_REGION" --stack-name "$STACK_ID"
aws cloudformation wait stack-delete-complete --region "$AWS_REGION" --stack-name "$STACK_ID"
```

Stack deletion retains the S3 bucket and its transport policy, SQS queue and DLQ. The data EBS
volume has a `Snapshot` policy: CloudFormation snapshots it before deletion/replacement;
record the resulting snapshot ID after the operation, plus existing backup snapshots and any
volumes left by failed operations. Separately inventory any seed/KMS stack or resources you
created outside this template. Decide retention or disposal for each exact resource, including
all S3 object versions and delete markers, then verify the intended outcome. Stack deletion
alone does not end storage, snapshot, queue, public-address or separately created resource
charges. See [CloudFormation retention policies](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-attribute-deletionpolicy.html)
and [EC2 termination protection](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/Using_ChangingDisableAPITermination.html).

### Planned data-volume growth

Choose sufficient `DataVolumeSize` at creation. Increasing that parameter on an existing stack
changes the EBS block capacity; it does not rerun cloud-init or extend the ext4 filesystem.
Storage growth requires a separate maintenance plan and has not been exercised by this preview's
validation. It does not establish an application upgrade/downgrade contract, and shrinking an
existing EBS volume is not a rollback path.

1. Pause SDK writes and stop all Compose services cleanly from the privileged installer shell
   with `node compose.mjs --configfile .env -- -f compose.yml -f compose.preview.yml stop`.
   Stop the Docker daemon with `systemctl stop docker` to prevent container restarts during
   maintenance. Keep `/srv/framedash` mounted. Complete an encrypted off-host backup and an
   EBS snapshot, record its exact volume ID and filesystem UUID, and verify the snapshot is complete.
2. From the account-verified operator workstation, review a CloudFormation change set that only
   increases `DataVolumeSize` on the recorded `DataVolume`, with no volume or host replacement.
   After execution, use `aws ec2 describe-volumes-modifications --region "$AWS_REGION"
   --volume-ids YOUR_RECORDED_DATA_VOLUME_ID` and wait for `optimizing` or `completed`.
   Confirm the larger block capacity on the host before extending the filesystem.
3. In the privileged host shell, substitute the recorded volume ID and pre-maintenance UUID
   below. These guards require the template's whole-disk ext4 layout and exact mounted disk:

```bash
set -eu
DATA_VOLUME_ID=YOUR_RECORDED_DATA_VOLUME_ID
EXPECTED_UUID=YOUR_RECORDED_FILESYSTEM_UUID
DATA_DEVICE=$(readlink -f "/dev/disk/by-id/nvme-Amazon_Elastic_Block_Store_${DATA_VOLUME_ID//-/}")
test -b "$DATA_DEVICE"
test "$(lsblk -nr -o TYPE "$DATA_DEVICE")" = disk
test "$(blkid -s TYPE -o value "$DATA_DEVICE")" = ext4
test "$(blkid -s UUID -o value "$DATA_DEVICE")" = "$EXPECTED_UUID"
test "$(findmnt -rn -o UUID --mountpoint /srv/framedash)" = "$EXPECTED_UUID"
MOUNT_SOURCE=$(findmnt -rn -o SOURCE --mountpoint /srv/framedash)
test "$(readlink -f "$MOUNT_SOURCE")" = "$DATA_DEVICE"
lsblk -b -o NAME,TYPE,SIZE,FSTYPE,MOUNTPOINTS "$DATA_DEVICE"
df -hT /srv/framedash
```

After every identity check passes and the displayed disk capacity matches the approved increase,
extend only that filesystem with `resize2fs "$DATA_DEVICE"`. Never use `mkfs` on an existing
installation. A partitioned disk, another filesystem, a missing mount or a UUID mismatch requires
a different reviewed procedure. Verify the larger filesystem with `df -hT /srv/framedash`, then
run `systemctl start docker` and the installer `up -d --no-build` command. Check health and stored
data before resuming SDK writes. Larger EBS capacity is billed even if its filesystem was not
extended; the maintenance snapshot also incurs storage charges. See
[AWS filesystem extension](https://docs.aws.amazon.com/ebs/latest/userguide/recognize-expanded-volume-linux.html),
[modification states](https://docs.aws.amazon.com/ebs/latest/userguide/monitoring-volume-modifications.html)
and [EBS pricing](https://aws.amazon.com/ebs/pricing/).

Local restoration was tested for PostgreSQL, ClickHouse and Redis only. This release does not claim
AWS disaster recovery, queue replay or durable erasure replay coverage. The application does not
erase S3 versions; only the optional noncurrent-version expiry or an operator does. Mailpit
was used for email tests; real SMTP delivery, enterprise SSO, public DNS/TLS, browser rendering,
long-duration operation and load limits remain unverified. The included HTTPS Caddy configuration
is a deployment reference; the loopback preview remains the tested route. In particular, the optional
AWS template's restricted inbound CIDR does not support public HTTP ACME validation without a
separately reviewed certificate setup.

## Security reports

Report suspected vulnerabilities privately to `security@framedash.dev`. Avoid posting configuration,
credentials, customer/player data or exploit details in public issues. Preview availability is not
a production support or uptime commitment.
