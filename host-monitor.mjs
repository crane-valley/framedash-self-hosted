import { execFile } from "node:child_process";
import { readFile, statfs } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv, promisify } from "node:util";
import { createCompose, parseContainers } from "./backup.mjs";
import { readHostConfig, readMaintenance } from "./maintenance.mjs";
import { backupStatePath } from "./nightly-backup.mjs";

const run = promisify(execFile);
const longRunning = [
	"proxy",
	"web",
	"ingest",
	"consumer",
	"scheduler",
	"postgres",
	"clickhouse",
	"redis",
	"redis-http",
];
const namespace = "Framedash/SelfHosted";

export function servicesHealthy(items) {
	return longRunning.every((service) => {
		const item = items.find((entry) => entry.Service === service);
		if (item?.State !== "running") return false;
		return !item.Health || item.Health === "healthy";
	});
}

// Budget claims fill Redis under noeviction, and a full Redis sends batches to the dead-letter queue
// within minutes; 80 percent leaves the operator time to act before that.
export function redisHasRoom(info) {
	const used = Number(/^used_memory:(\d+)/m.exec(info)?.[1]);
	const max = Number(/^maxmemory:(\d+)/m.exec(info)?.[1]);
	if (!Number.isFinite(used) || !Number.isFinite(max)) return false;
	return max === 0 || used < max * 0.8;
}

export function maintenanceActive(maintenance, maintenanceMinutes, now) {
	if (!maintenance) return false;
	return now.getTime() - Date.parse(maintenance.startedAt) < maintenanceMinutes * 60_000;
}

export function headroomRatio({ free, total }) {
	const used = total - free;
	return used > 0 ? free / (used * 1.2) : 10;
}

export function usedPercent({ free, total }) {
	return total > 0 ? ((total - free) / total) * 100 : 0;
}

export function metricData({
	stackName,
	healthy,
	maintenance,
	dataDisk,
	rootDisk,
	backupAgeHours,
}) {
	const entry = (MetricName, Value) => ({
		MetricName,
		Value,
		Dimensions: [{ Name: "StackName", Value: stackName }],
	});
	const metrics = [
		entry("Healthy", healthy || maintenance ? 1 : 0),
		entry("MaintenanceActive", maintenance ? 1 : 0),
		entry("BackupHeadroomRatio", Number(headroomRatio(dataDisk).toFixed(3))),
		entry("RootDiskUsedPercent", Number(usedPercent(rootDisk).toFixed(1))),
	];
	if (backupAgeHours !== null)
		metrics.push(entry("LastBackupAgeHours", Number(backupAgeHours.toFixed(2))));
	return metrics;
}

async function probe(url, secret, request) {
	return request(url, {
		headers: { Authorization: `Bearer ${secret}` },
		signal: AbortSignal.timeout(20_000),
		redirect: "error",
	}).then(
		(response) => response.ok,
		() => false,
	);
}

async function diskOf(path) {
	const { bavail, blocks, bsize } = await statfs(path);
	return { free: bavail * bsize, total: blocks * bsize };
}

async function backupAge(dataDir, now) {
	// Unreadable state leaves this metric missing, which alarms, without stopping the others.
	try {
		const state = JSON.parse(await readFile(backupStatePath(dataDir), "utf8"));
		const age = (now.getTime() - Date.parse(state.lastGoodAt)) / 3_600_000;
		return Number.isFinite(age) ? age : null;
	} catch {
		return null;
	}
}

async function main() {
	const config = await readHostConfig(resolve(process.argv[2]));
	const settings = parseEnv(await readFile(config.configfile, "utf8"));
	const now = new Date();
	const compose = createCompose(config.configfile, config.composeArgs, settings);
	const items = await compose
		.text(["ps", "--all", "--format", "json"])
		.then(parseContainers, () => []);
	const base = "http://127.0.0.1:8088";
	const [deep, cron] = await Promise.all(
		["/api/health", "/api/health/cron"].map((path) =>
			probe(`${base}${path}`, settings.CRON_SECRET, fetch),
		),
	);
	const redisInfo = await compose
		.text([
			"exec",
			"-T",
			"redis",
			"sh",
			"-c",
			'REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli info memory',
		])
		.catch(() => "");
	const metrics = metricData({
		stackName: config.stackName,
		healthy: servicesHealthy(items) && deep && cron && redisHasRoom(redisInfo),
		maintenance: maintenanceActive(
			await readMaintenance(settings.DATA_DIR),
			config.maintenanceMinutes,
			now,
		),
		dataDisk: await diskOf(settings.DATA_DIR),
		rootDisk: await diskOf("/"),
		backupAgeHours: await backupAge(settings.DATA_DIR, now),
	});
	await run("aws", [
		"cloudwatch",
		"put-metric-data",
		"--region",
		config.region,
		"--namespace",
		namespace,
		"--metric-data",
		JSON.stringify(metrics),
	]);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main().catch((error) => {
		console.error(`Host monitor failed: ${error.message}`);
		process.exitCode = 1;
	});
}
