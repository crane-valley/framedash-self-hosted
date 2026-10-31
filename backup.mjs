import { execFile, spawn } from "node:child_process";
import {
	createCipheriv,
	createDecipheriv,
	createHash,
	hkdfSync,
	randomBytes,
	timingSafeEqual,
} from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
	copyFile,
	mkdir,
	readdir,
	readFile,
	rename,
	rm,
	stat,
	statfs,
	writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { PassThrough, Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { parseArgs, parseEnv } from "node:util";
import { composeInvocation, redactionValues, stderrRedactor } from "./compose.mjs";

const formatVersion = 1;
const magic = Buffer.from("FDBKUP01");
const saltBytes = 16;
const chunkBytes = 1024 * 1024;
const frameHeaderBytes = 5;
const tagBytes = 16;
const components = ["config", "postgres", "clickhouse", "redis"];
const stopSeconds = { clickhouse: 120, redis: 60 };
const dataPaths = {
	postgres: "/var/lib/postgresql/data",
	clickhouse: "/var/lib/clickhouse",
	redis: "/data",
};
const imageServices = ["web", "ingest", "consumer", "scheduler", "postgres", "clickhouse", "redis"];
const installationOwnedKeys = new Set([
	"DOMAIN",
	"APP_URL",
	"AWS_REGION",
	"AWS_ACCESS_KEY_ID",
	"AWS_SECRET_ACCESS_KEY",
	"AWS_SESSION_TOKEN",
	"SQS_QUEUE_URL",
	"SQS_DLQ_URL",
	"SQS_ENDPOINT",
	"S3_BUCKET_NAME",
	"S3_ENDPOINT",
	"S3_FORCE_PATH_STYLE",
	"DATA_DIR",
	"EMAIL_FROM",
	"SMTP_URL",
	"TRUSTED_PROXY_CIDRS",
]);
// AWS documents at least a minute before approximate counters settle after producers stop.
const drainSettleMs = 120_000;
const drainPollMs = 10_000;
const drainTimeoutMs = 300_000;

const queueDepthProgram = `
const { createRequire } = require("node:module");
const sqs = createRequire("/app/apps/self-hosted/package.json")("@aws-sdk/client-sqs");
const client = new sqs.SQSClient({
	region: process.env.AWS_REGION,
	...(process.env.SQS_ENDPOINT ? { endpoint: process.env.SQS_ENDPOINT } : {}),
});
const AttributeNames = [
	"ApproximateNumberOfMessages",
	"ApproximateNumberOfMessagesNotVisible",
	"ApproximateNumberOfMessagesDelayed",
];
const depth = async (QueueUrl) => {
	const { Attributes } = await client.send(
		new sqs.GetQueueAttributesCommand({ QueueUrl, AttributeNames }),
	);
	return AttributeNames.reduce((sum, name) => sum + Number(Attributes[name]), 0);
};
(async () => {
	const main = await depth(process.env.SQS_QUEUE_URL);
	const deadLetter = await depth(process.env.SQS_DLQ_URL);
	console.log(JSON.stringify({ main, deadLetter }));
})().catch(() => process.exit(1));
`;

function nonce(counter, last) {
	if (counter > 0xffffffff) throw new Error("Backup component is too large");
	const value = Buffer.alloc(12);
	value.writeUInt32BE(counter, 7);
	value[11] = last ? 1 : 0;
	return value;
}

function fileKey(key, salt, backupId, name) {
	return Buffer.from(
		hkdfSync("sha256", key, salt, `framedash-backup-v${formatVersion}|${backupId}|${name}`, 32),
	);
}

export function encryptStream(key, backupId, name) {
	const salt = randomBytes(saltBytes);
	const derived = fileKey(key, salt, backupId, name);
	let pending = Buffer.alloc(0);
	let counter = 0;
	const seal = (plain, last) => {
		const cipher = createCipheriv("aes-256-gcm", derived, nonce(counter++, last));
		const body = Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
		const header = Buffer.alloc(frameHeaderBytes);
		header[0] = last ? 1 : 0;
		header.writeUInt32BE(body.length, 1);
		return Buffer.concat([header, body]);
	};
	let started = false;
	const start = (stream) => {
		if (!started) stream.push(Buffer.concat([magic, salt]));
		started = true;
	};
	return new Transform({
		transform(chunk, _encoding, done) {
			start(this);
			pending = Buffer.concat([pending, chunk]);
			while (pending.length > chunkBytes) {
				this.push(seal(pending.subarray(0, chunkBytes), false));
				pending = pending.subarray(chunkBytes);
			}
			done();
		},
		flush(done) {
			start(this);
			this.push(seal(pending, true));
			done();
		},
	});
}

export function decryptStream(key, backupId, name) {
	let pending = Buffer.alloc(0);
	let derived;
	let counter = 0;
	let finished = false;
	return new Transform({
		transform(chunk, _encoding, done) {
			pending = Buffer.concat([pending, chunk]);
			try {
				if (!derived) {
					if (pending.length < magic.length + saltBytes) return done();
					if (!timingSafeEqual(pending.subarray(0, magic.length), magic))
						throw new Error("Not a Framedash backup file");
					derived = fileKey(
						key,
						pending.subarray(magic.length, magic.length + saltBytes),
						backupId,
						name,
					);
					pending = pending.subarray(magic.length + saltBytes);
				}
				while (pending.length >= frameHeaderBytes) {
					if (finished) throw new Error("Backup file has data after its final frame");
					const last = pending[0] === 1;
					const size = pending.readUInt32BE(1);
					if (pending[0] > 1 || size < tagBytes || size > chunkBytes + tagBytes)
						throw new Error("Backup file has an invalid frame");
					if (pending.length < frameHeaderBytes + size) break;
					const body = pending.subarray(frameHeaderBytes, frameHeaderBytes + size);
					const decipher = createDecipheriv("aes-256-gcm", derived, nonce(counter++, last));
					decipher.setAuthTag(body.subarray(size - tagBytes));
					this.push(
						Buffer.concat([decipher.update(body.subarray(0, size - tagBytes)), decipher.final()]),
					);
					pending = pending.subarray(frameHeaderBytes + size);
					finished = last;
				}
				done();
			} catch (error) {
				done(error);
			}
		},
		flush(done) {
			done(finished && pending.length === 0 ? undefined : new Error("Backup file is truncated"));
		},
	});
}

function digestTap(onDone) {
	const hash = createHash("sha256");
	let bytes = 0;
	return new Transform({
		transform(chunk, _encoding, done) {
			hash.update(chunk);
			bytes += chunk.length;
			done(null, chunk);
		},
		flush(done) {
			onDone({ bytes, sha256: hash.digest("hex") });
			done();
		},
	});
}

export async function sealFile(directory, key, backupId, name, source) {
	let summary;
	await pipeline(
		source,
		digestTap((value) => {
			summary = value;
		}),
		encryptStream(key, backupId, name),
		createWriteStream(join(directory, `${name}.enc`), { flags: "wx", mode: 0o600 }),
	);
	return summary;
}

function pipeDecrypted(directory, key, backupId, name, ...sinks) {
	return pipeline(
		createReadStream(join(directory, `${name}.enc`)),
		decryptStream(key, backupId, name),
		...sinks,
	);
}

async function readSealed(directory, key, backupId, name) {
	const chunks = [];
	await pipeDecrypted(
		directory,
		key,
		backupId,
		name,
		new Writable({
			write(chunk, _encoding, done) {
				chunks.push(chunk);
				done();
			},
		}),
	);
	return Buffer.concat(chunks);
}

export function backupIdFor(date, random = randomBytes(4).toString("hex")) {
	return `framedash-backup-${date.toISOString().replace(/[-:.]/g, "").slice(0, 15)}Z-${random}`;
}

function backupIdOf(directory) {
	const id = resolve(directory).split(sep).at(-1);
	if (!/^framedash-backup-\d{8}T\d{6}Z-[0-9a-f]{8}$/.test(id))
		throw new Error("Backup path must be an unmodified backup directory");
	return id;
}

export async function verifyBackup(directory, key) {
	const backupId = backupIdOf(directory);
	const manifest = JSON.parse(await readSealed(directory, key, backupId, "manifest"));
	if (manifest.format !== formatVersion || manifest.id !== backupId)
		throw new Error("Backup manifest does not match this backup");
	const expected = [...components, "manifest"].map((name) => `${name}.enc`).sort();
	const present = (await readdir(directory)).sort();
	if (JSON.stringify(present) !== JSON.stringify(expected))
		throw new Error("Backup files do not match the manifest");
	for (const name of components) {
		let summary;
		await pipeDecrypted(
			directory,
			key,
			backupId,
			name,
			digestTap((value) => {
				summary = value;
			}),
			new Writable({
				write(_chunk, _encoding, done) {
					done();
				},
			}),
		);
		const recorded = manifest.components[name];
		if (summary.bytes !== recorded?.bytes || summary.sha256 !== recorded?.sha256)
			throw new Error(`Backup component ${name} does not match the manifest`);
	}
	return manifest;
}

export function mergedConfig(target, backup) {
	const merged = { ...target };
	for (const [key, value] of Object.entries(backup))
		if (!installationOwnedKeys.has(key)) merged[key] = value;
	return merged;
}

export function renderConfig(settings) {
	return `${Object.entries(settings)
		.map(([key, value]) => {
			if (/['\r\n]/.test(value)) throw new Error(`Configuration value ${key} cannot be rewritten`);
			return `${key}='${value}'`;
		})
		.join("\n")}\n`;
}

export function assertSeparateResources(target, backup, sameAwsResources) {
	if (sameAwsResources) return;
	const live = new Set([backup.SQS_QUEUE_URL, backup.SQS_DLQ_URL]);
	const shared = ["SQS_QUEUE_URL", "SQS_DLQ_URL"].find((name) => live.has(target[name]));
	const name = shared ?? (target.S3_BUCKET_NAME === backup.S3_BUCKET_NAME && "S3_BUCKET_NAME");
	if (name)
		throw new Error(
			`Target ${name} belongs to the backed-up installation; a restored consumer or dashboard would act on live resources. Use a separate stack, or --same-aws-resources for a same-stack host replacement`,
		);
}

export function assertSameImages(recorded, current) {
	for (const service of imageServices) {
		if (recorded[service] && recorded[service] !== current[service])
			throw new Error(`Target ${service} image differs from the backup; install the same release`);
	}
}

export function assertInventoryMatches(recorded, current) {
	if (recorded.migrations.postgres !== current.migrations.postgres)
		throw new Error("Restored PostgreSQL migration journal differs from the backup");
	if (recorded.migrations.clickhouse !== current.migrations.clickhouse)
		throw new Error("Restored ClickHouse migration journal differs from the backup");
	for (const store of ["postgres", "clickhouse"]) {
		const names = new Set([...Object.keys(recorded[store]), ...Object.keys(current[store])]);
		for (const name of names) {
			const expected = recorded[store][name];
			const actual = current[store][name];
			if (!expected || !actual)
				throw new Error(`Restored ${store} table set differs from the backup at ${name}`);
			if (expected.exact && expected.rows !== actual.rows)
				throw new Error(`Restored ${store} table ${name} row count differs from the backup`);
		}
	}
}

export function backupComplete(queue) {
	return queue.drained && queue.deadLetter === 0;
}

function isInside(parent, child) {
	const path = relative(resolve(parent), resolve(child));
	return !path || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

export function assertBackupLocations({ dataDir, outputDir, keyFile }) {
	if (isInside(dataDir, outputDir)) throw new Error("Write backups outside DATA_DIR");
	if (isInside(dataDir, keyFile) || isInside(outputDir, keyFile))
		throw new Error("Keep the backup key away from DATA_DIR and the backup output");
}

export function createCompose(configfile, forwarded, settings, baseEnvironment = process.env) {
	const children = new Set();
	let aborted = false;
	const redactedStderr = (child) => {
		const invocationRedactor = stderrRedactor(
			redactionValues(settings, { ...baseEnvironment, ...settings }),
		);
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk) => process.stderr.write(invocationRedactor.write(chunk)));
		child.stderr.on("end", () => process.stderr.write(invocationRedactor.end()));
	};
	const start = (args, stdin) => {
		if (aborted && args[0] !== "start") throw new Error("Interrupted");
		const invocation = composeInvocation(
			configfile,
			[...forwarded, ...args],
			baseEnvironment,
			settings,
		);
		const child = spawn("docker", invocation.arguments, {
			env: invocation.environment,
			stdio: [stdin ? "pipe" : "ignore", "pipe", "pipe"],
		});
		children.add(child);
		redactedStderr(child);
		const exit = new Promise((done, fail) => {
			child.on("error", fail);
			child.on("close", (code, signal) => {
				children.delete(child);
				if (code === 0 && !signal) done();
				else fail(new Error(`Compose ${args[0]} failed`));
			});
		});
		return { child, exit };
	};
	return {
		async text(args) {
			const { child, exit } = start(args, false);
			let output = "";
			child.stdout.setEncoding("utf8");
			child.stdout.on("data", (chunk) => {
				output += chunk;
			});
			await exit;
			return output;
		},
		read(args) {
			const { child, exit } = start(args, false);
			return { stream: child.stdout, exit };
		},
		write(args) {
			const { child, exit } = start(args, true);
			child.stdout.resume();
			return { stream: child.stdin, exit };
		},
		abort() {
			aborted = true;
			for (const child of children) child.kill("SIGTERM");
		},
		imageId(reference) {
			return new Promise((done, fail) => {
				execFile(
					"docker",
					["image", "inspect", "--format", "{{.Id}}", reference],
					(error, stdout) => (error ? fail(new Error("Image is not loaded")) : done(stdout.trim())),
				);
			});
		},
	};
}

