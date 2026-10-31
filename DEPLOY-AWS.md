# AWS and configuration

See [README.md](README.md) for release requirements, download verification, and the
[install sequence](README.md#install-sequence).

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
plugin against a SHA-256 pinned in the template.

**During initial stack creation:** Connect and complete
[Initial data-volume preparation](#initial-data-volume-preparation) while the stack is
`CREATE_IN_PROGRESS`; do not wait for `CREATE_COMPLETE` before connecting. Stack creation waits up
to 45 minutes for the host's completion signal. Bootstrap never formats a disk: after finding the
exact data volume, it waits up to 20 minutes for an operator-created ext4 filesystem. An existing
ext4 volume proceeds without formatting.

**Existing hosts:** Docker requires the data filesystem mounted at `/srv/framedash` with its
recorded UUID, including after a reboot. On hosts created from this template, a missing data disk
does not block boot (`nofail`), so Session Manager remains available for recovery while Docker
refuses to start. A stack update does not rerun user data: a host created from an earlier template
keeps its blocking entry until an operator adds `nofail` to the options of its `/srv/framedash` line
in `/etc/fstab` and confirms `findmnt --verify` succeeds.

**S3 version retention:** The retained S3 bucket keeps its policy denying insecure transport. By
default it keeps replaced and deleted object versions indefinitely. Setting
`NoncurrentVersionRetentionDays` above zero expires them after that many days; on an existing bucket
this immediately makes older versions eligible for permanent deletion, so back up or inventory any
versions you need first.

**Validation:** A new AWS host from this template booted, mounted its data volume and recovered
from a stop and start in the rehearsal; booting with a missing data disk passed static and shell
tests only.

The template needs `CAPABILITY_IAM`. Create a parameters file named `stack-params.json`:

```json
[
  {
    "ParameterKey": "ExpectedAccountId",
    "ParameterValue": "YOUR_12_DIGIT_ACCOUNT_ID"
  },
  {
    "ParameterKey": "VpcId",
    "ParameterValue": "YOUR_VPC_ID"
  },
  {
    "ParameterKey": "PublicSubnetId",
    "ParameterValue": "YOUR_PUBLIC_SUBNET_ID"
  },
  {
    "ParameterKey": "AvailabilityZone",
    "ParameterValue": "YOUR_AVAILABILITY_ZONE"
  },
  {
    "ParameterKey": "AllowedClientCidr",
    "ParameterValue": "YOUR_ALLOWED_CLIENT_CIDR"
  },
  {
    "ParameterKey": "InstanceType",
    "ParameterValue": "YOUR_INSTANCE_TYPE"
  },
  {
    "ParameterKey": "DataVolumeSize",
    "ParameterValue": "YOUR_DATA_VOLUME_SIZE"
  },
  {
    "ParameterKey": "AutoStopHours",
    "ParameterValue": "YOUR_AUTO_STOP_HOURS"
  },
  {
    "ParameterKey": "EnablePublicHttps",
    "ParameterValue": "YOUR_ENABLE_PUBLIC_HTTPS"
  },
  {
    "ParameterKey": "EnableAlb",
    "ParameterValue": "YOUR_ENABLE_ALB"
  },
  {
    "ParameterKey": "AlbScheme",
    "ParameterValue": "YOUR_ALB_SCHEME"
  },
  {
    "ParameterKey": "AlbCertificateArn",
    "ParameterValue": "YOUR_ALB_CERTIFICATE_ARN"
  },
  {
    "ParameterKey": "AlbSecondSubnetId",
    "ParameterValue": "YOUR_ALB_SECOND_SUBNET_ID"
  }
]
```

Run this command from the extracted installer directory, because the template path is relative.
It creates the stack only when the signed-in account matches `ExpectedAccountId`:

```sh
EXPECTED_ACCOUNT_ID=YOUR_12_DIGIT_ACCOUNT_ID
test "$(aws sts get-caller-identity --query Account --output text)" = "$EXPECTED_ACCOUNT_ID" && \
aws cloudformation create-stack --region YOUR_AWS_REGION --stack-name YOUR_STACK_NAME \
  --template-body file://aws/cloudformation.json --parameters file://stack-params.json \
  --capabilities CAPABILITY_IAM
```

For an internet-facing ALB, both subnets must be public subnets; this is an AWS requirement.
The rehearsal used t3.xlarge.

## Initial data-volume preparation

`create-stack` returns before the resources exist. Using the stack ARN it printed, wait until the
instance exists and is online in Session Manager. Do not wait for `CREATE_COMPLETE`, which depends
on the volume preparation below. Continue only when the last line shows `CREATE_IN_PROGRESS` and
`Online`. The loop gives up after about 15 minutes; on any other result, stop and investigate:

```sh
AWS_REGION=YOUR_AWS_REGION
STACK_ID=YOUR_NEW_STACK_ARN
INSTANCE_ID=None
PING=None
for attempt in $(seq 1 60); do
  STATUS=$(aws cloudformation describe-stacks --region "$AWS_REGION" --stack-name "$STACK_ID" \
    --query 'Stacks[0].StackStatus' --output text) || break
  [ "$STATUS" = CREATE_IN_PROGRESS ] || break
  INSTANCE_ID=$(aws cloudformation list-stack-resources --region "$AWS_REGION" \
    --stack-name "$STACK_ID" \
    --query "StackResourceSummaries[?LogicalResourceId=='Instance'] | [0].PhysicalResourceId" \
    --output text) || break
  if [ "$INSTANCE_ID" != None ]; then
    PING=$(aws ssm describe-instance-information --region "$AWS_REGION" \
      --filters "Key=InstanceIds,Values=$INSTANCE_ID" \
      --query 'InstanceInformationList[0].PingStatus' --output text) || break
    [ "$PING" = Online ] && break
  fi
  sleep 15
done
echo "status=$STATUS instance=$INSTANCE_ID ping=$PING"
```

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

Proceed only during this initial stack creation, after confirming all of the following:

- The stack ARN matches the intended account and Region.
- Both resource tags and the volume attachment match the recorded instance.
- The volume was newly created for this operation, has no snapshot source, has never held an
  installation, and contains no data to preserve.

An empty filesystem probe alone cannot prove the volume's history. Stop on an update or
replacement, a reused volume, unknown history, or any mismatch. Preserve and investigate the disk
instead.

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
the [install sequence](README.md#install-sequence). If the window expires, inspect the failed
stack and retained resources; do not format a volume to repair an unknown installation. See
[AWS's volume preparation guidance](https://docs.aws.amazon.com/ebs/latest/userguide/ebs-using-volumes.html).

A failed creation signal makes CloudFormation roll back, and the instance's termination
protection stops that rollback from deleting it: the stack reaches `ROLLBACK_FAILED` and the
host keeps running. From the account-verified workstation, record the stack and instance as
above, disable protection only on that recorded instance with the `modify-instance-attribute`
command under ["AWS replacement and disposal"](OPERATIONS.md#aws-replacement-and-disposal),
then run `delete-stack` for the recorded stack. The data volume is snapshotted and the bucket
and queues are retained [as described there](OPERATIONS.md#aws-replacement-and-disposal).

## Runtime configuration

The host auto-stops eight hours after each boot by default. This is a runtime bound rather than
a spending limit. `AutoStopHours` configures the timer only during initial host bootstrap.
Changing it on an existing stack does not update the installed timer: EC2 user data is not
automatically rerun after an update or stop/start. Keep its original value during stack updates.
Changing an existing host's runtime limit requires separately reviewed privileged timer maintenance;
that workflow is not supported or tested by this release. Inspect the installed unit with
`systemctl cat framedash-autostop.timer` and its next deadline with
`systemctl list-timers --all framedash-autostop.timer` before relying on a runtime limit. See
[EC2 user-data execution](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/user-data.html).
EBS, retained buckets/queues and snapshots can still incur charges after a stop
or stack deletion. The template deliberately retains data resources; inspect its retention policies
and separately remove exact resources when ending a disposable trial.

The default consumer polls only the main queue. Messages that exhaust its configured retries
remain in the DLQ for operator diagnosis, subject to the template's 14-day SQS retention expiry.
Monitor that queue and arrange any required preservation before expiry. Budget claims may remain
held for failed messages. This release does not provide or validate an automatic replay workflow.

After diagnosing failures and reviewing the exact DLQ configured in `.env`, an authorized operator
can explicitly discard its visible messages from the privileged installer shell. ALB installations
replace `-f compose.preview.yml` with `-f compose.alb.yml`:

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

See the [install sequence](README.md#install-sequence) for the configuration and startup commands.

The preview override exposes HTTP only on host loopback `127.0.0.1:8088` and Mailpit on
`127.0.0.1:8025`. Access the dashboard at `http://localhost:8088` directly on the host or through
an authorized SSM port-forwarding session. Port forwarding requires the local Session Manager
plugin. The default security group exposes no public dashboard port. Database and Redis ports
remain private to Docker. The reserved proxy IP and Compose subnet must not overlap other networks.

Bootstrap creates one verified administrator, workspace and project only on an empty instance.
It refuses to modify an existing installation. Terms acceptance remains in the administrator's
sign-in flow. Sign in using `ADMIN_EMAIL` and `ADMIN_PASSWORD` from your private configuration;
the generator does not print the password. After the first sign-in, sign out, then set a new password
through the sign-in page's password-reset flow; the generated value stays in the configuration file,
which Compose still reads, and stops granting access. Bootstrap prints the new project ID.
The generated `SDK_API_KEY` is restricted to event ingestion. Point the SDK at your instance's `/v1/events`
endpoint and use that project ID and key through your approved secret mechanism.

For the separately published Framedash CLI, select this instance explicitly with
`--base-url http://localhost:8088` or `FRAMEDASH_BASE_URL`. Interactive `framedash login`
uses the selected origin. For automation, create a key with the required read/analytics scopes
on this instance's project API Keys page and supply it using `--api-key-file`; the generated
SDK ingest key does not grant analytics access. Non-loopback CLI origins require HTTPS.
`framedash map-capture` honors `FRAMEDASH_BASE_URL` from CLI 0.2.0, which requires Node.js 22 or
later; with an older CLI pass `--base-url`.

Optional `configure.mjs` flags `--raw-retention-days` and `--monthly-event-limit` set raw retention
and a monthly event cap; see [PARITY.md](PARITY.md#entitlements) for details.

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

The shipped installer disables external web telemetry. Browser Sentry is disabled at build time
and cannot be enabled through runtime configuration. The internal runtime
`SELF_HOSTED_TELEMETRY_ENABLED` flag controls server/edge Sentry and optional dashboard collectors;
changing it does not change the compiled browser Sentry or build-plugin settings. Custom telemetry
opt-in is not a supported path for this release. Keep the shipped disabled settings.

## HTTPS through an Application Load Balancer

This mode passed a rehearsal on real AWS, using a v1.0.0 candidate build with an ACM certificate
and an internet-facing ALB restricted to one CIDR; the `internal` scheme has not been deployed on
AWS.

Prerequisites are an ACM certificate ARN in the stack Region, a second subnet of the VPC in a
different Availability Zone (alongside `PublicSubnetId`), the office or VPN CIDR, and a real SMTP
service (Mailpit is omitted; the first administrator password change uses the email reset flow).
With Amazon SES, verify a domain identity with DKIM for the sender domain and send from that domain.
A single-address identity is not enough if the domain publishes DMARC p=reject: receivers such as
Google reject the mail and only a bounce comes back. A subdomain identity works. The SES sandbox
only delivers to verified recipients.

Set `EnableAlb=true`, `AlbScheme` (`internal` or `internet-facing`, defaulting to `internal`),
`AlbCertificateArn`, `AlbSecondSubnetId`, and `AllowedClientCidr`. Rule `AlbInputs` asserts that
`AlbCertificateArn` and `AlbSecondSubnetId` are non-empty, `EnablePublicHttps=false` (the two modes
are mutually exclusive), and `AllowedClientCidr` is not `127.0.0.1/32`; invalid combinations fail
stack creation. ALB idle timeout is 240 seconds as dashboard queries may retry up to 180 seconds.

The `internal` scheme requires an existing VPN or private route from every client device,
including devkits and phones. The `internet-facing` scheme still admits only `AllowedClientCidr`,
refusing devices on mobile-carrier or home networks; devices must use office egress or VPN either
way.

Look up the IPv4 CIDRs for the two subnet IDs in the `TrustedProxySubnets` output:

```sh
aws ec2 describe-subnets --region YOUR_AWS_REGION --subnet-ids SUBNET_ID_1 SUBNET_ID_2 \
  --query 'Subnets[].CidrBlock' --output text
```

Generate `.env` with `--trusted-proxy-cidrs` using the standard non-test configuration path.
`--smtp-url` for Amazon SES takes the form
`smtps://SMTP_USERNAME:SMTP_PASSWORD@email-smtp.YOUR_AWS_REGION.amazonaws.com:465`, and the username
and password must be percent-encoded, because SES SMTP passwords can contain reserved characters.
SES SMTP credentials are not the IAM access key secret; they are derived from it or created in the
SES console. SMTP credentials passed as arguments can enter shell history, so use a credential-free
temporary URL during generation, then edit `SMTP_URL` in the private configuration file:

```sh
node configure.mjs --region YOUR_AWS_REGION --domain YOUR_HOSTNAME \
  --queue-url YOUR_QUEUE_URL --dlq-url YOUR_DLQ_URL --bucket YOUR_PRIVATE_BUCKET \
  --smtp-url YOUR_SMTP_URL --email-from YOUR_SENDER --admin-email YOUR_ADMIN_EMAIL \
  --trusted-proxy-cidrs ALB_SUBNET_CIDR_1,ALB_SUBNET_CIDR_2 --output .env
```

Validate, launch and bootstrap using `compose.yml` and `compose.alb.yml` without preview overrides:

```sh
node compose.mjs --configfile .env -- -f compose.yml -f compose.alb.yml config --quiet
node compose.mjs --configfile .env -- -f compose.yml -f compose.alb.yml up -d --no-build
node compose.mjs --configfile .env -- -f compose.yml -f compose.alb.yml run --rm bootstrap
```

Create a CNAME or alias record from the hostname to the `LoadBalancerDnsName` output. There is no
HTTP listener and no HTTP-to-HTTPS redirect.

Point the SDK at `https://<host>/v1/events`.

In ALB mode, `compose.alb.yml` maps port 8088 on the host, restricted to the ALB security group.
When the peer address is inside `TRUSTED_PROXY_CIDRS`, Caddy takes exactly the last
`X-Forwarded-For` entry (appended by the ALB) as client address; otherwise it uses the peer
address. It overwrites `X-Forwarded-For` and `X-Real-IP`, sets `X-Forwarded-Host` to the host, sets
`X-Forwarded-Proto https`, and strips `CF-Connecting-IP`. A local container probe confirmed spoofed
headers are replaced, and on real AWS the client IP recorded in the audit log was the real client
even with spoofed headers. If `TRUSTED_PROXY_CIDRS` omits an ALB subnet, requests through that
subnet record the ALB node address instead of the client; never add client ranges to it.

An ACM-issued, DNS-validated certificate renews automatically; imported certificates do not.

ALB hourly charges continue while the EC2 host is auto-stopped. The host auto-stops after
`AutoStopHours` (default 8, up to 24); someone must start it each working day.
