import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function normalizeBootstrapAdminEmail(supplied) {
	if (typeof supplied !== "string") throw new Error("Invalid ADMIN_EMAIL");
	const email = supplied.trim().toLowerCase();
	const [local, domain, extra] = email.split("@");
	const labels = domain?.split(".") ?? [];
	// Keep the standalone installer aligned with the web credentials' Zod email policy.
	if (
		email.length > 255 ||
		extra !== undefined ||
		!/^(?!\.)(?!.*\.\.)[A-Za-z0-9_'+\-.]*[A-Za-z0-9_+-]$/.test(local) ||
		labels.length < 2 ||
		!labels.slice(0, -1).every((label) => /^[A-Za-z0-9][A-Za-z0-9-]*$/.test(label)) ||
		!/^[A-Za-z]{2,}$/.test(labels.at(-1) ?? "")
	) {
		throw new Error("Invalid ADMIN_EMAIL");
	}
	return email;
}

export function getBootstrapKeyPrefix(key) {
	if (typeof key !== "string" || !/^(?:fd_[a-f0-9]{32}|fd_ing_[a-f0-9]{48})$/.test(key)) {
		throw new Error("A generated SDK_API_KEY is required");
	}
	return key.slice(key.lastIndexOf("_") + 1, key.lastIndexOf("_") + 9);
}

export function resolveBootstrapNames(env) {
	const names = {
		ADMIN_NAME: env.ADMIN_NAME ?? "Instance administrator",
		WORKSPACE_NAME: env.WORKSPACE_NAME ?? "Self-hosted workspace",
		WORKSPACE_SLUG: env.WORKSPACE_SLUG ?? "self-hosted-workspace",
		PROJECT_NAME: env.PROJECT_NAME ?? "First project",
		SDK_API_KEY_NAME: env.SDK_API_KEY_NAME ?? "SDK ingest",
	};
	for (const [key, supplied] of Object.entries(names)) {
		const value = supplied.trim();
		const limit = key === "SDK_API_KEY_NAME" ? 100 : key === "WORKSPACE_SLUG" ? 63 : 255;
		const hasControl = [...supplied].some((character) => {
			const code = character.charCodeAt(0);
			return code < 32 || code === 127;
		});
		if (!value || value.length > limit || hasControl) {
			throw new Error(`Invalid ${key}`);
		}
		if (
			key === "WORKSPACE_SLUG" &&
			(value.length < 3 || !/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(value))
		) {
			throw new Error("Invalid WORKSPACE_SLUG");
		}
		names[key] = value;
	}
	return names;
}

export async function bootstrap(env = process.env) {
	const { ADMIN_EMAIL, ADMIN_PASSWORD, SDK_API_KEY, DATABASE_URL } = env;
	const names = resolveBootstrapNames(env);
	if (env.FRAMEDASH_SELF_HOSTED !== "true") throw new Error("Self-hosted mode is required");
	const adminEmail = normalizeBootstrapAdminEmail(ADMIN_EMAIL);
	if (!DATABASE_URL || !ADMIN_EMAIL || !ADMIN_PASSWORD || ADMIN_PASSWORD.length < 16) {
		throw new Error("DATABASE_URL, ADMIN_EMAIL, and a generated ADMIN_PASSWORD are required");
	}
	const keyPrefix = getBootstrapKeyPrefix(SDK_API_KEY);
	const url = new URL(DATABASE_URL);
	if (url.hostname !== "postgres")
		throw new Error("Bootstrap only accepts the Compose postgres service");
	const requireWeb = createRequire(new URL("../../apps/web/package.json", import.meta.url));
	const { hash } = requireWeb("@node-rs/argon2");
	const { default: postgres } = await import("postgres");
	const passwordHash = await hash(ADMIN_PASSWORD);
	const keyHash = createHash("sha256").update(SDK_API_KEY).digest("hex");
	const sql = postgres(DATABASE_URL, { max: 1 });
	try {
		const result = await sql.begin(async (tx) => {
			await tx`LOCK TABLE users, tenants IN EXCLUSIVE MODE`;
			const [existing] =
				await tx`SELECT EXISTS (SELECT 1 FROM users) OR EXISTS (SELECT 1 FROM tenants) AS present`;
			if (existing.present)
				throw new Error(
					"Bootstrap requires an empty instance; existing accounts will not be modified",
				);
			const [user] = await tx`
				INSERT INTO users (email, name, password_hash, email_verified)
				VALUES (${adminEmail}, ${names.ADMIN_NAME}, ${passwordHash}, now()) RETURNING id
			`;
			const [tenant] = await tx`
				INSERT INTO tenants (name, slug, plan_id, subscription_status, requires_paid_plan, created_by_user_id)
				VALUES (${names.WORKSPACE_NAME}, ${names.WORKSPACE_SLUG}, 'team', 'active', false, ${user.id}) RETURNING id
			`;
			await tx`INSERT INTO tenant_members (tenant_id, user_id, role) VALUES (${tenant.id}, ${user.id}, 'billing_admin')`;
			const [project] =
				await tx`INSERT INTO projects (tenant_id, name) VALUES (${tenant.id}, ${names.PROJECT_NAME}) RETURNING id`;
			await tx`
				INSERT INTO api_keys (project_id, name, key_hash, key_prefix, scopes, created_by)
				VALUES (${project.id}, ${names.SDK_API_KEY_NAME}, ${keyHash}, ${keyPrefix}, ARRAY['events:write'], ${user.id})
			`;
			return { userId: user.id, tenantId: tenant.id, projectId: project.id };
		});
		console.log(JSON.stringify(result));
	} finally {
		await sql.end();
	}
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
	await bootstrap();
}
