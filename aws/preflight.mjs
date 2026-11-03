import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const requiredParameters = ["ExpectedAccountId", "VpcId", "PublicSubnetId", "AvailabilityZone"];

function defaultRoute(tables) {
	for (const table of tables) {
		const route = table.Routes?.find(
			(item) => item.DestinationCidrBlock === "0.0.0.0/0" && item.State === "active",
		);
		if (route) return route;
	}
	return null;
}

async function routeTables(aws, vpcId, subnetId) {
	const associated = await aws([
		"ec2",
		"describe-route-tables",
		"--filters",
		`Name=association.subnet-id,Values=${subnetId}`,
	]);
	if (associated.RouteTables.length > 0) return associated.RouteTables;
	const main = await aws([
		"ec2",
		"describe-route-tables",
		"--filters",
		`Name=vpc-id,Values=${vpcId}`,
		"Name=association.main,Values=true",
	]);
	return main.RouteTables;
}

async function natReachesInternet(aws, vpcId, natGatewayId) {
	const { NatGateways: gateways } = await aws([
		"ec2",
		"describe-nat-gateways",
		"--nat-gateway-ids",
		natGatewayId,
	]);
	const gateway = gateways[0];
	if (gateway?.State !== "available" || gateway.ConnectivityType !== "public") return false;
	const route = defaultRoute(await routeTables(aws, vpcId, gateway.SubnetId));
	return route?.GatewayId?.startsWith("igw-") === true;
}

async function checkAccount(value, aws) {
	const { Account: account } = await aws(["sts", "get-caller-identity"]);
	return account === value("ExpectedAccountId")
		? []
		: ["The signed-in account is not ExpectedAccountId"];
}

async function checkSubnets(value, aws, hostSubnetId) {
	const failures = [];
	const subnetIds = [
		...new Set(
			[value("PublicSubnetId"), value("InstanceSubnetId"), value("AlbSecondSubnetId")].filter(
				Boolean,
			),
		),
	];
	const { Subnets: subnets } = await aws(["ec2", "describe-subnets", "--subnet-ids", ...subnetIds]);
	const zones = new Map(subnets.map((subnet) => [subnet.SubnetId, subnet.AvailabilityZone]));
	if (subnets.some((subnet) => subnet.VpcId !== value("VpcId")))
		failures.push("Every subnet must belong to VpcId");
	if (zones.get(hostSubnetId) !== value("AvailabilityZone"))
		failures.push("AvailabilityZone must match the host subnet, or the data volume cannot attach");
	if (value("EnableAlb") === "true") {
		const albZones = [value("PublicSubnetId"), value("AlbSecondSubnetId")].map((id) =>
			zones.get(id),
		);
		if (albZones[0] === albZones[1])
			failures.push("PublicSubnetId and AlbSecondSubnetId must be in different zones");
		if (!albZones.includes(value("AvailabilityZone")))
			failures.push("The host zone must be an ALB zone, or the target stays unused");
	}
	return failures;
}

async function checkAlb(value, aws) {
	if (value("EnableAlb") !== "true") return [];
	const failures = [];
	const { Certificate: certificate } = await aws([
		"acm",
		"describe-certificate",
		"--certificate-arn",
		value("AlbCertificateArn"),
	]);
	if (certificate.Status !== "ISSUED") failures.push("The ACM certificate is not ISSUED");
	if (value("AlbScheme") !== "internet-facing") return failures;
	for (const subnetId of [value("PublicSubnetId"), value("AlbSecondSubnetId")]) {
		const route = defaultRoute(await routeTables(aws, value("VpcId"), subnetId));
		if (!route?.GatewayId?.startsWith("igw-"))
			failures.push(`${subnetId} needs an internet gateway route for an internet-facing ALB`);
	}
	return failures;
}

async function checkHostRoute(value, aws, hostSubnetId) {
	const route = defaultRoute(await routeTables(aws, value("VpcId"), hostSubnetId));
	if (!value("InstanceSubnetId"))
		return route?.GatewayId?.startsWith("igw-")
			? []
			: ["The host subnet needs an active default route to an internet gateway"];
	if (route?.NatGatewayId && (await natReachesInternet(aws, value("VpcId"), route.NatGatewayId)))
		return [];
	return [
		"The host subnet needs an active default route to a public NAT gateway that reaches the internet: Session Manager and the creation signal need it before the stack finishes",
	];
}

