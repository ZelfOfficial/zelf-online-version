#!/usr/bin/env node
/**
 * Upload the ArNS name-page bundles and point local env at the new HTML txs.
 *
 *   node scripts/deploy-arns-sites.mjs            # dry-run
 *   node scripts/deploy-arns-sites.mjs --execute  # upload CSS, JS, then HTML
 */
import { createRequire } from "module";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const require = createRequire(import.meta.url);
require("dotenv").config();

const { TurboFactory, productionTurboConfiguration } = require("@ardrive/turbo-sdk");
const config = require("../Core/config");

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const execute = process.argv.includes("--execute");
const only = process.argv.find((arg) => arg.startsWith("--only="))?.slice("--only=".length);

const bundles = [
	{
		name: "zelf",
		dir: "arns",
		css: "main.css",
		js: "main_v2.js",
		html: "index.html",
		envKey: "ARNS_INDEX_TRANSACTION_ID",
	},
	{
		name: "bdag",
		dir: "arns/blockDAG",
		css: "blockdag.css",
		js: "blockdag.js",
		html: "index.html",
		envKey: "ARNS_BLOCKDAG_TRANSACTION_ID",
	},
	{
		name: "socials",
		dir: "arns/socialLinks",
		css: "social-links.css",
		js: "social-links.js",
		html: "index.html",
		envKey: "ARNS_SOCIALS_TRANSACTION_ID",
	},
];

const contentTypes = {
	css: "text/css",
	js: "application/javascript",
	html: "text/html",
};

const assertGatewayEnv = () => {
	const host = String(process.env.ARWEAVE_ARNS_GATEWAY_HOST || "");
	const publicUrl = String(process.env.ARWEAVE_PUBLIC_GATEWAY_URL || "");
	if (host.includes("arweave.zelf.world") || publicUrl.includes("arweave.zelf.world")) {
		throw new Error("ARWEAVE gateway env still points at arweave.zelf.world");
	}
};

const buildWallet = () => ({
	kty: "RSA",
	n: config.arwave.n,
	e: config.arwave.e,
	d: config.arwave.d,
	p: config.arwave.p,
	q: config.arwave.q,
	dp: config.arwave.dp,
	dq: config.arwave.dq,
	qi: config.arwave.qi,
	kid: "2011-04-29",
});

const uploadFile = async (client, filePath, contentType) => {
	const fileSize = fs.statSync(filePath).size;
	const uploadResult = await client.uploadFile({
		fileStreamFactory: () => fs.createReadStream(filePath),
		fileSizeFactory: () => fileSize,
		dataItemOpts: {
			tags: [{ name: "Content-Type", value: contentType }],
		},
	});
	if (!uploadResult?.id) throw new Error(`Upload did not return an id for ${filePath}`);
	return uploadResult.id;
};

const rewriteHtml = (html, cssUrl, jsUrl) => {
	const withCss = html.replace(/data-arns-css="[^"]*"/, `data-arns-css="${cssUrl}"`);
	const withJs = withCss.replace(/(script\.src = isLocalhost \? "[^"]+" : ")[^"]+(")/, `$1${jsUrl}$2`);
	if (!withJs.includes(cssUrl) || !withJs.includes(jsUrl)) {
		throw new Error("HTML rewrite did not insert the new transaction URLs");
	}
	if (withJs.includes("arweave.zelf.world") || withJs.includes("v3.zelf.world")) {
		throw new Error("HTML still references a retired host");
	}
	return withJs;
};

const upsertEnv = (updates) => {
	const envPath = path.join(root, ".env");
	let text = fs.readFileSync(envPath, "utf8");
	for (const [key, value] of Object.entries(updates)) {
		const line = `${key}=${value}`;
		const pattern = new RegExp(`^${key}=.*$`, "m");
		text = pattern.test(text) ? text.replace(pattern, line) : `${text.trimEnd()}\n${line}\n`;
	}
	fs.writeFileSync(envPath, text);
};

const txUrl = (id) => `https://arweave.net/${id}`;

(async () => {
	assertGatewayEnv();
	console.log(execute ? "EXECUTE — uploading ArNS site bundles" : "DRY RUN — pass --execute to upload");

	const selected = only ? bundles.filter((bundle) => bundle.name === only) : bundles;
	if (!selected.length) throw new Error(`Unknown bundle "${only}"`);

	for (const bundle of selected) {
		const dir = path.join(root, bundle.dir);
		for (const fileName of [bundle.css, bundle.js, bundle.html]) {
			const fullPath = path.join(dir, fileName);
			const bytes = fs.statSync(fullPath).size;
			console.log(`${bundle.name} ${fileName} ${bytes} bytes`);
		}
	}

	if (!execute) return;

	const client = TurboFactory.authenticated({
		privateKey: buildWallet(),
		...productionTurboConfiguration,
	});

	const envUpdates = {};

	for (const bundle of selected) {
		const dir = path.join(root, bundle.dir);
		const cssId = await uploadFile(client, path.join(dir, bundle.css), contentTypes.css);
		const jsId = await uploadFile(client, path.join(dir, bundle.js), contentTypes.js);
		const htmlPath = path.join(dir, bundle.html);
		const rewritten = rewriteHtml(fs.readFileSync(htmlPath, "utf8"), txUrl(cssId), txUrl(jsId));
		fs.writeFileSync(htmlPath, rewritten);
		const htmlId = await uploadFile(client, htmlPath, contentTypes.html);

		envUpdates[bundle.envKey] = htmlId;
		console.log(`${bundle.name} css ${cssId}`);
		console.log(`${bundle.name} js ${jsId}`);
		console.log(`${bundle.name} html ${htmlId}`);
	}

	upsertEnv(envUpdates);
	console.log("Updated .env manifest ids");
})().catch((error) => {
	console.error(error?.message || error);
	process.exit(1);
});