const clickhouseArgs = (query) => [
	"exec",
	"-T",
	"clickhouse",
	"sh",
	"-c",
	`exec clickhouse-client --password "$CLICKHOUSE_PASSWORD" --query "$1"`,
	"sh",
	query,
];
const psqlArgs = (query) => [
	"exec",
	"-T",
	"postgres",
	"psql",
	"-X",
	"-U",
	"framedash",
	"-d",
	"framedash",
	"-At",
	"-v",
	"ON_ERROR_STOP=1",
	"-c",
	query,
];
const quoted = (value) => `"${value.replaceAll('"', '""')}"`;

async function postgresInventory(compose) {
	const tables = JSON.parse(
		await compose.text(
			psqlArgs(
				"SELECT coalesce(json_agg(json_build_array(schemaname, tablename) ORDER BY schemaname, tablename), '[]') FROM pg_tables WHERE schemaname NOT IN ('pg_catalog', 'information_schema')",
			),
		),
	);
	if (!tables.length) throw new Error("PostgreSQL has no tables");
	const rows = JSON.parse(
		await compose.text(
			psqlArgs(
				`SELECT json_object_agg(name, count) FROM (${tables
					.map(
						([schema, table]) =>
							`SELECT '${`${schema}.${table}`.replaceAll("'", "''")}' AS name, count(*) AS count FROM ${quoted(schema)}.${quoted(table)}`,
					)
					.join(" UNION ALL ")}) counts`,
			),
		),
	);
	const journal = tables.find(([, table]) => table === "__drizzle_migrations");
	if (!journal) throw new Error("PostgreSQL migration journal is missing");
	const migrations = (
		await compose.text(
			psqlArgs(
				`SELECT count(*) || ':' || coalesce(md5(string_agg(hash, ',' ORDER BY id)), '') FROM ${quoted(journal[0])}.${quoted(journal[1])}`,
			),
		)
	).trim();
	return {
		migrations,
		tables: Object.fromEntries(
			Object.entries(rows).map(([name, count]) => [name, { rows: Number(count), exact: true }]),
		),
	};
}

async function clickhouseInventory(compose) {
	const tables = (
		await compose.text(
			clickhouseArgs(
				"SELECT name, engine = 'MergeTree' AND position(create_table_query, ' TTL ') = 0 FROM system.tables WHERE database = 'framedash' AND engine != 'View' ORDER BY name FORMAT TabSeparated",
			),
		)
	)
		.trim()
		.split("\n")
		.map((line) => line.split("\t"));
	if (!tables.some(([name]) => name === "events"))
		throw new Error("ClickHouse events table is missing");
	const counts = await compose.text(
		clickhouseArgs(
			`${tables
				.map(([name]) => `SELECT '${name}', count() FROM framedash.${quoted(name)}`)
				.join(" UNION ALL ")} FORMAT TabSeparated`,
		),
	);
	const rows = Object.fromEntries(
		counts
			.trim()
			.split("\n")
			.map((line) => line.split("\t")),
	);
	const journal = await compose.text(
		clickhouseArgs(
			"SELECT count(), sipHash64(groupArray(name)) FROM (SELECT name FROM framedash._migrations ORDER BY name) FORMAT TabSeparated",
		),
	);
	return {
		migrations: journal.trim(),
		tables: Object.fromEntries(
			// Merges and TTLs legitimately change physical counts on every other engine.
			tables.map(([name, exact]) => [name, { rows: Number(rows[name]), exact: exact === "1" }]),
		),
	};
}

async function collectInventory(compose) {
	const postgres = await postgresInventory(compose);
	const clickhouse = await clickhouseInventory(compose);
	return {
		migrations: { postgres: postgres.migrations, clickhouse: clickhouse.migrations },
		postgres: postgres.tables,
		clickhouse: clickhouse.tables,
	};
}

export function parseContainers(output) {
	const trimmed = output.trim();
	if (!trimmed) return [];
	return trimmed.startsWith("[")
		? JSON.parse(trimmed)
		: trimmed.split("\n").map((line) => JSON.parse(line));
}

async function containers(compose) {
	return parseContainers(await compose.text(["ps", "--all", "--format", "json"]));
}

const imageRefs = (items) => Object.fromEntries(items.map((item) => [item.Service, item.Image]));

async function queueDepth(compose) {
	const output = await compose.text([
		"run",
		"--rm",
		"--no-deps",
		"-T",
		"--entrypoint",
		"node",
		"consumer",
		"-e",
		queueDepthProgram,
	]);
	return JSON.parse(output.trim().split("\n").at(-1));
}

export async function waitForDrain(
	compose,
	{
		depth = queueDepth,
		now = Date.now,
		sleep = (ms) => new Promise((done) => setTimeout(done, ms)),
	} = {},
) {
	const deadline = now() + drainTimeoutMs;
	let emptySince;
	for (;;) {
		const current = await depth(compose);
		if (current.main > 0) emptySince = undefined;
		else emptySince ??= now();
		if (emptySince !== undefined && now() - emptySince >= drainSettleMs)
			return { ...current, drained: true };
		if (now() >= deadline) return { ...current, drained: false };
		await sleep(drainPollMs);
	}
}

async function assertCleanStop(compose, service) {
	const item = (await containers(compose)).find((entry) => entry.Service === service);
	if (item?.State !== "exited" || item.ExitCode !== 0)
		throw new Error(`${service} did not stop cleanly, so its files are not a consistent copy`);
}

async function requiredBytes(compose) {
	let total = 0;
	for (const [service, path] of Object.entries(dataPaths)) {
		const output = await compose.text(["exec", "-T", service, "du", "-sk", path]);
		const kilobytes = Number(output.trim().split(/\s+/)[0]);
		if (!Number.isFinite(kilobytes)) throw new Error(`Could not measure ${service} data size`);
		total += kilobytes * 1024;
	}
	// The output normally shares a disk with the databases, which must still start afterwards.
	return Math.ceil(total * 1.2);
}

async function sealCompose(directory, key, backupId, name, command) {
	const { stream, exit } = command;
	const [summary] = await Promise.all([sealFile(directory, key, backupId, name, stream), exit]);
	if (!summary.bytes) throw new Error(`Backup component ${name} is empty`);
	return summary;
}

const coldArchive = (service) => [
	"run",
	"--rm",
	"--no-deps",
	"-T",
	"--user",
	"root",
	"--entrypoint",
	"tar",
	service,
	"-cpf",
	"-",
	"-C",
	dataPaths[service],
	".",
];
const coldExtract = (service) => [
	"run",
	"--rm",
	"--no-deps",
	"-T",
	"--user",
	"root",
	"--entrypoint",
	"tar",
	service,
	"-xpf",
	"-",
	"-C",
	dataPaths[service],
];
const stopService = (compose, service) =>
	compose.text(["stop", "-t", String(stopSeconds[service] ?? 180), service]);

export async function createBackup({
	compose,
	configBytes,
	key,
	outputDir,
	release,
	log = () => {},
	drain = waitForDrain,
	freeBytes = async () => {
		const { bavail, bsize } = await statfs(outputDir);
		return bavail * bsize;
	},
	now = () => new Date(),
}) {
	const started = await containers(compose);
	const running = started.filter((item) => item.State === "running").map((item) => item.Service);
	for (const service of Object.keys(dataPaths))
		if (!running.includes(service)) throw new Error(`${service} must be running to back up`);
	await mkdir(outputDir, { recursive: true, mode: 0o700 });
	if ((await freeBytes()) < (await requiredBytes(compose)))
		throw new Error("Not enough free space in the backup output directory");
	const createdAt = now();
	const id = backupIdFor(createdAt);
	const partial = join(outputDir, `${id}.partial`);
	await mkdir(partial, { mode: 0o700 });
	const outcome = { restarted: true };
	try {
		log("stopping proxy and ingest");
		for (const service of ["proxy", "ingest"])
			if (running.includes(service)) await stopService(compose, service);
		if (running.includes("ingest")) await assertCleanStop(compose, "ingest");
		log("waiting for the consumer to drain the queue");
		const queue = await drain(compose);
		log("stopping application services");
		for (const service of ["consumer", "scheduler", "web", "redis-http"])
			if (running.includes(service)) await stopService(compose, service);
		if (running.includes("consumer")) await assertCleanStop(compose, "consumer");
		const inventory = await collectInventory(compose);
		const parts = {};
		parts.config = await sealFile(partial, key, id, "config", PassThrough.from(configBytes));
		log("dumping PostgreSQL");
		parts.postgres = await sealCompose(
			partial,
			key,
			id,
			"postgres",
			compose.read([
				"exec",
				"-T",
				"postgres",
				"pg_dump",
				"-U",
				"framedash",
				"-d",
				"framedash",
				"--format=custom",
				"--no-owner",
				"--no-acl",
			]),
		);
		for (const service of ["clickhouse", "redis"]) {
			log(`archiving ${service}`);
			await stopService(compose, service);
			await assertCleanStop(compose, service);
			parts[service] = await sealCompose(
				partial,
				key,
				id,
				service,
				compose.read(coldArchive(service)),
			);
		}
		const manifest = {
			format: formatVersion,
			id,
			createdAt: createdAt.toISOString(),
			release,
			images: imageRefs(started),
			queue,
			complete: backupComplete(queue),
			inventory,
			components: parts,
		};
		await sealFile(
			partial,
			key,
			id,
			"manifest",
			PassThrough.from(Buffer.from(JSON.stringify(manifest))),
		);
		const finished = join(outputDir, id);
		await rename(partial, finished);
		return Object.assign(outcome, { path: finished, manifest });
	} catch (error) {
		await rm(partial, { recursive: true, force: true });
		throw error;
	} finally {
		log("restarting services");
		// Throwing here would replace the backup's own error or discard a finished backup.
		await compose.text(["start", ...running]).catch(() => {
			outcome.restarted = false;
			log(`ERROR: services did not restart. Start them with Compose: ${running.join(" ")}`);
		});
	}
}

async function assertEmptyStores(compose) {
	for (const [service, path] of Object.entries(dataPaths)) {
		const listing = await compose.text([
			"run",
			"--rm",
			"--no-deps",
			"-T",
			"--user",
			"root",
			"--entrypoint",
			"ls",
			service,
			"-A",
			path,
		]);
		if (listing.trim()) throw new Error(`Target ${service} data directory is not empty`);
	}
}

export function assertTargetRelease(manifestRelease, targetRelease) {
	if (manifestRelease && targetRelease?.version !== manifestRelease)
		throw new Error(`Target release differs from the backup's ${manifestRelease}`);
}

