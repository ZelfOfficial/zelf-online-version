const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const config = require("../../../Core/config");

const safeEqual = (a, b) => {
	const x = Buffer.from(String(a));
	const y = Buffer.from(String(b));
	return x.length === y.length && crypto.timingSafeEqual(x, y);
};

/** Accepts `x-api-key: <SUPER_ADMINS_JWT_SECRET>` (same as SuperAdmin routes) or a Bearer JWT signed with it. */
const superAdminKeyValidator = async (ctx, next) => {
	const secret = config.SUPERADMIN_JWT_SECRET;
	if (!secret) {
		ctx.status = 503;
		ctx.body = { error: "super_admin_secret_not_configured" };
		return;
	}

	const apiKey = ctx.headers["x-api-key"];
	if (apiKey && safeEqual(apiKey, secret)) {
		ctx.state.inboundActor = "super-admin-key";
		return next();
	}

	const auth = ctx.headers.authorization || "";
	if (auth.startsWith("Bearer ")) {
		try {
			const decoded = jwt.verify(auth.slice(7), secret);
			ctx.state.inboundActor = decoded?.email || decoded?.superAdminId || "super-admin-jwt";
			return next();
		} catch (_) {
			// fall through
		}
	}

	ctx.status = 403;
	ctx.body = { error: "forbidden" };
};

module.exports = { superAdminKeyValidator };
