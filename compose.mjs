import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

const publicSettingKeys = new Set([
	"DOMAIN",
	"APP_URL",
	"AWS_REGION",
	"SQS_QUEUE_URL",
	"SQS_DLQ_URL",
	"S3_BUCKET_NAME",
	"DATA_DIR",
	"EMAIL_FROM",
	"S3_ENDPOINT",
	"SQS_ENDPOINT",
	"S3_FORCE_PATH_STYLE",
	"ADMIN_NAME",
	"WORKSPACE_NAME",
	"WORKSPACE_SLUG",
	"PROJECT_NAME",
	"SDK_API_KEY_NAME",
]);
// Shell values for these keys still reach Docker when the file omits them.
const secretKeys = new Set([
	"POSTGRES_PASSWORD",
	"CLICKHOUSE_PASSWORD",
	"CLICKHOUSE_READONLY_PASSWORD",
	"REDIS_PASSWORD",
	"REDIS_REST_TOKEN",
	"AUTH_SECRET",
	"CRON_SECRET",
	"AUDIT_LOG_HASH_SECRET",
	"ERASURE_SUPPRESSION_HASH_SECRET",
	"PLAYER_ERASURE_ENCRYPTION_KEY",
	"ADMIN_PASSWORD",
	"SDK_API_KEY",
	"SMTP_URL",
	"ADMIN_EMAIL",
	"AWS_ACCESS_KEY_ID",
	"AWS_SECRET_ACCESS_KEY",
	"AWS_SESSION_TOKEN",
	"SELF_HOSTED_PRIVACY_CONTACT",
]);

function decoded(value) {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}

export function redactionValues(settings, environment) {
	const values = new Set();
	const addCredentials = (value) => {
		if (typeof value !== "string" || !URL.canParse(value)) return;
		const { username, password } = new URL(value);
		for (const part of [username, password, password && `${username}:${password}`]) {
			if (!part) continue;
			values.add(part);
			values.add(decoded(part));
		}
	};
	const add = (value) => {
		if (typeof value !== "string" || !value) return;
		values.add(value);
		addCredentials(value);
	};
	for (const [key, value] of Object.entries(settings))
		if (publicSettingKeys.has(key.toUpperCase())) addCredentials(value);
		else add(value);
	for (const [key, value] of Object.entries(environment))
		if (secretKeys.has(key.toUpperCase())) add(value);
	// The redactor matches one stderr line at a time, so a multi-line value is matched per line.
	return [...values]
		.flatMap((value) => value.split(/[\r\n]+/))
		.filter(Boolean)
		.sort((left, right) => right.length - left.length);
}

const unterminatedLimit = 8192;

export function stderrRedactor(values) {
	const pattern = values.length
		? new RegExp(values.map((value) => value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")).join("|"), "g")
		: undefined;
	const redact = (text) => (pattern ? text.replace(pattern, "[REDACTED]") : text);
	const overlap = Math.max(0, ...values.map((value) => value.length - 1));
	let pending = "";
	const flushableEnd = () => {
		const lines = Math.max(pending.lastIndexOf("\n"), pending.lastIndexOf("\r")) + 1;
		if (pending.length - lines <= unterminatedLimit) return lines;
		// Keep enough tail to finish a partially received secret, and never cut through a match.
		let end = pending.length - overlap;
		if (pattern)
			for (const match of pending.matchAll(pattern))
				if (match.index < end && match.index + match[0].length > end) end = match.index;
		return Math.max(lines, end);
	};
	return {
		write(chunk) {
			pending += chunk;
			const end = flushableEnd();
			const complete = pending.slice(0, end);
			pending = pending.slice(end);
			return redact(complete);
		},
		end() {
			const rest = pending;
			pending = "";
			return redact(rest);
		},
	};
}

export function composeInvocation(configfile, forwarded, shellEnvironment, settings) {
	if (!configfile || !forwarded.length)
		throw new Error("Provide a configuration file and Compose arguments");
	if (
		forwarded.some((value) => value === "config" || value === "convert") &&
		!forwarded.some((value) => value === "--quiet" || value === "-q")
	) {
		throw new Error("Compose configuration output requires --quiet");
	}
	if (
		forwarded.some((value) => value === "config" || value === "convert") &&
		forwarded.some(
			(value) => /^--(environment|variables|output|format)(=|$)/.test(value) || value === "-o",
		)
	) {
		throw new Error("Compose configuration rendering flags are not allowed");
	}
	const environment = { ...shellEnvironment };
	// Omitted file settings must not inherit shell credentials, endpoints, or privacy recipients.
	const fileOwnedOptionals = new Set([
		"AWS_ACCESS_KEY_ID",
		"AWS_SECRET_ACCESS_KEY",
		"AWS_SESSION_TOKEN",
		"S3_ENDPOINT",
		"S3_FORCE_PATH_STYLE",
		"SQS_ENDPOINT",
		"SELF_HOSTED_PRIVACY_CONTACT",
	]);
	for (const key of Object.keys(environment)) {
		if (fileOwnedOptionals.has(key.toUpperCase())) delete environment[key];
	}
	return {
		arguments: ["compose", "--env-file", resolve(configfile), ...forwarded],
		environment: { ...environment, ...settings },
	};
}

async function main() {
	const input = process.argv.slice(2);
	if (input[0] !== "--configfile" || !input[1] || input[2] !== "--") {
		throw new Error("Use --configfile PATH -- COMPOSE_ARGUMENTS");
	}
	const settings = parseEnv(await readFile(input[1], "utf8"));
	const invocation = composeInvocation(input[1], input.slice(3), process.env, settings);
	const child = spawn("docker", invocation.arguments, {
		env: invocation.environment,
		stdio: ["inherit", "inherit", "pipe"],
	});
	const redactor = stderrRedactor(redactionValues(settings, invocation.environment));
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk) => process.stderr.write(redactor.write(chunk)));
	const [code, signal] = await once(child, "close");
	process.stderr.write(redactor.end());
	if (code !== 0 || signal) {
		console.error("Compose failed; configured secret values are redacted from its diagnostics.");
		process.exitCode = code || 1;
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main().catch(() => {
		console.error("Compose invocation failed; check the configuration and arguments privately.");
		process.exitCode = 1;
	});
}