async function checkImage(value, aws) {
	if (!value("AmiImageId"))
		return String(value("AutoStopHours")) === "0" ? ["AutoStopHours 0 requires AmiImageId"] : [];
	const { Images: images } = await aws([
		"ec2",
		"describe-images",
		"--image-ids",
		value("AmiImageId"),
	]);
	const failures = [];
	if (images[0]?.State !== "available") failures.push("AmiImageId is not available");
	if (images[0]?.Architecture !== "x86_64") failures.push("AmiImageId must be x86_64");
	// Any account can publish an image under an al2023-ami name; only AWS sets the amazon alias.
	if (images[0]?.ImageOwnerAlias !== "amazon") failures.push("AmiImageId must be owned by Amazon");
	// User data needs dnf, cfn-signal and the SSM agent, which the minimal image leaves out.
	if (!/^al2023-ami-(?!minimal-)/.test(images[0]?.Name ?? ""))
		failures.push("AmiImageId must be a standard Amazon Linux 2023 image");
	return failures;
}

async function checkInstanceType(value, aws) {
	const { InstanceTypeOfferings: offerings } = await aws([
		"ec2",
		"describe-instance-type-offerings",
		"--location-type",
		"availability-zone",
		"--filters",
		`Name=location,Values=${value("AvailabilityZone")}`,
		`Name=instance-type,Values=${value("InstanceType") || "t3.xlarge"}`,
	]);
	return offerings.length === 0 ? ["InstanceType is not offered in AvailabilityZone"] : [];
}

export async function preflight(parameters, aws) {
	const value = (key) => parameters[key] ?? "";
	const missing = requiredParameters.filter((key) => !value(key));
	if (value("EnableAlb") === "true") {
		if (!value("AlbCertificateArn")) missing.push("AlbCertificateArn");
		if (!value("AlbSecondSubnetId")) missing.push("AlbSecondSubnetId");
	}
	if (missing.length > 0) return [`Missing parameters: ${missing.join(", ")}`];
	const hostSubnetId = value("InstanceSubnetId") || value("PublicSubnetId");
	const results = [
		await checkAccount(value, aws),
		await checkSubnets(value, aws, hostSubnetId),
		await checkAlb(value, aws),
		await checkHostRoute(value, aws, hostSubnetId),
		await checkImage(value, aws),
		await checkInstanceType(value, aws),
	];
	return results.flat();
}

export function parameterMap(entries) {
	return Object.fromEntries(entries.map((entry) => [entry.ParameterKey, entry.ParameterValue]));
}

function parseArguments(argv) {
	const options = {};
	for (let index = 0; index < argv.length; index += 2) {
		if (!["--parameters", "--region"].includes(argv[index]) || argv[index + 1] === undefined)
			throw new Error("Usage: node aws/preflight.mjs --parameters FILE --region REGION");
		options[argv[index].slice(2)] = argv[index + 1];
	}
	if (!options.parameters || !options.region)
		throw new Error("Usage: node aws/preflight.mjs --parameters FILE --region REGION");
	return options;
}

async function main() {
	const options = parseArguments(process.argv.slice(2));
	const entries = JSON.parse(await readFile(options.parameters, "utf8"));
	if (!Array.isArray(entries)) throw new Error("The parameters file must be a JSON array");
	const parameters = parameterMap(entries);
	const aws = async (args) => {
		const { stdout } = await run(
			"aws",
			[...args, "--region", options.region, "--output", "json", "--no-cli-pager"],
			{ maxBuffer: 16 * 1024 * 1024 },
		);
		const parsed = JSON.parse(stdout);
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
			throw new Error("The AWS CLI returned an unexpected response");
		return parsed;
	};
	const failures = await preflight(parameters, aws);
	console.log(JSON.stringify({ success: failures.length === 0, failures }, null, 2));
	if (failures.length > 0) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main().catch((error) => {
		console.error(`Preflight could not finish: ${error.message}`);
		process.exitCode = 1;
	});
}
