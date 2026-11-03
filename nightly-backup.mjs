import { execFile, spawn } from "node:child_process";
import { readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv, promisify } from "node:util";
import { readKey, verifyBackup } from "./backup.mjs";
import { readHostConfig, withMaintenanceLock } from "./maintenance.mjs";

const run = promisify(execFile);
const backupName = /^framedash-backup-\d{8}T\d{6}Z-[0-9a-f]{8}$/;
const installDirectory = dirname(fileURLToPath(import.meta.url));

export const backupStatePath = (dataDir) => `${dataDir}.backup-state.json`;

export function outcomeOf(exitCode, result) {
	if (!result?.backup) return "failed";
	if (result.restarted !== true || exitCode === 1) return "failed";
	return result.complete === true && exitCode === 0 ? "good" : "incomplete";
}

export function uploadOrder(files) {
	if (!files.includes("manifest.enc")) throw new Error("Backup has no manifest");
	return [...files.filter((name) => name !== "manifest.enc").sort(), "manifest.enc"];
}

export async function removeUploadedAndOlder(outputDir, id) {
	for (const name of await readdir(outputDir))
		if (backupName.test(name) && name <= id)
			await rm(join(outputDir, name), { recursive: true, force: true });
}

function runBackup(args, cwd) {
	return new Promise((done, fail) => {
		const child = spawn(process.execPath, args, { cwd, stdio: ["ignore", "pipe", "inherit"] });
		// systemd signals the whole unit, then reaps it when this main process exits, so leaving
		// early would kill backup.mjs before it restarts the services it stopped.
		const hold = () => {};
		const stopHolding = () => {
			process.off("SIGTERM", hold);
			process.off("SIGINT", hold);
		};
		process.on("SIGTERM", hold);
		process.on("SIGINT", hold);
		let stdout = "";
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.once("error", (error) => {
			stopHolding();
			fail(error);
		});
		child.once("close", (exitCode) => {
			stopHolding();
			done({ exitCode, stdout });
		});
	});
}

async function writeState(dataDir, text) {
	const temporary = `${backupStatePath(dataDir)}.tmp`;
	await writeFile(temporary, text, { mode: 0o600 });
	await rename(temporary, backupStatePath(dataDir));
}

export async function nightlyBackup({
	config,
	createBackup,
	verify,
	upload,
	removeLocal = removeUploadedAndOlder,
	listFiles = readdir,
	writeState,
	now = () => new Date(),
	log = () => {},
}) {
	const { exitCode, result } = await createBackup();
	const outcome = outcomeOf(exitCode, result);
	if (outcome === "failed") throw new Error("The backup failed; see the service journal");
	await verify(result.backup);
	const id = result.backup.split(/[\\/]/).at(-1);
	for (const name of uploadOrder(await listFiles(result.backup)))
		await upload(join(result.backup, name), `${id}/${name}`);
	if (outcome === "incomplete") {
		log(`${id} uploaded but incomplete: queued events or dead letters remain`);
		return 2;
	}
	await writeState(
		JSON.stringify({ lastGoodAt: now().toISOString(), id, release: result.release }),
	);
	// Only a good upload makes the older local copies redundant.
	await removeLocal(config.outputDir, id);
	log(`${id} uploaded`);
	return 0;
}

async function main() {
	const hostConfig = resolve(process.argv[2] ?? "/etc/framedash/host.json");
	const config = await readHostConfig(hostConfig);
	const settings = parseEnv(await readFile(config.configfile, "utf8"));
	const key = await readKey(config.keyFile);
	const exitCode = await nightlyBackup({
		config,
		createBackup: async () => {
			const args = [
				join(installDirectory, "backup.mjs"),
				"create",
				"--configfile",
				config.configfile,
				"--key-file",
				config.keyFile,
				"--output-dir",
				config.outputDir,
				"--",
				...config.composeArgs,
			];
			const finished = await runBackup(args, dirname(config.configfile));
			const line = finished.stdout.trim().split("\n").at(-1);
			return {
				exitCode: finished.exitCode,
				result: line ? JSON.parse(line) : null,
			};
		},
		verify: (path) => verifyBackup(path, key),
		upload: (path, objectKey) =>
			run("aws", [
				"s3",
				"cp",
				path,
				`s3://${config.backupBucket}/${objectKey}`,
				"--region",
				config.region,
				"--checksum-algorithm",
				"SHA256",
				"--only-show-errors",
			]),
		writeState: (text) => writeState(settings.DATA_DIR, text),
		removeLocal: (outputDir, id) =>
			// An upgrade or restore may be reading an older copy; the next good run retries the cleanup.
			withMaintenanceLock(settings.DATA_DIR, "backup cleanup", () =>
				removeUploadedAndOlder(outputDir, id),
			).catch((error) => console.log(`Local cleanup skipped: ${error.message}`)),
		log: console.log,
	});
	process.exitCode = exitCode;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main().catch((error) => {
		console.error(`Nightly backup failed: ${error.message}`);
		process.exitCode = 1;
	});
}