export function assertReleaseImage(expected, actualId) {
	if (![expected.id, expected.configId].includes(actualId))
		throw new Error(`Image ${expected.tag} does not match this release`);
}

export async function restoreBackup({
	backupDir,
	key,
	configfile,
	targetSettings,
	targetRelease,
	sameAwsResources,
	composeFor,
	log = () => {},
}) {
	const backupId = backupIdOf(backupDir);
	log("verifying every backup component");
	const manifest = await verifyBackup(backupDir, key);
	const source = parseEnv((await readSealed(backupDir, key, backupId, "config")).toString("utf8"));
	assertSeparateResources(targetSettings, source, sameAwsResources);
	assertTargetRelease(manifest.release, targetRelease);
	const inspect = composeFor(targetSettings);
	if ((await containers(inspect)).length)
		throw new Error("Target installation already has containers; use a new empty installation");
	await inspect.text(["create", "--no-build"]);
	try {
		assertSameImages(manifest.images, imageRefs(await containers(inspect)));
		if (targetRelease)
			for (const image of Object.values(targetRelease.images))
				assertReleaseImage(image, await inspect.imageId(image.tag));
		await assertEmptyStores(inspect);
	} finally {
		await inspect.text(["down"]);
	}
	const merged = mergedConfig(targetSettings, source);
	await copyFile(configfile, `${configfile}.pre-restore`, 1).catch((error) => {
		if (error.code !== "EEXIST") throw error;
	});
	const temporary = `${configfile}.restore-tmp`;
	await writeFile(temporary, renderConfig(merged), { mode: 0o600 });
	await rename(temporary, configfile);
	const compose = composeFor(merged);
	const restoreInto = async ({ stream, exit }, name) => {
		await Promise.all([pipeDecrypted(backupDir, key, backupId, name, stream), exit]);
	};
	for (const service of ["clickhouse", "redis"]) {
		log(`extracting ${service}`);
		await restoreInto(compose.write(coldExtract(service)), service);
	}
	log("starting data stores");
	await compose.text(["up", "-d", "--no-build", "--wait", "postgres", "clickhouse", "redis"]);
	log("restoring PostgreSQL");
	await restoreInto(
		compose.write([
			"exec",
			"-T",
			"postgres",
			"pg_restore",
			"-U",
			"framedash",
			"-d",
			"framedash",
			"--exit-on-error",
			"--no-owner",
			"--no-acl",
			"--single-transaction",
		]),
		"postgres",
	);
	log("comparing restored data with the backup");
	assertInventoryMatches(manifest.inventory, await collectInventory(compose));
	return manifest;
}

