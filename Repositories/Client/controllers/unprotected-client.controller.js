const Module = require("../modules/client.module");
const { errorHandler } = require("../../../Core/http-handler");

const create = async (ctx) => {
	try {
		const data = await Module.create(ctx.request.body);

		ctx.body = { data };
	} catch (error) {
		const _exception = errorHandler(error);

		ctx.status = _exception.status || 500;

		ctx.body = {
			code: _exception.code,
			message: _exception.message,
		};
	}
};

const auth = async (ctx) => {
	try {
		const data = await Module.auth(ctx.request.body);

		ctx.body = { data };
	} catch (error) {
		const _exception = errorHandler(error, ctx);

		ctx.status = _exception.status || 500;

		ctx.body = {
			code: _exception.code,
			message: _exception.message,
		};
	}
};

module.exports = {
	create,
	auth,
};
