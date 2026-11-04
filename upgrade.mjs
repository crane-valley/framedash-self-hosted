import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { copyFile, open, readFile, rename, rm, stat, statfs, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { parseArgs, parseEnv, promisify } from "node:util";
import {
	assertReleaseImage,
	createCompose,
	parseContainers,
	readBackupConfig,
	readKey,
	verifyBackup,
} from "./backup.mjs";
import { assertLoopbackHealth, removeLock, withMaintenanceLock } from "./maintenance.mjs";

const run = promisify(execFile);
const installDirectory = dirname(fileURLToPath(import.meta.url));

export const supportedSources = ["1.1.0", "1.2.0", "1.2.1"];
const backupMaxAgeHours = 24;
const healthTimeoutMs = 300_000;
const healthPollMs = 5_000;
const skipBackupValue = "accept-unrecoverable-failure";
const releaseVersion = /^\d+\.\d+\.\d+$/;

export const journalPath = (dataDir) => `${dataDir}.upgrade-journal.json`;

export function assertUpgrade(fromVersion, toVersion) {
	if (!releaseVersion.test(fromVersion) || !releaseVersion.test(toVersion))
		throw new Error("Upgrades run only between numbered releases");
	const order = (version) => version.split(".").map(Number);
	const [a, b] = [order(fromVersion), order(toVersion)];
	const delta = a.map((part, index) => b[index] - part).find((value) => value !== 0) ?? 0;
	if (delta <= 0)
		throw new Error(`Refusing ${fromVersion} to ${toVersion}: downgrades are not supported`);
	if (!supportedSources.includes(fromVersion))
		throw new Error(`${toVersion} was not tested from ${fromVersion}; that path is unsupported`);
}

export function assertBackupUsable({ manifest, backupSettings, settings, fromVersion, now }) {
	if (manifest.complete !== true) throw new Error("The backup is incomplete");
	if (manifest.release !== fromVersion)
		throw new Error(`The backup was taken on ${manifest.release}, not ${fromVersion}`);
	if (backupSettings.AUTH_SECRET !== settings.AUTH_SECRET)
		throw new Error("The backup belongs to another installation");
	const age = (now.getTime() - Date.parse(manifest.createdAt)) / 3_600_000;
	if (age > backupMaxAgeHours)
		throw new Error(`The backup is older than ${backupMaxAgeHours} hours`);
}

const writers = ["web", "ingest", "consumer", "scheduler"];
const services = ["proxy", ...writers, "postgres", "clickhouse", "redis", "redis-http"];

const isRunning = (item) => ["running", "restarting"].includes(item.State);

export const writerRunning = (items) =>
	items.some((item) => writers.includes(item.Service) && isRunning(item));

export function assertInstallationRunning(items) {
	if (!writerRunning(items))
		throw new Error("No running installation in this Compose project; nothing was stopped");
}

// An interrupted stop can leave only some writers up, so each one is checked, not just web.
export function assertRunsRelease(items, images) {
	const tags = [images.web.tag, images.runtime.tag];
	const running = items.filter((item) => writers.includes(item.Service) && isRunning(item));
	if (running.some((item) => !tags.includes(item.Image)))
		throw new Error(`The running installation is not ${images.web.tag}; check --current-config`);
}

export const alreadyOnRelease = (items, webTag) =>
	items.some((item) => item.Service === "web" && item.State === "running" && item.Image === webTag);

// "stopping" proves only that a stop was about to start, so any writer still up repeats every
// check. "stopped" is proof, and writers seen then are this release coming back up.
export function resumesAfterStop(journal, targetVersion, items) {
	if (journal?.to !== targetVersion) return false;
	return journal.phase === "stopped" || !writerRunning(items);
}

// v1.1.0 backups lock beside their own configuration and cannot see the maintenance lock.
export async function withReleaseBackupLock(configfile, work) {
	const lock = `${configfile}.backup-lock`;
	await writeFile(lock, String(process.pid), { flag: "wx", mode: 0o600 }).catch((error) => {
		if (error.code !== "EEXIST") throw error;
		throw new Error(`${lock} exists; remove it only after confirming no backup runs`);
	});
	try {
		return await work();
	} finally {
		await removeLock(lock);
	}
}

export function assertSameConfiguration(current, existing) {
	if (existing !== null && !current.equals(existing))
		throw new Error("The new release already has a different .env; remove it and run again");
}

// Everything before the journal repeats on a rerun because the old release keeps writing until the
// stop. Everything after it repeats too, because each step is safe to run again.
export async function performUpgrade({ resuming, prepare, mark, stop, finish, log = () => {} }) {
	if (resuming) log("resuming after the stop");
	else {
		await prepare();
		await mark("stopping");
	}
	await stop();
	await mark("stopped");
	await finish();
}

async function sha256(path) {
	const hash = createHash("sha256");
	await pipeline(createReadStream(path), hash);
	return hash.digest("hex");
}

async function writeDurable(path, text) {
	const temporary = `${path}.tmp`;
	const file = await open(temporary, "w", 0o600);
	try {
		await file.writeFile(text);
		await file.sync();
	} finally {
		await file.close();
	}
	await rename(temporary, path);
}

async function waitForHealth(secret) {
	const deadline = Date.now() + healthTimeoutMs;
	while (Date.now() < deadline) {
		const healthy = await fetch("http://127.0.0.1:8088/api/health", {
			headers: { Authorization: `Bearer ${secret}` },
			signal: AbortSignal.timeout(20_000),
			redirect: "error",
		}).then(
			(response) => response.ok,
			() => false,
		);
		if (healthy) return;
		await new Promise((done) => setTimeout(done, healthPollMs));
	}
	throw new Error("The application did not become healthy");
}

function parseCommand(argv) {
	const { values } = parseArgs({
		args: argv,
		options: {
			"current-config": { type: "string" },
			"compose-file": { type: "string", multiple: true },
			backup: { type: "string" },
			"key-file": { type: "string" },
			"skip-backup-check": { type: "string" },
		},
	});
	const files = values["compose-file"] ?? [];
	if (!values["current-config"] || files.length === 0)
		throw new Error(
			"Usage: node upgrade.mjs --current-config FILE --compose-file NAME --backup DIR --key-file FILE",
		);
	// A relative or old path could point Compose at the release being replaced.
	if (files.some((file) => basename(file) !== file))
		throw new Error("--compose-file takes a file name from this release");
	assertLoopbackHealth(files);
	if (values["skip-backup-check"] !== undefined && values["skip-backup-check"] !== skipBackupValue)
		throw new Error(`--skip-backup-check needs the value ${skipBackupValue}`);
	if (!values["skip-backup-check"] && (!values.backup || !values["key-file"]))
		throw new Error("--backup and --key-file are required");
	return values;
}

async function checkBackup(values, settings, fromVersion, log) {
	if (values["skip-backup-check"]) {
		log("NO VERIFIED BACKUP: a failed migration cannot be recovered");
		return;
	}
	const backup = resolve(values.backup);
	const key = await readKey(values["key-file"]);
	assertBackupUsable({
		manifest: await verifyBackup(backup, key),
		backupSettings: parseEnv((await readBackupConfig(backup, key)).toString("utf8")),
		settings,
		fromVersion,
		now: new Date(),
	});
}

async function main() {
	const values = parseCommand(process.argv.slice(2));
	const log = (message) => console.error(`[upgrade] ${message}`);
	const currentConfig = resolve(values["current-config"]);
	const configfile = join(installDirectory, ".env");
	const target = JSON.parse(await readFile(join(installDirectory, "release.json"), "utf8"));
	const source = JSON.parse(await readFile(join(dirname(currentConfig), "release.json"), "utf8"));
	assertUpgrade(source.version, target.version);
	const currentBytes = await readFile(currentConfig);
	const settings = parseEnv(currentBytes.toString("utf8"));
	const journalFile = journalPath(settings.DATA_DIR);
	const readJournal = () =>
		readFile(journalFile, "utf8").then(JSON.parse, (error) => {
			if (error.code === "ENOENT") return null;
			throw error;
		});
	const archive = join(installDirectory, target.archive.filename);
	const compose = createCompose(
		configfile,
		values["compose-file"].flatMap((file) => ["-f", join(installDirectory, file)]),
		settings,
	);
	const containers = async () =>
		parseContainers(await compose.text(["ps", "--all", "--format", "json"]));
	// Compose needs the new release's .env, so this comes before the first status check.
	const copyConfiguration = async () => {
		const existing = await readFile(configfile).catch((error) => {
			if (error.code === "ENOENT") return null;
			throw error;
		});
		assertSameConfiguration(currentBytes, existing);
		if (existing === null) await copyFile(currentConfig, configfile);
	};
	const prepare = async () => {
		if ((await sha256(archive)) !== target.archive.sha256)
			throw new Error("The image archive does not match release.json");
		const { size } = await stat(archive);
		const { bavail, bsize } = await statfs(settings.DATA_DIR);
		if (bavail * bsize < size * 4) throw new Error("Not enough free space for the new images");
		await run("docker", ["image", "load", "--input", archive], { maxBuffer: 16 * 1024 * 1024 });
		for (const image of Object.values(target.images))
			assertReleaseImage(image, await compose.imageId(image.tag));
		const items = await containers();
		assertInstallationRunning(items);
		assertRunsRelease(items, source.images);
		await checkBackup(values, settings, source.version, log);
	};
	const refreshHostServices = async () => {
		if (existsSync("/etc/framedash/host.json"))
			await run(process.execPath, [
				join(installDirectory, "install-host-services.mjs"),
				"--reuse-existing",
			]);
	};
	const stop = () => compose.text(["down", "--remove-orphans"]);
	const finish = async () => {
		await compose.text(["up", "-d", "--wait", "--no-build", "postgres", "clickhouse", "redis"]);
		await compose.text(["run", "--rm", "--no-deps", "migrate"]);
		await compose.text(["up", "-d", "--no-build"]);
		// Plain up returns before healthchecks, and /api/health does not cover every service.
		await compose.text(["up", "-d", "--wait", "--wait-timeout", "300", "--no-build", ...services]);
		await waitForHealth(settings.CRON_SECRET);
		// Past this point the upgrade has succeeded, so a host-service failure must not rerun it.
		await rm(journalFile, { force: true });
		await refreshHostServices();
	};
	await withMaintenanceLock(settings.DATA_DIR, "upgrade", () =>
		withReleaseBackupLock(currentConfig, async () => {
			await copyConfiguration();
			const journal = await readJournal();
			const items = await containers();
			if (journal === null && alreadyOnRelease(items, target.images.web.tag)) {
				log("already on this release; refreshing host services only");
				return refreshHostServices();
			}
			return performUpgrade({
				resuming: resumesAfterStop(journal, target.version, items),
				prepare,
				mark: (phase) =>
					writeDurable(
						journalFile,
						JSON.stringify({ from: source.version, to: target.version, phase }),
					),
				stop,
				finish,
				log,
			});
		}),
	);
	console.log(JSON.stringify({ success: true, from: source.version, to: target.version }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main().catch((error) => {
		console.error(`Upgrade failed: ${error.message}`);
		console.error(
			"Remove the maintenance lock and the old release's .env.backup-lock only if no upgrade task is running, then rerun the same command. If a migration failed, restore the backup into a new installation of the previous release: see OPERATIONS.md.",
		);
		process.exitCode = 1;
	});
}