const replayProgram = `
(async () => {
	const url = new URL("http://localhost:3000/api/cron/replay-erasures");
	url.searchParams.set("replayedBefore", process.argv[1]);
	url.searchParams.set(process.argv[2], "1");
	const request = async (attempts) => {
		try {
			return await fetch(url, {
				headers: { Authorization: "Bearer " + process.env.CRON_SECRET },
			});
		} catch (error) {
			if (attempts <= 1) throw error;
			await new Promise((done) => setTimeout(done, 2000));
			return request(attempts - 1);
		}
	};
	console.log(JSON.stringify(await (await request(45)).json()));
})().catch(() => process.exit(1));
`;

export async function replayErasures(compose, { final, drain = waitForDrain }) {
	if (final) {
		// Settling scrubs the payload a still-running consumer could need to widen an erasure.
		const consumer = (await containers(compose)).find((item) => item.Service === "consumer");
		if (consumer?.State === "running") throw new Error("Stop the consumer before the final replay");
		if (!(await drain(compose)).drained)
			throw new Error("Queued events remain; run the consumer until they drain");
	}
	// The route rejects a future watermark, so it comes from the web container's own clock.
	// One watermark lets each pass finish; a moving one would re-select rows just replayed.
	const replayedBefore = (
		await compose.text(["exec", "-T", "web", "node", "-p", "new Date().toISOString()"])
	).trim();
	const total = { scanned: 0, replayed: 0, settled: 0 };
	for (;;) {
		const output = await compose.text([
			"exec",
			"-T",
			"web",
			"node",
			"-e",
			replayProgram,
			replayedBefore,
			final ? "finalize" : "deferSettlement",
		]);
		const result = JSON.parse(output.trim().split("\n").at(-1));
		if (result.status !== "ok" || result.failed !== 0)
			throw new Error("Erasure replay failed; do not open this installation");
		total.scanned += result.scanned;
		total.replayed += result.replayed;
		total.settled += result.settled;
		if (!result.truncated) return total;
	}
}

