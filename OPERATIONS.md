# Operations

See [README.md](README.md) for release requirements, download verification, and the
[install sequence](README.md#install-sequence).

Every Compose example in this document uses the loopback form, and ALB installations replace
`-f compose.preview.yml` with `-f compose.alb.yml`.

## Operating model

Framedash runs on one host with no high availability. PostgreSQL, ClickHouse and Redis share one
data volume. EC2 recover covers host hardware failure only; it does not fix an Availability Zone
outage or lack of capacity, and it cannot be triggered on demand, so it ships configured but not
exercised.

Responsibilities:

- Operator: owns the AWS account, stack, NAT, SNS topic, DNS, certificates, SMTP, OS maintenance,
  the backup key copy; answers alarms; restores; applies upgrades.
- Host services: monitor reports every minute; nightly backup runs on its timer.
- Crane Valley: Crane Valley LLC does not hold the client's AWS credentials or operate the
  client's AWS account.

Data-loss bound on total host failure: recovery is limited to the last good backup; with successful
nightly backups that is about one day of PostgreSQL, ClickHouse and Redis data, and failed or
incomplete backups make it older (`BackupAgeAlarm` fires after 36 hours). S3 objects stay in the
versioned bucket and are not in backups. Queued events are drained first: a backup stops ingest and
waits for the consumer before it copies data.

Nightly backups take the application offline.
On AWS with small data, the backup service took 2m48s, and clients saw 502 for 2m41s. Locally with
10.8 million events, the downtime window was 208 s, total time was 217 s, and the archive was
520 MB.

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

Runtime containers have a three-minute Compose stop grace, except the scheduler which has 15 s
(it has no SIGTERM handler). Ingest drains accepted requests and background work; consumers drain
the current SQS batch, then close native database connections. The default SQS visibility lease is
120 seconds and renews during processing. On a host reboot under load, clients saw about 30 s of
errors; a stop and start caused about 48 s. No `ServiceHealthAlarm` fired for those short outages,
row snapshots were identical, and senders retried with no events missing.

Redelivered messages are deduplicated: redelivery after a consumer SIGKILL, docker stop, reboot and
instance stop left raw rows, both daily count views and Redis usage exact (tested with 443,000
accepted and 443,000 in each under 1,000 events/s; queues 0, DLQ 0). Deduplication holds 200,000
log IDs per table (2 per message on the events table), not a duration; at the measured consumer
ceiling of 60 IDs/s that is about 55 minutes, a higher rate shortens it, and a replay after the IDs
are evicted can insert duplicates. Sender retries of an ingest request whose 202 response was lost
are covered only inside that same window. Retain queues and rely on this tested deduplication path.

### Updates and downgrades

Keep the original configuration and privacy keys when updating. There is no in-place upgrade from
a 0.1.0-preview release, so install a 1.x release fresh and move data only by your own reviewed
process. Each later release states in its notes which versions it was tested to upgrade from, and
any other path is unsupported. 1.2.2 upgrades in place from 1.1.0, 1.2.0 or 1.2.1, see
[Upgrades](#upgrades). A downgrade is never supported, because replacing images does not roll back a
migrated schema; back up first and test against a restored copy. Check the new release's archive
SHA-256 and image IDs.

Before replacing a host or image version, run a backup, record the release and the backup's output
JSON, and test a restore; see [Backup and restore](#backup-and-restore).

## Backup and restore

### What it covers

`backup.mjs` is the backup tool. An operator runs it by hand; on a production host the nightly
service runs it, see [Nightly backup](#nightly-backup). It produces one directory named
`framedash-backup-<time>-<random>` containing encrypted files: `config.enc`, `postgres.enc`,
`clickhouse.enc`, `redis.enc`, and `manifest.enc`. Each component is encrypted with AES-256-GCM in
1 MiB authenticated chunks using a per-file key derived by HKDF-SHA256; truncation, reordering, and
swapping between backups are detected. No plaintext temporary file is written.

It takes the application offline: expect downtime; ingest and the dashboard are unavailable while
it runs, and SDKs should buffer and retry.

With `AutoStopHours` above 0, check the auto-stop timer first so the host does not stop mid-backup:

```sh
systemctl list-timers --all framedash-autostop.timer
```

A graceful stop of the backup restarts the services (see [Nightly backup](#nightly-backup) for
detail). An ungraceful termination (kill, timeout, host crash) can leave the maintenance lock and,
if it was created, an `ID.partial` directory; confirm the run and its containers have stopped
before following the stale-lock recovery steps in [Alarm response](#alarm-response).

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
readable by group or others and, when run as root, one not owned by root. Move the key into your
secret store (for example AWS Secrets Manager in the same Region, or the operator password manager)
before relying on it, because a host-loss recovery needs it from somewhere other than the host. For
a host running nightly backups the key must also stay on the root disk, mode 0400, owned by root,
such as `/etc/framedash/backup.key`, with a copy in the secret store, see
[Production deployment](DEPLOY-AWS.md#production-deployment). Never store it under `DATA_DIR`, next
to backups, or in the backup bucket: `create` refuses a key inside `DATA_DIR` or the output
directory.

`--key-file /dev/stdin` lets a secret-store command pipe the key in so it does not rest on the host:

```sh
AWS_REGION=YOUR_AWS_REGION
aws secretsmanager get-secret-value --region "$AWS_REGION" --secret-id YOUR_SECRET_ID \
  --query SecretString --output text | \
  node backup.mjs create --configfile .env --key-file /dev/stdin \
    --output-dir /srv/framedash/backups -- -f compose.yml -f compose.preview.yml
```

The instance role has no secret-read access and must not be given any, because application
containers share that role. With `BackupRetentionDays` set it has `s3:PutObject` on the stack's
backup bucket and nothing else there: it cannot read, list or delete backups. The shell running this
example uses short-lived operator credentials, as described in
[Off-host storage](#off-host-storage).

A lost key means every backup made with it is unrecoverable; there is no reset. Keep the key for as
long as any backup made with it is retained.

### Off-host storage

With `BackupRetentionDays` set, the stack already has the backup bucket (output `BackupBucketName`)
and the nightly service uploads to it. Use the steps below only for a stack without it. To read
from the stack's bucket, use an operator role with the `s3:ListBucket` and `s3:GetObject`
permissions below, because the host cannot.

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

### Nightly backup

`framedash-backup.timer` starts `framedash-backup.service` once a day at the `--backup-time` UTC
time. A missed time is not caught up. The service timeout equals `--maintenance-minutes` and covers
the whole run including verify and upload.

It runs `backup.mjs create` with the key and output directory from `/etc/framedash/host.json`,
verifies the result, then uploads each file with `aws s3 cp --checksum-algorithm SHA256` to the
write-only bucket, with `manifest.enc` last, under `ID/`.

Good means all of: `backup.mjs create` exit 0, `complete:true`, `restarted:true`, verify passed,
every file uploaded. Only then does it write `lastGoodAt` to
`/srv/framedash/data.backup-state.json` and delete the local backups up to and including this one.
So after a good run no local copy remains, and the host cannot read the bucket.

An incomplete backup (exit 2) is verified and uploaded but is not good: state is not written, the
local copy stays, the service exits 2 and shows failed. A non-empty dead-letter queue makes every
run incomplete, so `DeadLetterAlarm` left unresolved becomes `BackupAgeAlarm`.

A failed run exits 1, including a backup whose services did not restart. It writes no state, so
`LastBackupAgeHours` keeps growing. A failure partway through the upload leaves the objects already
sent, with no manifest, and the local copy stays; a failure writing state comes after the upload.

An interrupted run (`systemctl stop`, service timeout or host shutdown) waits for services to
restart (tested: all back in 60 s). If the signal lands exactly while ClickHouse is stopping, Compose
start can fail: the journal records an ERROR line naming the services, the unit exits 1, and Compose
up recovers. A hard kill leaves the maintenance lock and an `ID.partial` directory; the recovery
steps in [Alarm response](#alarm-response) worked (health back in 4 s, retry good).

`host-monitor.mjs` reads the state file and publishes `LastBackupAgeHours`. Missing or unreadable
state publishes no metric, and `BackupAgeAlarm` treats that as breaching. It fires above 36 hours.
A backup run by hand does not update this state; run `systemctl start framedash-backup.service` to
retry.

While the maintenance lock is younger than `--maintenance-minutes`, the monitor reports `Healthy` 1
and `MaintenanceActive` 1, so a nightly run does not trip `ServiceHealthAlarm`. ALB alarms evaluate
over `MaintenanceAlarmMinutes` for the same reason.

Backups expire after `BackupRetentionDays` and go 7 days later; erased data stays until then.
Incomplete multipart uploads are aborted after 7 days.

Check commands:

```sh
journalctl -u framedash-backup.service --since '2 days ago'
cat /srv/framedash/data.backup-state.json
```

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

A lock file `<DATA_DIR>.maintenance-lock` prevents concurrent backup, restore, upgrade and
host-service install runs. It is never taken over, because a dead parent says nothing about its
containers. Remove it by hand only after confirming the task and its containers have stopped. To run
a manual repair under the lock, use `node maintenance.mjs run -- COMMAND`, which refuses if another
task holds it.

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
nothing from old queues. Redelivery by SQS after a crash is tested (see
[Shutdown and replay](#shutdown-and-replay)); redrive from the DLQ to the main queue was verified
locally on LocalStack, not on AWS (see [Redis full](#redis-full)); replay from old queues into a
restored installation is not verified. A stopped consumer's long poll can claim a message that then
waits out its 120-second lease; such events arrive late, not lost.

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

On a production stack, after step 6 set up the backup key and host services as in
[Production deployment](DEPLOY-AWS.md#production-deployment). The key file and
`/etc/framedash/host.json` are on the root disk and the state file starts absent, so
`BackupAgeAlarm` stays in ALARM until the first good nightly backup there.

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

## Disk growth

Tested on AWS on 1.2.0 final candidate images: raising `DataVolumeSize` from 80 to 100 GiB online
under 1,000 events/s; the change set showed Modify only with no replacement, the stack update took
31 s, and there were no client errors and no container restart.

Choose sufficient `DataVolumeSize` at creation. Raising that parameter on an existing stack changes
the EBS block capacity; it does not extend the ext4 filesystem. Shrinking an existing EBS volume is
not a rollback path.

1. Confirm a good backup in the last 36 hours (`LastBackupAgeHours`), or run `systemctl start
   framedash-backup.service`. Do not start during a backup window. Record the volume ID and
   filesystem UUID.
2. From the account-verified workstation, change only `DataVolumeSize` in `stack-params.json` and
   use the change set procedure of [Production deployment](DEPLOY-AWS.md#production-deployment). The
   change set must show `DataVolume` with Action `Modify`, and neither `Instance` nor `DataVolume`
   may show Replacement `True` or `Conditional`; stop otherwise.
3. After execution, use `aws ec2 describe-volumes-modifications --region "$AWS_REGION"
   --volume-ids YOUR_RECORDED_DATA_VOLUME_ID` and wait for `optimizing` or `completed`. Confirm the
   larger block capacity on the host before extending the filesystem.
4. In the privileged host shell, services still running, substitute the recorded volume ID and
   UUID below. These guards require the template's whole-disk ext4 layout and exact mounted disk:

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

5. After every check passes and the capacity matches, `resize2fs "$DATA_DEVICE"` while mounted.
   Never use `mkfs` on an existing installation. A partitioned disk, another filesystem, a missing
   mount or a UUID mismatch needs a different reviewed procedure. Verify with
   `df -hT /srv/framedash`. `BackupHeadroomAlarm` clears on the next monitor reports after its
   evaluation periods.

Larger EBS capacity is billed even if its filesystem was not extended. See
[AWS filesystem extension](https://docs.aws.amazon.com/ebs/latest/userguide/recognize-expanded-volume-linux.html),
[modification states](https://docs.aws.amazon.com/ebs/latest/userguide/monitoring-volume-modifications.html)
and [EBS pricing](https://aws.amazon.com/ebs/pricing/).

## Alarm response

Names below are logical IDs from `aws/cloudformation.json`; CloudFormation prefixes the stack name
in the deployed alarm name. `Healthy` is reported by the monitor.

| Alarm | Means | First action |
| --- | --- | --- |
| HostSystemStatusAlarm | Host hardware failed for 2 minutes; EC2 recover was attempted. Recover does not fix an AZ outage or lack of capacity. | Check the instance state and run the [checks](#checks-updates-and-backups). If recover did not work, restore on a new host. |
| HostInstanceStatusAlarm | Host OS failed its status check for 3 minutes; EC2 reboot was attempted. | Connect through Session Manager, run the checks, read the system journal. |
| AlbHealthyHostAlarm | No healthy target for MaintenanceAlarmMinutes, longer than the backup window. | Check `findmnt /srv/framedash`, Docker and Compose `ps`, then `curl --fail http://localhost:8088/api/health`. |
| AlbTarget5xxAlarm | The application returned more than 5 5XX responses per minute for 5 minutes. | Read the `web` and `ingest` logs with Compose `logs`. |
| AlbElb5xxAlarm | The ALB returned more than 5 5XX responses per minute for MaintenanceAlarmMinutes. | Same as AlbHealthyHostAlarm. |
| QueueAgeAlarm | The oldest queued event is older than 1800 seconds for 15 minutes; the consumer is behind or stopped. | Check the `consumer` service and logs, and ClickHouse health. Main queue retention is 4 days. |
| DeadLetterAlarm | Messages reached the dead-letter queue. | Diagnose, then either redrive to the main queue as in [Redis full](#redis-full) or discard after review as in [Runtime configuration](DEPLOY-AWS.md#runtime-configuration). Retention is 14 days. Until the queue is empty, nightly backups are incomplete. |
| ServiceHealthAlarm | For 3 minutes `Healthy` was 0 or missing: a service is not running or healthy, `/api/health` or `/api/health/cron` failed, Redis memory reached 80 percent of maxmemory, a maintenance task overran `--maintenance-minutes` with services still down, or the monitor stopped reporting. | `journalctl -u framedash-monitor.service`, Compose `ps`, both health endpoints, then the lock file. GET `/api/health/cron` lists stale crons. See [Redis full](#redis-full). |
| BackupHeadroomAlarm | For 15 minutes the data disk could not hold the next backup: free space is below 1.2 times used space. | Follow [Disk growth](#disk-growth) before the next backup. |
| RootDiskAlarm | The root disk was above 80 percent for 15 minutes, or no metric. It is 30 GiB; Docker data is on the data volume. | Find what grew; check `journalctl --disk-usage`. |
| BackupAgeAlarm | No good uploaded backup in the last 36 hours, or no state yet. | Read `journalctl -u framedash-backup.service`. Clear the cause, then `systemctl start framedash-backup.service`. |

A run killed hard leaves `/srv/framedash/data.maintenance-lock`, which holds owner, pid and
startedAt. It is never taken over. It blocks later backups, so `BackupAgeAlarm` follows, and after
`--maintenance-minutes` it no longer masks an unhealthy service. Remove it by hand only after
confirming that task and its containers have stopped (`ps -p PID`, `docker ps`). A hard-killed
backup also leaves `ID.partial`, remove it and start the services.

`ServiceHealthAlarm` can fire about 30 minutes after a nightly backup that covered minute 0 of an
hour, for the reason given in [Production deployment](DEPLOY-AWS.md#production-deployment); the
next hourly success clears it. To confirm, read `/api/health/cron`.

If services fail to restart after a backup, the run exits 1 with an `ERROR` line naming them; start
them with Compose.

## Upgrades

This release's `upgrade.mjs` accepts source 1.1.0, 1.2.0 or 1.2.1; any other source or a downgrade
is refused. Run it from the new release directory, as root.

It upgrades the installation only, not the stack: a host on a v1.1.0 stack keeps that template's
auto-stop, public address and lack of alarms. Do not install host services on it, because its
instance role has no `cloudwatch:PutMetricData` or backup bucket access.

From 1.2.0 or 1.2.1 the upgrade changes only the installation and the stack needs no change; host
services are reinstalled by step 12 below.

Before you start, in order:

1. Extract the new installer into its own directory under `/srv/framedash`, as in README "Download
   and verification", with the image archive inside that directory beside `release.json`. Do not
   run `configure.mjs` there. `upgrade.mjs` copies the current `.env`, verifies the archive
   SHA-256 against `release.json`, needs free space of 4 times the archive size in `DATA_DIR`, and
   loads the images itself.
2. If you changed the redis service in the old release's `compose.yml` (for example raised
   `--maxmemory` and `mem_limit` as in [Redis full](#redis-full)), make the same change in the new
   release's `compose.yml` before running `upgrade.mjs`, after verifying the installer checksums;
   `upgrade.mjs` copies only `.env`. Otherwise the new release starts with the shipped 1gb limit and
   a Redis already above 1 GB refuses writes, so the consumer pauses while health still returns 200.
3. From the OLD release directory take a backup and verify it. It must be complete (exit 0), taken
   on the source release, belong to this installation, and be under 24 hours old when the upgrade
   checks it. A nightly backup leaves no local copy, so take one here, or download one with
   operator credentials.

```sh
node backup.mjs create --configfile .env --key-file KEY \
  --output-dir /srv/framedash/backups -- -f compose.yml -f compose.alb.yml
node backup.mjs verify --key-file KEY --backup /srv/framedash/backups/ID
```

These commands show the ALB route. Loopback installations use `compose.preview.yml` here and below.

4. With `AutoStopHours` above 0, check the auto-stop timer.

Run from the new release directory:

```sh
node upgrade.mjs --current-config /srv/framedash/OLD_RELEASE_DIRECTORY/.env \
  --compose-file compose.yml --compose-file compose.alb.yml \
  --backup /srv/framedash/backups/ID --key-file KEY
```

`--compose-file` repeats once per file, `compose.yml` first, and takes bare file names resolved in
the new release directory, never a path. Pass the same files on every run. The first run copies
`--current-config` to `.env` in the new directory and refuses if a different `.env` is already
there: remove it and run again.

The `--compose-file` list must include `compose.alb.yml` or `compose.preview.yml` (refusing with
`"--compose-file needs compose.alb.yml or compose.preview.yml, which publish the 8088 health port"`),
because the health wait and host monitor check `http://127.0.0.1:8088` and plain `compose.yml`
publishes only ports 80 and 443. An installation run with `compose.yml` alone (public HTTPS) cannot
use `upgrade.mjs` or host services; install 1.2.2 fresh on the production ALB route instead.

`--skip-backup-check accept-unrecoverable-failure` replaces `--backup` and `--key-file`. With it a
failed migration cannot be recovered. Do not use it for an installation you need to keep.

What it does, in order:

1. Verifies archive SHA-256 and free space.
2. Loads and checks images.
3. Confirms the application is running.
4. Checks the backup.
5. Records `stopping` in `/srv/framedash/data.upgrade-journal.json`.
6. Runs Compose `down --remove-orphans`, then records `stopped`.
7. Starts the three stores.
8. Runs `migrate`.
9. Starts every service and waits up to 5 minutes for healthchecks.
10. Waits up to 5 minutes for `/api/health`.
11. Removes the journal.
12. Reruns `install-host-services.mjs --reuse-existing` if `/etc/framedash/host.json` exists.

Success prints JSON with `success`, `from` and `to`.

If interrupted, rerun the same command. With `stopped` in the journal, or `stopping` with none of
`web`, `ingest`, `consumer` or `scheduler` running, it repeats from the stop. Otherwise every check
repeats. With no journal and the new release running, it refreshes host services only. If a lock remains, the failure names
it. There are two locks: `/srv/framedash/data.maintenance-lock` and
`.env.backup-lock` beside the old `.env`. Remove a lock only after confirming the task and its
containers stopped.

If migration fails, never edit migrations or reset journals. Keep the failed installation for
diagnosis, and restore the backup into a new installation of the previous release, as in
[Restore into a separate empty installation](#restore-into-a-separate-empty-installation-acceptance-drill-and-new-stack-recovery).
There is no rollback on the same data.

After success run the checks from the new directory. Keep the old release directory until the
upgrade is confirmed, because a rerun reads `release.json` and `.env` from it.

Upgrading from 1.1.0 to 1.2.0 was tested locally only, including ClickHouse 26.4 to 26.8 LTS with
data retained; it was not rehearsed on AWS. A backup restores only onto the same release and images;
recovering from a 1.1.0 backup requires restoring onto 1.1.0 first, then upgrading.

## OS maintenance

Run monthly, after a good nightly backup and outside its window. The host is locked to a versioned
Amazon Linux repository. In the privileged shell:

```sh
dnf check-release-update
dnf upgrade --releasever=VERSION
systemctl reboot
```

No output from the first command means nothing newer. `VERSION` is a specific release it lists; do
not use `latest`. After reconnecting run the [checks](#checks-updates-and-backups):
`findmnt /srv/framedash`, Compose `ps`, health. At a reboot under load clients saw about 30 s of
errors and `ServiceHealthAlarm` did not fire; during a longer outage it fires in about 3 minutes
while the monitor runs, or in about 9 minutes when the reporter itself is stopped. Containers
restart by their `unless-stopped` policy. Docker Compose is a pinned plugin (v2.39.4), dnf does not
update it. An AMI
change is a host replacement, not routine maintenance: changing `AmiImageId` replaces the
Instance, which the change set rule forbids; see
[AWS replacement and disposal](#aws-replacement-and-disposal).

## Capacity

Measured on AWS on an m7i.xlarge host with 1.2.0 final candidate images, through the ALB on real
SQS, one API key, 100-event batches, 10 minutes each. All accepted events were inserted, 0 were
dropped, peak visible queue was 81, drained at once, dead-letter queue stayed at 0, and no alarm
fired. Results stand for repetitive 100-event batches:

| Rate (events/s) | Duration | Accepted = inserted events | p50 ms | p95 ms | p99 ms |
| --- | --- | --- | --- | --- | --- |
| 200 | 10 min | 119,900 | 22 | 34 | 51 |
| 1,000 | 10 min | 599,900 | 21 | 32 | 53 |
| 3,000 | 10 min | 1,799,900 | 20 | 36 | 94 |

- Latency is the HTTP response time of the ingest request through the ALB as seen by the client
  host, excluding queue time.
- A local run on 1.2.0 final candidate images sustained 3,000 events/s for 60 minutes: 10,799,900
  accepted and inserted events, 0 restarts, 0 OOM, drained within 1 minute. Latency was not recorded
  for this run on 1.2.0 final candidate images.
- Consumer ceiling: about 24 to 30 messages per second with 72 in flight on m7i.xlarge, so a backlog
  built at 3,000 events/s in 100-event batches does not shrink until load drops.
- Resource peaks observed on AWS: ClickHouse 42% CPU, 761 MB; consumer 49% CPU, 176 MB; ingest
  44% CPU, 105 MB.
- Backlog case (earlier 1.2.0 candidate, local, not repeated on final images): with the consumer
  stopped, 616 maximum-size batches (10,000 events each, 6.16 million events) were queued; after the
  consumer started they were drained in about 3 minutes. The consumer's peak memory reached its 2 GiB
  limit, it did not restart, and the dead-letter queue stayed empty.
- Limits that apply regardless of host size: 128 KB compressed per request; 10,000 events per
  request batch; 5 MiB decompressed per batch; 2,000 requests per minute per source IP; 2,000,000
  requests per hour per API key. All devices behind one NAT share the source IP limit.
  [PARITY.md](PARITY.md) has the detail.
- Backup downtime: on AWS with small data, the backup service took 2m48s, and clients saw 502 for
  2m41s. During the AWS soak, the nightly backup took 3m33s for about 1 GB uploaded, clients saw
  502 for about 3m16s, the sender retried 1,073 times with nothing lost, and no alarm fired. The
  final backup took 3m06s (762 MB encrypted, 14.18 million events). Locally with 10.8 million
  events, the downtime window was 208 s, total time was 217 s, and the archive was 520 MB. Expect
  the window to grow with data size.
- Disk use per event is not given: the load generator's repetitive synthetic events compress far
  better than real ones, so the measured figure must not be used for sizing. Size from the host's
  own growth, and act on `BackupHeadroomAlarm`. See [Disk growth](#disk-growth).
- Each consumer batch (one SQS message, one ingest batch of up to 10,000 events) writes one budget
  claim key `budget_claim:{tenant}:{token}` of about 282 bytes in Redis 7 that lives 7 days. 1 GB
  holds about 3.8 million claims, which alone fill memory at a weekly average of about 6.3
  messages/s (about 630 events/s for 100-event batches, the measured condition). The 80 percent
  `Healthy` threshold is reached at about 5 messages/s (about 500 events/s in 100-event batches).
  Plan for a weekly average under about 4 messages/s (about 400 events/s in 100-event batches) to
  keep headroom for other Redis keys; bursts above that are fine as long as the 7 day average stays
  under it. Read usage in the release directory on the host:

  ```sh
  node compose.mjs --configfile .env -- -f compose.yml -f compose.preview.yml \
    exec -T redis sh -c 'REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli info memory | grep -E "^(used_memory|maxmemory):"; REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli dbsize'
  ```

  used_memory and maxmemory are in bytes; dbsize is the key count, almost all of it budget claims.
  The monitor's `Healthy` metric also goes to 0 when Redis used_memory reaches 80 percent of
  maxmemory, so `ServiceHealthAlarm` fires before Redis is full (verified against a live container).
  On 1.2.0 a full Redis sends batches to the dead-letter queue within minutes; from 1.2.1 they wait
  in the main queue. See [Redis full](#redis-full).
- Not measured: EBS performance limits, runs longer than the 15h35m AWS soak, a 72 hour soak, many
  concurrent sources, and dashboard queries during load.

## Redis full

From 1.2.1, the consumer pauses consumption while the budget store (Redis) rejects
writes. Ingest continues returning 202 (its rate limiter fails open) and liveness and deep health
remain 200, so batches accumulate in the main queue, which keeps them up to its 4 day retention.
The consumer logs `Budget store rejects writes; consumption paused` (warn) when pausing and
`Budget store accepts writes; consumption resumed` (info) when resuming. `ServiceHealthAlarm` at
80 percent of maxmemory stays the early warning; queue age rises, so `QueueAgeAlarm` may also fire.
On 1.2.0, the consumer does not pause and batches reach the dead-letter queue within minutes
(`DeadLetterAlarm` fires). Do not delete claims, because the dead-letter queue keeps messages
14 days and a redrive resets their age, so deleting a claim can charge usage twice. Recovery frees
memory only by raising the limit. Deep health does not check Redis and the host monitor is the Redis
signal, because the ALB target group uses unauthenticated liveness and the host monitor reads Redis
memory directly, reporting unhealthy at 80 percent earlier than an out-of-memory check would.

Recovery steps:

1. Pause maintenance (Redis must not be recreated during a backup or other maintenance task), on
   the host:

   ```sh
   systemctl stop framedash-backup.timer
   systemctl show -p ActiveState --value framedash-backup.service
   ```

   ActiveState must print `inactive` or `failed` (a oneshot shows `activating` while running).

2. Raise the limit: edit the redis service in `compose.yml` to `--maxmemory 2gb` and
   `mem_limit: 4g`. Keep `mem_limit` at about twice maxmemory, because Redis forks for AOF rewrite;
   the m7i.xlarge (16 GiB) has room. An upgrade does not carry this edit over; see
   [Upgrades](#upgrades). Then recreate Redis under the maintenance lock:

   ```sh
   node maintenance.mjs run -- node compose.mjs --configfile .env -- -f compose.yml -f compose.preview.yml up -d redis
   ```

   If it reports the lock is held, wait for that task to finish and rerun. Check that used_memory is
   well under 80 percent of the new maxmemory before redriving:

   ```sh
   node compose.mjs --configfile .env -- -f compose.yml -f compose.preview.yml \
     exec -T redis sh -c 'REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli info memory | grep -E "^(used_memory|maxmemory):"; REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli dbsize'
   ```

3. The consumer resumes on its own (probes run every 15 s; a pause that begins after a batch lasts
   at least 30 s; a pause found at startup has no minimum and resumes at the next successful probe)
   and drains the main queue. Check the consumer logs for "Budget store accepts writes; consumption
   resumed" and watch the main queue drain:

   ```sh
   node compose.mjs --configfile .env -- -f compose.yml -f compose.preview.yml logs consumer
   aws sqs get-queue-attributes --queue-url YOUR_QUEUE_URL \
     --attribute-names ApproximateNumberOfMessages ApproximateNumberOfMessagesNotVisible
   ```

4. DLQ redrive from the operator workstation with AWS credentials (the stack outputs give queue URLs,
   not ARNs), only for messages that dead-lettered on 1.2.0 or for other DLQ causes; skip it when
   the DLQ is empty:

   ```sh
   aws sqs get-queue-attributes --queue-url YOUR_DLQ_URL --attribute-names QueueArn \
     --query Attributes.QueueArn --output text
   aws sqs get-queue-attributes --queue-url YOUR_QUEUE_URL --attribute-names QueueArn \
     --query Attributes.QueueArn --output text
   aws sqs start-message-move-task --source-arn DLQ_ARN --destination-arn QUEUE_ARN
   ```

5. Confirm completion: the main queue drains to 0 visible and 0 not visible; if a redrive ran, the
   move task is COMPLETED and the DLQ shows 0 for ApproximateNumberOfMessages and
   ApproximateNumberOfMessagesNotVisible; consumer logs show no new OOM errors; the event count has
   risen; and after the maintenance lock is released, the host monitor reports `MaintenanceActive` 0
   and `Healthy` returns to 1 (`ServiceHealthAlarm` back to OK), because while the lock is held
   `Healthy` is held at 1:

   ```sh
   aws sqs get-queue-attributes --queue-url YOUR_QUEUE_URL \
     --attribute-names ApproximateNumberOfMessages ApproximateNumberOfMessagesNotVisible
   aws sqs get-queue-attributes --queue-url YOUR_DLQ_URL \
     --attribute-names ApproximateNumberOfMessages ApproximateNumberOfMessagesNotVisible
   ```

   If a redrive ran:

   ```sh
   aws sqs list-message-move-tasks --source-arn DLQ_ARN
   ```

6. Only then restart the backup timer:

   ```sh
   systemctl start framedash-backup.timer
   ```

On 1.2.0, redrive was verified locally on LocalStack only, not on AWS: in a local probe with Redis
forced full, all 119 batches (11,900 events) reached the dead-letter queue within about 5 minutes
(5 receives), and after memory was freed an SQS redrive delivered them with events, both daily views,
and Redis usage matching exactly (11,900 inserted). Consumer pause in 1.2.1 was validated locally on
a test image (Docker and LocalStack, not on AWS): with Redis forced full and 100 events/s for 2
minutes, all 119 batches stayed available in the main queue for 13 minutes and none reached the
dead-letter queue, and after maxmemory was restored the consumer resumed about 21 s later and
inserted all 11,900 events with raw events, both daily views, and Redis usage matching exactly.

Until the dead-letter queue is empty, nightly backups are incomplete; see
[Nightly backup](#nightly-backup).

### Stopping ingest while Redis is full

By default ingest keeps accepting events and the main queue holds each batch for 4 days from when
it was sent. The switch below stops new intake only: batches already in the queue still expire 4
days after they were sent, so recover and drain the queue before the oldest one does. If recovery
may take long, or you prefer senders to keep new events, set `INGEST_MAINTENANCE_MODE=true` in
`.env` and recreate ingest under the maintenance lock:

```sh
node maintenance.mjs run -- node compose.mjs --configfile .env -- -f compose.yml -f compose.preview.yml up -d ingest
```

Confirm the switch on the host with the test POST, which needs no API key:

```sh
curl -sS -i -X POST --data '' http://localhost:8088/v1/events
```

When active, it returns 503 with `Retry-After: 60` before validation, authentication, body reads,
or queue writes. All three SDKs (UE5, Unity, Godot) retry 5xx and 429 and keep events locally
within their offline limits, so a long stop can still lose events on devices. The ALB 5XX alarm
(`HTTPCode_Target_5XX_Count`) may fire under sustained traffic while the switch is on; with low
traffic it may not. Confirm the switch with the POST, not the alarm.

To resume: delete the line from `.env` (a shell export does not keep it on, as `compose.mjs`
ignores values in the shell), recreate ingest with the same command, and confirm the POST returns
401 instead of 503. The setting carries over an upgrade because `upgrade.mjs` copies `.env`; turn
it off before upgrading unless intended.

## Using the CLI and MCP with this host

Always set the base URL: `FRAMEDASH_BASE_URL` or, for the CLI, `--base-url`. If omitted, both target
the hosted service at https://app.framedash.dev, and an API key from this host is sent there. The
MCP server takes only the environment variable. Non-loopback CLI origins require HTTPS, so use
`https://YOUR_HOSTNAME` through the ALB. Key scopes: create keys on the project API Keys page of
this host; the generated SDK ingest key does not grant analytics access; `analytics:read` for read
and aggregate commands and tools; the raw MCP `query` tool also requires `data:admin`. Tested
versions: CLI 0.2.0 and MCP 0.1.5. Example:

```sh
export FRAMEDASH_BASE_URL=https://YOUR_HOSTNAME
framedash auth --api-key-file YOUR_KEY_FILE
```

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

Repeated on AWS on 1.2.0 final candidate images: SMTP delivery through SES with DKIM to an inbox,
password reset, TLS through ACM and an internal ALB, and host stop and start (about 48 s, data
identical). From the v1.0.0 candidate, not repeated for this release: sign-in in a real browser and
HTTP 200 from all 17 dashboard pages (page-by-page browser rendering was not reviewed), persistence
across an auto-stop and start (start recovered in about 90 seconds, the public IP changed, the
target was healthy, and data, UUID and password hash were identical), and the internet-facing ALB.

The application does not erase S3 versions; only the optional noncurrent-version expiry or an
operator does. Mailpit was used for email tests on the local loopback route only. The included HTTPS
Caddy configuration is a deployment reference only; the loopback and ALB routes are the tested
routes. The template's restricted inbound CIDR does not support public HTTP ACME validation
without a separately reviewed certificate setup.

AWS rehearsal on 1.2.0 final candidate images verified stack creation in 5m37s, health, deep and cron
endpoints returning 200 from a VPC client host, preflight wrong-AZ rejection, ingest and account
smokes through the ALB, client IP logging against spoofed headers, S3 map lifecycle operations,
real password reset, CLI 0.2.0 and MCP 0.1.5 (12 tools, query counting 2,900 events), metrics in
the Framedash/SelfHosted namespace, 11 alarms, and SNS notifications. Tested on an earlier 1.2.0
candidate: missing data disk recovery (all services running, health 200 within 50 s of reattach),
alarms, backup failure modes, and a cross-stack restore drill with small data (restore command took
32 s, full service in 6m41s after the second stack completed). Online disk expansion from 80 to
100 GiB succeeded in 31 s under 1,000 events/s without errors or container restarts.

The AWS soak ran for 15h35m at 200 events/s through the internal ALB (stopped early by cost
decision instead of the planned 72 hours), accepting all 112,189 batches of 100 with zero failures
and p99 latency of 56 ms; after drain, raw events, both materialized views (`daily_org_ingestion`
and `daily_events_count_mv`), and Redis usage each increased by exactly 11,218,900 with no alarms,
no unplanned container restarts, and ClickHouse memory stable. The nightly backup during the soak
took 3m33s (clients observed 502 for 3m16s, retrying 1,073 times with no loss and no alarm), and
the final backup took 3m06s (762 MB encrypted, 14.18 million events). A final restore drill into a
separate second stack completed stack creation in 5m12s, restored in 43 s, and reached full service
in 7m17s after stack completion, with staged reopen and exact count matching verified.

Redis capacity was revised after the AWS rehearsal: release review identified that 7-day budget
claims (about 282 bytes per claim, one claim per batch) would fill the previous `192mb` limit in
about 4 days at 200 events/s. Redis was changed in installer files to `--maxmemory 1gb` and
`mem_limit 2g` under `noeviction`, and the monitor now reports unhealthy at 80 percent of maxmemory.
In a local 1.2.0 Redis-full probe, ingest continued returning 202 while batches failed to the
dead-letter queue (from 1.2.1 batches wait in the main queue instead; see [Redis full](#redis-full));
after freeing memory, SQS redrive delivered all 11,900 events with exact count matching.
The change was validated locally after the AWS rehearsal and was not re-rehearsed on AWS.

Items not verified: enterprise SSO, browser visual check of pages, HostSystemStatusAlarm recover and
HostInstanceStatusAlarm reboot (configured but not exercised), attestation of unpublished candidate
images, upgrades on AWS, multi-AZ or high availability, replay from old queues into a restored
installation, DLQ redrive on AWS (verified locally on LocalStack only), many concurrent sources,
dashboard queries under load, EBS performance limits, a 72 hour soak (the AWS soak ran 15h35m), and
more than one nightly backup on AWS.
