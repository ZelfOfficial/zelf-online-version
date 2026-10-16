const config = require("../../../Core/config");
const gateway = require("../../Arweave/modules/arweave-gateway.module");

const NAME_PATTERN = /^[a-z0-9-]{1,63}$/;

/** "name", "name.zelf" or "name.bdag" -> { tagName, domain } */
const parseZelfName = (raw) => {
	const [tagName, domain = "zelf"] = String(raw || "").trim().toLowerCase().split(".");
	if (!NAME_PATTERN.test(tagName || "") || !NAME_PATTERN.test(domain)) return null;
	return { tagName, domain };
};

const notFoundPage = (zelfName) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${zelfName} not found</title>
<style>body{font-family:system-ui,sans-serif;background:#0b0b10;color:#f4f4f7;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;text-align:center}a{color:#8b7cff}</style>
</head><body><main><h1>${zelfName}</h1><p>This Zelf Link isn't published yet. If it was just created, try again in a few minutes.</p>
<p><a href="https://zelf.world">Get your own Zelf ID at zelf.world</a></p></main></body></html>`;

module.exports = (server) => {
	// Public: 302 to the first gateway that serves the Zelf Link (ar.io first). ?format=json returns the resolution.
	server.get(config.basePath("zelf-link/:zelfName"), async (ctx) => {
		const parsed = parseZelfName(ctx.params.zelfName);
		if (!parsed) {
			ctx.status = 400;
			ctx.body = { error: "invalid_zelf_name" };
			return;
		}
		const zelfName = `${parsed.tagName}.${parsed.domain}`;
		const result = await gateway.resolveZelfLink(parsed.tagName, parsed.domain);
		const wantsJson = ctx.query.format === "json";

		if (!result.resolved) {
			// No gateway serves it: never redirect the user to a gateway 404.
			ctx.status = 404;
			ctx.set("Cache-Control", "no-store");
			if (wantsJson) {
				ctx.body = { error: "zelf_link_not_found", data: { zelfName, ...result } };
				return;
			}
			ctx.type = "html";
			ctx.body = notFoundPage(zelfName);
			return;
		}

		ctx.set("Cache-Control", "public, max-age=60");
		if (wantsJson) {
			ctx.body = { data: { zelfName, ...result } };
			return;
		}
		ctx.redirect(result.url);
	});
};

module.exports.parseZelfName = parseZelfName;
module.exports.notFoundPage = notFoundPage;