const commandOptions = {
	configfile: { type: "string" },
	"key-file": { type: "string" },
	"output-dir": { type: "string" },
	output: { type: "string" },
	backup: { type: "string" },
	"same-aws-resources": { type: "boolean" },
	final: { type: "boolean" },
};

export function parseCommand(argv) {
	const command = argv[0];
	const { values, positionals } = parseArgs({
		args: argv.slice(1),
		options: commandOptions,
		allowPositionals: true,
	});
	const require = (...names) => {
		for (const name of names) if (!values[name]) throw new Error(`Provide --${name}`);
	};
	if (command === "keygen") require("output");
	else if (command === "verify") require("key-file", "backup");
	else if (command === "create") require("configfile", "key-file", "output-dir");
	else if (command === "restore") require("configfile", "key-file", "backup");
	else if (command === "replay-erasures") require("configfile");
	else throw new Error("Use keygen, create, verify, restore or replay-erasures");
	if (["create", "restore", "replay-erasures"].includes(command) && !positionals.length)
		throw new Error("Provide the Compose files after --");
	return { command, values, forwarded: positionals };
}

export function parseKey(text) {
	if (!/^[0-9a-f]{64}\s*$/.test(text)) throw new Error("Backup key file must hold 64 hex digits");
	return Buffer.from(text.trim(), "hex");
}

