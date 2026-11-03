import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { link, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

export const lockPath = (dataDir) => `${dataDir}.maintenance-lock`;

export async function readHostConfig(path) {
	const config = JSON.parse(await readFile(path, "utf8"));
	if (typeof config !== "object" || config === null || Array.isArray(config))
		throw new Error("The host configuration must be a JSON object");
	return config;
}

// A failed removal must not replace the error that ended the work.
export async function removeLock(path) {
	await rm(path, { force: true }).catch((error) => {
		console.error(`Could not remove ${path}: ${error.message}`);
	});
}

export async function readMaintenance(dataDir) {
	const text = await readFile(lockPath(dataDir), "utf8").catch((error) => {
		if (error.code === "ENOENT") return null;
		throw error;
	});
	return text === null ? null : JSON.parse(text);
}

// A dead parent says nothing about the Docker work it started, so a lock is never taken over.
export async function acquireMaintenance(dataDir, owner) {
	const path = lockPath(dataDir);
	const candidate = `${path}.${randomBytes(4).toString("hex")}`;
	const holder = { owner, pid: process.pid, startedAt: new Date().toISOString() };
	await writeFile(candidate, JSON.stringify(holder), { flag: "wx", mode: 0o600 });
	try {
		await link(candidate, path);
	} catch (error) {
		if (error.code !== "EEXIST") throw error;
		const held = await readMaintenance(dataDir);
		throw new Error(
			`${path} is held by ${held?.owner} since ${held?.startedAt}; remove it only after confirming that task and its containers have stopped`,
		);
	} finally {
		await removeLock(candidate);
	}
}

export async function withMaintenanceLock(dataDir, owner, work) {
	await acquireMaintenance(dataDir, owner);
	try {
		return await work();
	} finally {
		await removeLock(lockPath(dataDir));
	}
}

// Manual repairs such as raising the Redis limit must not overlap a backup's cold copy.
export async function runUnderLock(dataDir, owner, command, args, cwd) {
	return withMaintenanceLock(dataDir, owner, async () => {
		const child = spawn(command, args, { cwd, stdio: "inherit" });
		const [code, signal] = await once(child, "exit");
		return signal ? 1 : code;
	});
}

async function main(argv) {
	const separator = argv.indexOf("--");
	if (argv[0] !== "run" || separator < 0 || separator + 1 >= argv.length)
		throw new Error("Usage: node maintenance.mjs run [HOST_CONFIG] -- COMMAND [ARGS...]");
	const config = await readHostConfig(
		resolve(argv[1] === "--" ? "/etc/framedash/host.json" : argv[1]),
	);
	const settings = parseEnv(await readFile(config.configfile, "utf8"));
	const [command, ...args] = argv.slice(separator + 1);
	return runUnderLock(
		settings.DATA_DIR,
		`manual: ${command}`,
		command,
		args,
		dirname(config.configfile),
	);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main(process.argv.slice(2)).then(
		(code) => {
			process.exitCode = code;
		},
		(error) => {
			console.error(`Maintenance failed: ${error.message}`);
			process.exitCode = 1;
		},
	);
}
