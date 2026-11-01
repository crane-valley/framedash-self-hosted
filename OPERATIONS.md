# Operations

See [README.md](README.md) for release requirements, download verification, and the
[install sequence](README.md#install-sequence).

Every Compose example in this document uses the loopback form, and ALB installations replace
`-f compose.preview.yml` with `-f compose.alb.yml`.

## Checks, updates and backups

Optionally set `SELF_HOSTED_PRIVACY_CONTACT` to the installation operator's privacy email in
your private configuration. Account-deletion notices use that address when supplied, or direct
the recipient to their installation operator when it is unset.

After startup, inspect service status and check the dashboard health endpoint:

```sh
node compose.mjs --configfile .env -- -f compose.yml -f compose.preview.yml ps
curl --fail http://localhost:8088/api/health
```

GET `/api/health/cron` with `Authorization: Bearer $CRON_SECRET` returns 200 when every scheduled
cron is fresh and 503 otherwise. See [Backup and restore](#backup-and-restore) for backup and
restore procedures.

### Migrations

The image migrations are the canonical PostgreSQL and ClickHouse migrations and run before the
application starts. Never edit migration files or reset their journals to bypass a failed upgrade.

### Shutdown and replay

Runtime containers have a three-minute Compose stop grace. Ingest drains accepted requests and
background work; consumers drain the current SQS batch, then close native database connections.
The default SQS visibility lease is 120 seconds and renews during processing. This is bounded,
best-effort shutdown: work exceeding the stop grace or an interrupted host shutdown can be killed
and replayed after visibility expires. Retain queues and rely on the tested deduplication path.

### Updates and downgrades

Keep the original configuration and privacy keys when updating. There is no in-place upgrade from
a 0.1.0-preview release, so install a 1.x release fresh and move data only by your own reviewed
process. Each later release states in its notes which versions it was tested to upgrade from, and
any other path is unsupported. 1.1.0 was tested as a fresh install only, so no upgrade to it is
supported. A downgrade is never supported, because replacing images does not
roll back a migrated schema; back up first and test against a restored copy. Check the new
release's archive SHA-256 and image IDs, then use its Compose file and image version.

Before replacing a host or image version, run a backup, record the release and the backup's output
JSON, and test a restore; see [Backup and restore](#backup-and-restore).

## Backup and restore

### What it covers

`backup.mjs` is operator-run and not scheduled. It produces one directory named
`framedash-backup-<time>-<random>` containing encrypted files: `config.enc`, `postgres.enc`,
`clickhouse.enc`, `redis.enc`, and `manifest.enc`. Each component is encrypted with AES-256-GCM in
1 MiB authenticated chunks using a per-file key derived by HKDF-SHA256; truncation, reordering, and
swapping between backups are detected. No plaintext temporary file is written.

It takes the application offline: expect downtime; ingest and the dashboard are unavailable while
it runs, and SDKs should buffer and retry.

Check the auto-stop timer first so the host does not stop mid-backup:

```sh
systemctl list-timers --all framedash-autostop.timer
```

If the host stops mid-backup, services stay stopped, and the partial directory (`ID.partial`) and
the lock file must be removed by hand; then start the services.

Backup needs free space of 1.2 times the database directories on the output filesystem and refuses
otherwise. Write backups outside `DATA_DIR`; on the AWS host use `/srv/framedash/backups`
(`DATA_DIR` there is `/srv/framedash/data`). That is the same disk: a copy there is not off-host
until uploaded as described in [Off-host storage](#off-host-storage) and [Create](#create).

### One-time key setup

Generate a backup key:

```sh
node backup.mjs keygen --output PATH
```

It writes 64 hex characters with mode 0600 and refuses to overwrite. Commands refuse a key file
readable by group or others. Move the key into your secret store (for example AWS Secrets Manager in
the same Region, or the operator password manager) before relying on it, because a host-loss
recovery needs it from somewhere other than the host. Never store it under `DATA_DIR`, next to
backups, or in the backup bucket: `create` refuses a key inside `DATA_DIR` or the output directory.

`--key-file /dev/stdin` lets a secret-store command pipe the key in so it does not rest on the host:

```sh
AWS_REGION=YOUR_AWS_REGION
aws secretsmanager get-secret-value --region "$AWS_REGION" --secret-id YOUR_SECRET_ID \
  --query SecretString --output text | \
  node backup.mjs create --configfile .env --key-file /dev/stdin \
    --output-dir /srv/framedash/backups -- -f compose.yml -f compose.preview.yml
```

The instance role has no secret-read or backup bucket access and must not be given any, because
application containers share that role; the shell running this example uses short-lived operator
credentials, as described in [Off-host storage](#off-host-storage).

A lost key means every backup made with it is unrecoverable; there is no reset. Keep the key for as
long as any backup made with it is retained.

### Off-host storage

Store backups in a dedicated S3 bucket in the same Region as the installation (data residency) in
your own account, separate from the application bucket. Run the following commands from an
operator workstation. The first lines verify the AWS account identity as in
[AWS replacement and disposal](#aws-replacement-and-disposal):

```sh
set -eu
EXPECTED_ACCOUNT_ID=YOUR_12_DIGIT_ACCOUNT_ID
AWS_REGION=YOUR_AWS_REGION
BACKUP_BUCKET=YOUR_BACKUP_BUCKET
test "$(aws sts get-caller-identity --query Account --output text)" = "$EXPECTED_ACCOUNT_ID"

# In us-east-1 omit --create-bucket-configuration (an AWS rule).
aws s3api create-bucket --region "$AWS_REGION" --bucket "$BACKUP_BUCKET" \
  --create-bucket-configuration LocationConstraint="$AWS_REGION"

aws s3api put-public-access-block --region "$AWS_REGION" --bucket "$BACKUP_BUCKET" \
  --public-access-block-configuration \
  "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true"

aws s3api put-bucket-versioning --region "$AWS_REGION" --bucket "$BACKUP_BUCKET" \
  --versioning-configuration Status=Enabled

aws s3api put-bucket-encryption --region "$AWS_REGION" --bucket "$BACKUP_BUCKET" \
  --server-side-encryption-configuration \
  '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'

aws s3api put-bucket-lifecycle-configuration --region "$AWS_REGION" --bucket "$BACKUP_BUCKET" \
  --lifecycle-configuration '{
    "Rules": [{
      "ID": "backup-retention",
      "Status": "Enabled",
      "Filter": {"Prefix": ""},
      "Expiration": {"Days": YOUR_RETENTION_DAYS},
      "NoncurrentVersionExpiration": {"NoncurrentDays": YOUR_NONCURRENT_DAYS}
    }]
  }'
```

Retention is the operator's choice and must follow the operator's privacy policy, because a backup
keeps erased data until it expires.

Transfers to and from the backup bucket use short-lived operator credentials, the same ones as the
secret-store example, exported only in the shell that runs `aws s3 sync` and removed afterwards
with `unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN`.

Attach an inline policy allowing bucket access to an operator role you create or already have,
using this workstation command:

```sh
aws iam put-role-policy --role-name YOUR_OPERATOR_ROLE \
  --policy-name FramedashBackupStorage --policy-document '{
    "Version": "2012-10-17",
    "Statement": [
      {
        "Effect": "Allow",
        "Action": ["s3:ListBucket"],
        "Resource": "arn:aws:s3:::'"$BACKUP_BUCKET"'"
      },
      {
        "Effect": "Allow",
        "Action": [
          "s3:PutObject",
          "s3:GetObject",
          "s3:AbortMultipartUpload"
        ],
        "Resource": "arn:aws:s3:::'"$BACKUP_BUCKET"'/*"
      }
    ]
  }'
```

This policy allows `s3:ListBucket` on the bucket and `s3:PutObject`, `s3:GetObject`, and
`s3:AbortMultipartUpload` on objects, with no delete permissions. It must not be added to the
stack's `InstanceRole` because containers share that role. `compose.mjs` ignores AWS credentials
set in the shell, so these exports do not reach the application containers. The host has the AWS
CLI on the default Amazon Linux 2023 AMI.

### Create

Run the create command:

```sh
node backup.mjs create --configfile .env --key-file KEY \
  --output-dir /srv/framedash/backups -- -f compose.yml -f compose.preview.yml
```

The output JSON's `backup` field gives the directory path, and `ID` below means its directory name.

What it does, in order:

1. Stops proxy and ingest.
2. Waits up to 5 minutes for the consumer to drain the queue, requiring an approximately empty main
   queue for 2 minutes.
3. Stops consumer, scheduler, web, redis-http.
4. Records image references, migration journals and row counts.
5. Runs pg_dump.
6. Stops ClickHouse and Redis cleanly (a non-zero exit fails the backup) and archives their
   directories.
7. Restarts exactly what was running, also after a failure or interrupt.

Exit codes:

- `0`: Complete.
- `2`: The backup was written but marked incomplete (`complete:false`) because events remained
  queued or the dead-letter queue is not empty; it is still restorable, but see
  [How queued events are handled](#how-queued-events-are-handled); diagnose and take another.
- `1`: The backup failed and left no partial directory; services were restarted.

If services do not restart, an `ERROR` line names them to start with Compose and the exit code
is 1, even when the backup itself finished; in that case the output JSON has `success:true`,
`restarted:false` and the `backup` path, so the backup is usable.

A lock file `<config>.backup-lock` prevents concurrent create and restore runs; remove it only
after confirming nothing runs.

Then sync the backup to off-host storage using the operator credentials described in
[Off-host storage](#off-host-storage):

```sh
aws s3 sync /srv/framedash/backups/ID s3://YOUR_BACKUP_BUCKET/ID/
aws s3 ls s3://YOUR_BACKUP_BUCKET/ID/
unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN
```

Confirm that all five files are there. Run verify from the bucket copy on a place other than the
source host when possible, then delete the local copy.

Verify usage:

```sh
node backup.mjs verify --key-file KEY --backup DIR
```

It decrypts every component and compares SHA-256, and prints the backup's `complete` value. It runs
from an extracted installer directory with Node 22. The directory name must stay unchanged
because it is bound into the encryption.

A verified file is not a tested restore. Take a backup before every host replacement or image
update and record the output JSON.

### How S3 versions are handled

The backup does not copy S3 objects. The versioned, retained application bucket is its own
durability layer. Same-stack host replacement keeps using it and needs nothing. A new stack gets an
empty bucket: uploaded map images are missing until an operator copies current objects from a
workstation with `aws s3 sync` from the old bucket to the new one (the host role of either stack
cannot reach the other bucket). Noncurrent versions and delete markers are never copied and stay in
the source bucket under its lifecycle. An object deleted after the backup survives as a noncurrent
version until `NoncurrentVersionRetentionDays` expires it; to bring it back for a restored record,
an operator removes the delete marker with `aws s3api delete-object --version-id`. The application
role cannot list or delete versions. Loss of the bucket itself is not recoverable from this backup;
if you need that, add S3 replication separately.

### How queued events are handled

This tool does not save or restore SQS messages, so create drains the queue first. SQS counts are
approximate, so a drained result is strong evidence, not proof. If not drained or the DLQ is
non-empty the backup is marked incomplete. Once the source resumes, those events are
processed into the source's ClickHouse, not into this backup, so that backup can never contain
them; do not count on them being in the queue later. Retention is measured from the original enqueue
(main 4 days, DLQ 14 days), not from the backup. DLQ messages are left untouched, never drained or
discarded by backup; no automatic replay exists. A restored installation with new queues receives
nothing from old queues. Queue replay remains unverified on AWS. A stopped consumer's long poll can
claim a message that then waits out its 120-second lease; such events arrive late, not lost.

### Restore into a separate empty installation (acceptance drill and new-stack recovery)

Prerequisites:

- A second stack from the same template with its own queue, DLQ and bucket.
- The installer of the same release extracted and images loaded and verified.
- `configure.mjs` run to generate a new `.env` with that stack's coordinates.
- Services never started (no `up`, no `bootstrap`).
- The key fetched from the secret store on that host.
- The backup synced down with the directory name unchanged, to `/srv/framedash/restore/ID`.

The second stack is charged until disposed of, and one Docker host cannot hold two installations
because the Compose subnet and ports are fixed.

Run the restore command:

```sh
node backup.mjs restore --configfile .env --key-file KEY \
  --backup /srv/framedash/restore/ID -- -f compose.yml -f compose.preview.yml
```

The restore command verifies everything first; it refuses when the target has containers,
non-empty data directories, a different release or image, or a queue or bucket shared with the
backed-up installation. It rewrites `.env`: keeps this installation's `DOMAIN`, `APP_URL`,
`AWS_REGION`, AWS credentials, SQS, S3, `DATA_DIR`, `EMAIL_FROM`, `SMTP_URL`,
`TRUSTED_PROXY_CIDRS`; takes everything else from the backup, including database passwords,
`AUTH_SECRET`, `CRON_SECRET`, audit and erasure secrets, admin credentials and SDK key; the
previous file is saved as `.env.pre-restore`. It extracts ClickHouse and Redis, starts the three
stores, restores PostgreSQL in a single transaction, and compares migration journals and row
counts (exact for PostgreSQL and plain MergeTree tables without a TTL; other ClickHouse tables
must exist).

Application services stay stopped. A failed restore leaves a partly filled installation: discard it
(delete the stack or empty `DATA_DIR`) and start again; do not repair.

`--same-aws-resources` is only for host replacement inside the same stack after confirming the
original host is stopped or gone. Never use it on a drill.

### Reopen in stages

A restore rewinds deletions to the backup time, so nothing should accept traffic until they are
reconciled. Reopen in stages in this order:

1. Start `web` (starts `web`, `migrate` and `redis-http` only; the three stores are already up):

   ```sh
   node compose.mjs --configfile .env -- \
     -f compose.yml -f compose.preview.yml up -d --no-build web
   ```

2. Run `replay-erasures`:

   ```sh
   node backup.mjs replay-erasures --configfile .env -- -f compose.yml -f compose.preview.yml
   ```

   It replays every active tombstone with restored keys and re-arms suppression, keeping settlement
   deferred. It must succeed.

3. Re-apply what happened after the backup time (`createdAt` in the JSON). Keep records of
   erasure and deletion requests outside this installation, because the restored database no
   longer contains them and the audit log rewinds too. Player erasures: start `proxy` with access
   limited to the operator (loopback through SSM, or `AllowedClientCidr` narrowed to the operator
   and DNS not yet moved):

   ```sh
   node compose.mjs --configfile .env -- \
     -f compose.yml -f compose.preview.yml up -d --no-build --no-deps proxy
   ```

   `--no-deps` keeps `ingest` stopped, so no events are accepted yet and SDK requests to
   `/v1/events` fail. Keep access limited because the dashboard is reachable. Re-submit
   `POST /api/v1/data/erase` with `project_id` and `player_id` in the JSON body using an API key
   (`X-API-Key` header) with `data:admin` scope. Account and project deletions likewise through the
   normal paths. If you cannot establish what happened after the backup time, do not open the
   installation.

4. Start `consumer`:

   ```sh
   node compose.mjs --configfile .env -- \
     -f compose.yml -f compose.preview.yml up -d --no-build consumer
   ```

   Let it drain, including any held events if resources are shared.

5. Stop `consumer`, then run final erasure replay:

   ```sh
   node compose.mjs --configfile .env -- \
     -f compose.yml -f compose.preview.yml stop consumer
   node backup.mjs replay-erasures --final --configfile .env -- \
     -f compose.yml -f compose.preview.yml
   ```

   The final replay refuses while the consumer runs, waits up to 5 minutes for the main queue to
   stay approximately empty for 2 minutes, and refuses if it does not, then settles expired
   tombstones. If it refuses because events remain, start the consumer again and repeat this step.

6. Start all services (this command also starts `ingest` and the scheduler):

   ```sh
   node compose.mjs --configfile .env -- \
     -f compose.yml -f compose.preview.yml up -d --no-build
   ```

   Then check health, sign in, compare data using the check block in
   [Checks, updates and backups](#checks-updates-and-backups), then move DNS or widen
   `AllowedClientCidr`. A consumer restart after this is normal.

### Acceptance record

For the drill, record backup time, restore duration, the JSON outputs, and dashboard project and
event counts on both sides; then dispose of the second stack per
[AWS replacement and disposal](#aws-replacement-and-disposal).

## AWS replacement and disposal

The template enables EC2 termination protection (`DisableApiTermination=true`), which can
block CloudFormation deletion or replacement of the instance. Perform AWS lifecycle operations
from an operator workstation authenticated to the intended account with the required management
permissions; the host's application role does not provide those permissions. Stop writes and
complete the [Backup and restore](#backup-and-restore) checks above before an approved replacement
or disposal.

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
automatic upgrade. If the operation is canceled and the original instance survives,
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

## Planned data-volume growth

Choose sufficient `DataVolumeSize` at creation. Increasing that parameter on an existing stack
changes the EBS block capacity; it does not rerun cloud-init or extend the ext4 filesystem.
Storage growth requires a separate maintenance plan and has not been exercised by this release's
validation. It does not establish an application upgrade/downgrade contract, and shrinking an
existing EBS volume is not a rollback path.

1. First run `backup.mjs create` while services run, as in [Create](#create), and sync and verify
   the off-host copy. Only then pause SDK writes and stop all Compose services cleanly from the
   privileged installer shell with
   `node compose.mjs --configfile .env -- -f compose.yml -f compose.preview.yml stop`. Stop the
   Docker daemon with `systemctl stop docker` to prevent container restarts during maintenance.
   Keep `/srv/framedash` mounted. Take an EBS snapshot, record its exact volume ID and filesystem
   UUID, and verify the snapshot is complete.
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
run `systemctl start docker` and the compose `up -d --no-build` command from the
[install sequence](README.md#install-sequence). Check health and stored data before resuming SDK
writes. Larger EBS capacity is billed even if its filesystem was not extended; the maintenance
snapshot also incurs storage charges. See
[AWS filesystem extension](https://docs.aws.amazon.com/ebs/latest/userguide/recognize-expanded-volume-linux.html),
[modification states](https://docs.aws.amazon.com/ebs/latest/userguide/monitoring-volume-modifications.html)
and [EBS pricing](https://aws.amazon.com/ebs/pricing/).

## Release contents and image identity

`release.json` records the exact version, `linux/amd64` application image names, source image IDs
and archived image config IDs, the image-archive SHA-256 and the tested origin `http://localhost:8088`.
The installer archive contains a single `framedash-installer-VERSION/` directory whose root-owned
entries carry no group or other write permission. `release.json` identifies the source archive under
`baseSources`; it provides the exact Debian source packages used by the application base images and
the bundled native-library sources and build recipes.

Docker stores can report a source manifest identity or the archived config identity after loading;
the image archive's SHA-256 is the authoritative check of the distributed bytes. The Compose file
uses those versioned local tags with `pull_policy: never`: a missing application image fails instead
of pulling an unverified registry image. The Compose file contains no source build instructions.
Third-party service images are fetched from their upstream registries; the application-image archive
is not a complete air-gapped distribution.

## Validation details

This release's backup and restore commands passed a local restore into a separate empty
installation covering PostgreSQL, ClickHouse, Redis and configuration. `backup.mjs` has not run on
real AWS, neither `create` nor `restore`, so treat it as unproven there until your own drill
passes; S3 objects are not part of it. The application does not erase S3 versions; only the
optional noncurrent-version expiry or an operator does. Mailpit was used for email tests on the
local loopback route only. Verified on real AWS with a v1.0.0 candidate build, not repeated for
this release: real SMTP delivery through SES with DKIM to an inbox; custom-domain DNS/TLS through ALB and ACM; persistence across an
auto-stop and start (start recovered in about 90 seconds, the public IP changed, the target was
healthy, and data, UUID and password hash were identical); sign-in in a real browser and HTTP 200
from all 17 dashboard pages (page-by-page browser rendering was not reviewed). Still unverified:
enterprise SSO, sustained load and long-duration operation, AWS disaster recovery, queue replay,
the internal ALB scheme on AWS, in-place upgrades. Replay of an active tombstone with restored
keys was verified locally and remains unverified on AWS. The included HTTPS Caddy
configuration is a deployment reference only; the loopback and ALB routes are the tested routes. In
particular, the optional AWS template's restricted inbound CIDR does not support public HTTP ACME
validation without a separately reviewed certificate setup.