async function readKey(path) {
	const info = await stat(path);
	if (process.platform !== "win32" && info.isFile() && info.mode & 0o077)
		throw new Error("Backup key file must not be readable by group or others");
	return parseKey(await readFile(path, "utf8"));
}

export async function withLock(configfile, work) {
	const lock = `${configfile}.backup-lock`;
	await writeFile(lock, String(process.pid), { flag: "wx", mode: 0o600 }).catch((error) => {
		if (error.code !== "EEXIST") throw error;
		throw new Error(`${lock} exists; remove it only after confirming no backup or restore runs`);
	});
	try {
		return await work();
	} finally {
		await rm(lock, { force: true });
	}
}

async function readRelease(configfile) {
	return readFile(join(dirname(configfile), "release.json"), "utf8").then(JSON.parse, () => null);
}

async function main() {
	const { command, values, forwarded } = parseCommand(process.argv.slice(2));
	const log = (message) => console.error(`[backup] ${message}`);
	if (command === "keygen") {
		await writeFile(values.output, `${randomBytes(32).toString("hex")}\n`, {
			flag: "wx",
			mode: 0o600,
		});
		console.log(
			JSON.stringify({
				success: true,
				key: resolve(values.output),
				next: "Store this key in your secret store, away from this host and from the backups.",
			}),
		);
		return;
	}
	if (command === "replay-erasures") {
		const configfile = resolve(values.configfile);
		const settings = parseEnv(await readFile(configfile, "utf8"));
		const result = await replayErasures(createCompose(configfile, forwarded, settings), {
			final: values.final === true,
		});
		console.log(JSON.stringify({ success: true, ...result }));
		return;
	}
	const key = await readKey(values["key-file"]);
	if (command === "verify") {
		const manifest = await verifyBackup(values.backup, key);
		console.log(
			JSON.stringify({
				success: true,
				id: manifest.id,
				createdAt: manifest.createdAt,
				release: manifest.release,
				complete: manifest.complete,
				queue: manifest.queue,
			}),
		);
		return;
	}
	const configfile = resolve(values.configfile);
	const configBytes = await readFile(configfile);
	const settings = parseEnv(configBytes.toString("utf8"));
	const composeFor = (current) => createCompose(configfile, forwarded, current);
	if (command === "create") {
		const outputDir = resolve(values["output-dir"]);
		assertBackupLocations({
			dataDir: settings.DATA_DIR,
			outputDir,
			keyFile: resolve(values["key-file"]),
		});
		const release = (await readRelease(configfile))?.version ?? null;
		const compose = composeFor(settings);
		const abort = () => compose.abort();
		process.once("SIGINT", abort);
		process.once("SIGTERM", abort);
		const { path, manifest, restarted } = await withLock(configfile, () =>
			createBackup({ compose, configBytes, key, outputDir, release, log }),
		);
		if (!manifest.complete) {
			log("INCOMPLETE: queued events exist that this backup can never contain; see OPERATIONS.md");
			process.exitCode = 2;
		}
		if (!restarted) process.exitCode = 1;
		console.log(
			JSON.stringify({
				success: true,
				backup: path,
				createdAt: manifest.createdAt,
				release,
				complete: manifest.complete,
				restarted,
				queue: manifest.queue,
				next: "This copy is still on the host. Move it to off-host storage.",
			}),
		);
		return;
	}
	const targetRelease = await readRelease(configfile);
	const manifest = await withLock(configfile, () =>
		restoreBackup({
			backupDir: resolve(values.backup),
			key,
			configfile,
			targetSettings: settings,
			targetRelease,
			sameAwsResources: values["same-aws-resources"] === true,
			composeFor,
			log,
		}),
	);
	console.log(
		JSON.stringify({
			success: true,
			restored: manifest.id,
			createdAt: manifest.createdAt,
			release: manifest.release,
			complete: manifest.complete,
			next: "Application services are stopped. Follow the post-restore steps in OPERATIONS.md.",
		}),
	);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main().catch((error) => {
		console.error(`Backup command failed: ${error.message}`);
		process.exitCode = 1;
	});
}
