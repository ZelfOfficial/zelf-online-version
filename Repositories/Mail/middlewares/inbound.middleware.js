const { string, validate } = require("../../../Core/JoiUtils");

const schemas = {
	update: {
		status: string().valid("received", "forwarded", "actioned", "error").optional(),
		action: string().max(100).optional(),
		note: string().max(2000).allow("").optional(),
	},
};

const updateValidation = async (ctx, next) => {
	const valid = validate(schemas.update, ctx.request.body || {});
	if (valid.error) {
		ctx.status = 409;
		ctx.body = { validationError: valid.error.message };
		return;
	}
	await next();
};

module.exports = { updateValidation };
