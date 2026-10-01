import { hkdfSync, randomBytes } from "node:crypto";

export function configSecretBytes(seed, label, size = 32) {
	if (seed === undefined) return randomBytes(size);
	if (!/^[A-Za-z0-9]{64}$/.test(seed)) {
		throw new Error("FRAMEDASH_CONFIG_SEED must contain exactly 64 alphanumeric characters");
	}
	return Buffer.from(
		hkdfSync("sha256", Buffer.from(seed, "utf8"), "framedash/self-hosted/config/v1", label, size),
	);
}
