import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeBootstrapAdminEmail, resolveBootstrapNames } from "./bootstrap.mjs";
import { configSecretBytes } from "./config-secrets.mjs";

const options = new Map();
for (let i = 2; i < process.argv.length; i++) {
	const name = process.argv[i];
	if (name === "--local" || name === "--aws-test") options.set(name, "true");
	else if (name.startsWith("--") && process.argv[i + 1]) options.set(name, process.argv[++i]);
	else throw new Error(`Invalid option: ${name}`);
}
const local = options.has("--local");
const awsTest = options.has("--aws-test");
if (local && awsTest) throw new Error("Choose one test environment");
const test = local || awsTest;
const required = (name, fallback) => {
	const value = options.get(`--${name}`) ?? fallback;
	if (!value || /['\r\n]/.test(value))
		throw new Error(`Provide --${name} without quotes or newlines`);
	return value;
};
const region = required("region", local ? "us-east-1" : undefined);
const domain = required("domain", test ? "localhost:8088" : undefined);
if (!test && !/^[a-zA-Z0-9.-]+$/.test(domain)) throw new Error("--domain must be a DNS name");
const here = dirname(fileURLToPath(import.meta.url));
const dataDirOption = required("data-dir", local ? resolve(here, ".data") : "/srv/framedash/data");
const dataDir =
	!local && posix.isAbsolute(dataDirOption)
		? posix.normalize(dataDirOption)
		: resolve(dataDirOption);
const seed = process.env.FRAMEDASH_CONFIG_SEED;
const secret = (label, size = 32, encoding = "hex") =>
	configSecretBytes(seed, label, size).toString(encoding);
const bootstrapNames = resolveBootstrapNames({
	ADMIN_NAME: options.get("--admin-name"),
	WORKSPACE_NAME: options.get("--workspace-name"),
	WORKSPACE_SLUG: options.get("--workspace-slug"),
	PROJECT_NAME: options.get("--project-name"),
	SDK_API_KEY_NAME: options.get("--sdk-api-key-name"),
});
for (const value of Object.values(bootstrapNames)) {
	if (value.includes("'")) throw new Error("Bootstrap configuration names must not contain quotes");
}
const clickhouseReadonlyPassword = secret("clickhouse-readonly-password");
const settings = {
	...bootstrapNames,
	DOMAIN: domain,
	APP_URL: `${test ? "http" : "https"}://${domain}`,
	AWS_REGION: region,
	SQS_QUEUE_URL: required(
		"queue-url",
		local ? `http://localstack:4566/queue/${region}/000000000000/framedash-events` : undefined,
	),
	SQS_DLQ_URL: required(
		"dlq-url",
		local ? `http://localstack:4566/queue/${region}/000000000000/framedash-dead-letter` : undefined,
	),
	S3_BUCKET_NAME: required("bucket", local ? "framedash-self-hosted-local" : undefined),
	SMTP_URL: required("smtp-url", test ? "smtp://mailpit:1025" : undefined),
	EMAIL_FROM: required("email-from", test ? "Framedash <noreply@localhost>" : undefined),
	ADMIN_EMAIL: normalizeBootstrapAdminEmail(required("admin-email")),
	ADMIN_PASSWORD: secret("admin-password", 24, "base64url"),
	SDK_API_KEY: `fd_${secret("sdk-api-key", 16)}`,
	DATA_DIR: dataDir.replaceAll("\\", "/"),
	POSTGRES_PASSWORD: secret("postgres-password"),
	CLICKHOUSE_PASSWORD: secret("clickhouse-password"),
	CLICKHOUSE_READONLY_PASSWORD: clickhouseReadonlyPassword,
	CLICKHOUSE_READONLY_PASSWORD_SHA256: createHash("sha256")
		.update(clickhouseReadonlyPassword)
		.digest("hex"),
	REDIS_PASSWORD: secret("redis-password"),
	REDIS_REST_TOKEN: secret("redis-rest-token"),
	AUTH_SECRET: secret("auth-secret"),
	CRON_SECRET: secret("cron-secret"),
	AUDIT_LOG_HASH_SECRET: secret("audit-log-hash-secret"),
	ERASURE_SUPPRESSION_HASH_SECRET: secret("erasure-suppression-hash-secret"),
	PLAYER_ERASURE_ENCRYPTION_KEY: secret("player-erasure-encryption-key", 32, "base64"),
};
if (local) {
	settings.SQS_ENDPOINT = "http://localstack:4566";
	settings.AWS_ACCESS_KEY_ID = secret("localstack-access-key-id", 10);
	settings.AWS_SECRET_ACCESS_KEY = secret("localstack-secret-access-key");
}
const target = resolve(required("output", resolve(here, local ? ".env.local" : ".env")));
mkdirSync(dirname(target), { recursive: true });
writeFileSync(
	target,
	`${Object.entries(settings)
		.map(([key, value]) => `${key}='${value}'`)
		.join("\n")}\n`,
	{ flag: "wx", mode: 0o600 },
);
console.log(
	`Created ${target}. Keep the configuration and privacy encryption keys in encrypted backups.`,
);
