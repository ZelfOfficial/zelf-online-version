const config = require("../../../Core/config");
const { resolveZelfLink } = require("../../Arweave/modules/arweave-gateway.module");

const NAME_PATTERN = /^[a-z0-9-]{1,63}$/;

/** "name", "name.zelf" or "name.bdag" -> { tagName, domain } */
const parseZelfName = (raw) => {
	const [tagName, domain = "zelf"] = String(raw || "").trim().toLowerCase().split(".");
	if (!NAME_PATTERN.test(tagName || "") || !NAME_PATTERN.test(domain)) return null;
	return { tagName, domain };
};

module.exports = (server) => {
	// Public: 302 to the first gateway that serves the Zelf Link (ar.io first). ?format=json returns the resolution.
	server.get(config.basePath("zelf-link/:zelfName"), async (ctx) => {
		const parsed = parseZelfName(ctx.params.zelfName);
		if (!parsed) {
			ctx.status = 400;
			ctx.body = { error: "invalid_zelf_name" };
			return;
		}
		const result = await resolveZelfLink(parsed.tagName, parsed.domain);
		ctx.set("Cache-Control", "public, max-age=60");
		if (ctx.query.format === "json") {
			ctx.body = { data: { zelfName: `${parsed.tagName}.${parsed.domain}`, ...result } };
			return;
		}
		ctx.redirect(result.url);
	});
};

module.exports.parseZelfName = parseZelfName;
