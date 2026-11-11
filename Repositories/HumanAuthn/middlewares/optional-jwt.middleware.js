const jwt = require("jsonwebtoken");
const config = require("../../../Core/config");
const { isAcceptedAccessToken } = require("../../../Core/jwt-claims");

/**
 * Extract JWT from request (mirrors server.js koa-jwt getToken).
 * @param {import("koa").Context} ctx
 * @returns {string|null}
 */
const extractToken = (ctx) => {
	const indexOfToken = ctx.headers?.authorization?.indexOf("ey");

	if (indexOfToken !== -1) {
		return ctx.headers.authorization?.substring(indexOfToken);
	}

	if (ctx.headers?.authorization?.startsWith("JWT") || ctx.headers?.authorization?.startsWith("Bearer")) {
		return ctx.headers.authorization?.split(" ")[1];
	}

	const token = ctx.request.query?.token || ctx.request?.body?.token;

	if (!token) {
		return null;
	}

	const nestedIndex = token.indexOf("ey");

	if (nestedIndex !== -1) {
		return token.substring(nestedIndex);
	}

	return null;
};

/**
 * Attach ctx.state.user when a valid Bearer token is present.
 * Does not reject missing/invalid tokens — HumanAuthn routes stay usable without auth.
 */
const optionalJwt = async (ctx, next) => {
	try {
		const token = extractToken(ctx);

		if (token) {
			const decoded = jwt.verify(token, config.JWT_SECRET);
			if (isAcceptedAccessToken(decoded, ctx)) {
				ctx.state.user = decoded;
			}
		}
	} catch (error) {
		// Proceed without authenticated user
	}

	await next();
};

module.exports = {
	optionalJwt,
	extractToken,
};
