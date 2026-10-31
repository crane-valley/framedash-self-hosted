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
cron is fresh and 503 otherwise.

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
a 0.1.0-preview release, so install 1.0.0 fresh and move data only by your own reviewed process.
Each later release states in its notes which versions it was tested to upgrade from, and any other
path is unsupported. A downgrade is never supported, because replacing images does not roll back
a migrated schema; back up first and test against a restored copy. Check the new release's archive
SHA-256 and image IDs, then use its Compose file and image version.

This release ships no backup command or scheduled backup. Before storing data you need to keep,
define and test a backup and restoration procedure. An automated restore check exists only in the
private test suite.

Before replacing a host or image version:

1. Stop writes and take a consistent backup of PostgreSQL, ClickHouse, Redis, and the private
   configuration to encrypted off-host storage.
2. Record the image version and migration state.
3. Test restoration into a separate empty installation before depending on the backup.

The data directory alone does not back up S3 objects or queue messages. Account for S3 versions,
queued events, and permanent player erasure when defining your recovery process.

## AWS replacement and disposal

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

Local restoration was tested for PostgreSQL, ClickHouse and Redis only. The application does not
erase S3 versions; only the optional noncurrent-version expiry or an operator does. Mailpit was used
for email tests on the local loopback route only. Verified on real AWS: real SMTP delivery through
SES with DKIM to an inbox; custom-domain DNS/TLS through ALB and ACM; persistence across an
auto-stop and start (start recovered in about 90 seconds, the public IP changed, the target was
healthy, and data, UUID and password hash were identical); sign-in in a real browser and HTTP 200
from all 17 dashboard pages (page-by-page browser rendering was not reviewed). Still unverified:
enterprise SSO, sustained load and long-duration operation, AWS disaster recovery, queue replay,
durable erasure replay, the internal ALB scheme on AWS, in-place upgrades. The included HTTPS Caddy
configuration is a deployment reference only; the loopback and ALB routes are the tested routes. In
particular, the optional AWS template's restricted inbound CIDR does not support public HTTP ACME
validation without a separately reviewed certificate setup.
