import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, parseEnv, promisify } from "node:util";
import { readKey } from "./backup.mjs";
import { assertLoopbackHealth, readHostConfig, withMaintenanceLock } from "./maintenance.mjs";

const run = promisify(execFile);
const systemdDirectory = "/etc/systemd/system";
const hostConfigPath = "/etc/framedash/host.json";
const units = [
	"framedash-monitor.service",
	"framedash-monitor.timer",
	"framedash-backup.service",
	"framedash-backup.timer",
];

// Daily cleanup crons match only their exact minute from 03:00 to 04:45 UTC, so a run stopping the
// scheduler across them skips that day's retention and deletion work with no catch-up.
export const firstBackupHour = 5;
export const lastBackupHour = 22;
// Hourly crons run at minute 0 and go stale in /api/health/cron if a backup spans that minute.
export const firstBackupMinute = 5;
export const lastBackupMinute = 15;
export const maintenanceChoices = [30, 45, 60, 90, 120, 180, 240];

export function backupCalendar(time) {
	const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time ?? "");
	if (!match) throw new Error("--backup-time must be HH:MM in UTC");
	const hour = Number(match[1]);
	const minute = Number(match[2]);
	if (hour < firstBackupHour || hour > lastBackupHour)
		throw new Error("--backup-time must start from 05:00 through 22:59 UTC");
	if (minute < firstBackupMinute || minute > lastBackupMinute)
		throw new Error("--backup-time must start 5 to 15 minutes past the hour");
	return `*-*-* ${match[1]}:${match[2]}:00 UTC`;
}

export function renderUnits({ installDir, backupCalendar: calendar, maintenanceMinutes = 60 }) {
	const service = (description, script, timeout) => `[Unit]
Description=${description}
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
TimeoutStartSec=${timeout}
TimeoutStopSec=5min
WorkingDirectory=${installDir}
ExecStart=/usr/bin/node ${join(installDir, script)} ${hostConfigPath}
`;
	const rendered = {
		"framedash-monitor.service": service("Report Framedash health", "host-monitor.mjs", "50s"),
		"framedash-monitor.timer": `[Unit]
Description=Report Framedash health every minute

[Timer]
OnBootSec=2min
OnUnitActiveSec=1min
AccuracySec=5s

[Install]
WantedBy=timers.target
`,
	};
	if (calendar) {
		rendered["framedash-backup.service"] = service(
			"Back up Framedash",
			"nightly-backup.mjs",
			`${maintenanceMinutes}min`,
		);
		rendered["framedash-backup.timer"] = `[Unit]
Description=Back up Framedash nightly

[Timer]
OnCalendar=${calendar}

[Install]
WantedBy=timers.target
`;
	}
	return rendered;
}

export function hostConfig(values, installDir) {
	const required = ["configfile", "stack-name", "region"];
	for (const name of required) if (!values[name]) throw new Error(`--${name} is required`);
	const files = values["compose-file"] ?? [];
	if (files.length === 0) throw new Error("--compose-file is required");
	// Relative names follow the release directory across upgrades; an old path would not.
	if (files.some((file) => basename(file) !== file))
		throw new Error("--compose-file takes a file name from this release");
	assertLoopbackHealth(files);
	const composeArgs = files.flatMap((file) => ["-f", file]);
	if (resolve(values.configfile) !== resolve(installDir, ".env"))
		throw new Error("--configfile must be this release's .env");
	const maintenanceMinutes = Number(values["maintenance-minutes"] ?? 60);
	if (!maintenanceChoices.includes(maintenanceMinutes))
		throw new Error(`--maintenance-minutes must be one of ${maintenanceChoices.join(", ")}`);
	if (values["backup-time"] && !values["backup-bucket"])
		throw new Error("--backup-time needs --backup-bucket");
	const config = {
		installDir,
		configfile: resolve(values.configfile),
		composeArgs,
		stackName: values["stack-name"],
		region: values.region,
		maintenanceMinutes,
	};
	if (values["backup-bucket"]) {
		if (!values["key-file"] || !isAbsolute(values["key-file"]))
			throw new Error("--key-file must be an absolute path");
		if (!values["output-dir"]) throw new Error("--output-dir is required with --backup-bucket");
		for (const path of [values["key-file"], resolve(values["output-dir"])])
			if (path.startsWith(`${installDir}/`))
				throw new Error("Keep the key and backups outside the release directory");
		Object.assign(config, {
			backupBucket: values["backup-bucket"],
			keyFile: values["key-file"],
			outputDir: resolve(values["output-dir"]),
		});
	}
	return config;
}

const systemctl = (...args) => run("systemctl", args);

async function uninstall() {
	await systemctl("disable", "--now", "framedash-monitor.timer", "framedash-backup.timer").catch(
		() => {},
	);
	for (const unit of units) await rm(join(systemdDirectory, unit), { force: true });
	await rm(hostConfigPath, { force: true });
	await systemctl("daemon-reload");
}

async function main() {
	const { values } = parseArgs({
		options: {
			configfile: { type: "string" },
			"compose-file": { type: "string", multiple: true },
			"stack-name": { type: "string" },
			region: { type: "string" },
			"maintenance-minutes": { type: "string" },
			"backup-bucket": { type: "string" },
			"backup-time": { type: "string" },
			"key-file": { type: "string" },
			"output-dir": { type: "string" },
			"reuse-existing": { type: "boolean" },
			uninstall: { type: "boolean" },
		},
	});
	if (process.getuid?.() !== 0) throw new Error("Run as root: this writes systemd units");
	if (values.uninstall) {
		await uninstall();
		console.log(JSON.stringify({ success: true, removed: units }));
		return;
	}
	const installDir = dirname(fileURLToPath(import.meta.url));
	let config;
	if (values["reuse-existing"]) {
		config = { ...(await readHostConfig(hostConfigPath)), installDir };
		config.configfile = join(installDir, ".env");
	} else {
		config = hostConfig(values, installDir);
		if (config.backupBucket) config.backupCalendar = backupCalendar(values["backup-time"]);
	}
	if (config.keyFile) await readKey(config.keyFile);
	const settings = parseEnv(await readFile(config.configfile, "utf8"));
	const install = async () => {
		await mkdir(dirname(hostConfigPath), { recursive: true, mode: 0o700 });
		await writeFile(hostConfigPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
		const rendered = renderUnits(config);
		if (!rendered["framedash-backup.timer"]) {
			await systemctl("disable", "--now", "framedash-backup.timer").catch(() => {});
			for (const unit of units.filter((name) => !rendered[name]))
				await rm(join(systemdDirectory, unit), { force: true });
		}
		for (const [name, text] of Object.entries(rendered))
			await writeFile(join(systemdDirectory, name), text, { mode: 0o644 });
		await systemctl("daemon-reload");
		await systemctl(
			"enable",
			"--now",
			...Object.keys(rendered).filter((name) => name.endsWith(".timer")),
		);
		return Object.keys(rendered);
	};
	const installed = values["reuse-existing"]
		? await install()
		: await withMaintenanceLock(settings.DATA_DIR, "host service install", install);
	await run(process.execPath, [join(installDir, "host-monitor.mjs"), hostConfigPath]).catch(() => {
		throw new Error(
			"The monitor could not report. The stack needs AlarmTopicArn for metric permissions; see the journal of framedash-monitor.service.",
		);
	});
	console.log(JSON.stringify({ success: true, installed }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main().catch((error) => {
		console.error(`Host service install failed: ${error.message}`);
		process.exitCode = 1;
	});
}
