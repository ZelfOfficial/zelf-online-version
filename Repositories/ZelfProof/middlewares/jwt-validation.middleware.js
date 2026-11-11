const IPFSModule = require("../../IPFS/modules/ipfs.module");
const { isAccountAccessToken } = require("../../../Core/jwt-claims");

/**
 * JWT Validation Middleware
 * Validates JWT token and queries account via email from IPFS
 * @param {Object} ctx - Koa context
 * @param {Function} next - Next middleware function
 */
const jwtValidation = async (ctx, next) => {
	try {
		// Get the authenticated user from JWT
		const authUser = ctx.state.user;

		// Check if user exists in JWT
		if (!authUser || !authUser.email || !isAccountAccessToken(authUser)) {
			ctx.status = 401;
			ctx.body = {
				error: "Invalid JWT token - missing user email",
				validationError: "Authentication required",
			};
			return;
		}

		// Query account via email from IPFS
		const emailRecord = await IPFSModule.get({
			key: "accountEmail",
			value: authUser.email,
		});

		// Check if account exists in IPFS
		if (!emailRecord || emailRecord.length === 0) {
			ctx.status = 404;
			ctx.body = {
				error: "Account not found",
				validationError: `No account found for email: ${authUser.email}`,
			};
			return;
		}

		// Get the account data
		const accountData = emailRecord[0];

		// Add account data to context for use in subsequent middleware/controllers
		ctx.state.accountData = accountData;
		ctx.state.accountEmail = authUser.email;

		// Continue to next middleware
		await next();
	} catch (error) {
		console.error("JWT Validation Middleware Error:", error);

		// Handle specific error types
		if (error.status === 412) {
			ctx.status = 412;
			ctx.body = {
				error: "Invalid query conditions",
				validationError: "Unable to query account data",
			};
		} else if (error.status === 404) {
			ctx.status = 404;
			ctx.body = {
				error: "Account not found",
				validationError: `No account found for email: ${ctx.state.user?.email || "unknown"}`,
			};
		} else {
			ctx.status = 500;
			ctx.body = {
				error: "Internal server error",
				validationError: "Failed to validate account",
			};
		}
	}
};

module.exports = {
	jwtValidation,
};
