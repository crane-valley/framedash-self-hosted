import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

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
	return {
		arguments: ["compose", "--env-file", resolve(configfile), ...forwarded],
		environment: { ...shellEnvironment, ...settings },
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
	child.stderr.resume();
	const [code, signal] = await once(child, "close");
	if (code !== 0 || signal) {
		console.error("Compose failed; detailed stderr is suppressed to protect configuration values.");
		process.exitCode = code || 1;
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main().catch(() => {
		console.error("Compose invocation failed; check the configuration and arguments privately.");
		process.exitCode = 1;
	});
}
