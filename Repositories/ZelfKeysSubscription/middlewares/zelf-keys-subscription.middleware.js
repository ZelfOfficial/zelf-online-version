const validateUserIdentifier = async (ctx, next) => {
	const { identifier } = ctx.state.user || {};

	if (!identifier) {
		ctx.status = 400;
		ctx.body = {
			error: "ZelfName identifier is required",
		};

		return;
	}

	await next();
};

module.exports = {
	validateUserIdentifier,
};
