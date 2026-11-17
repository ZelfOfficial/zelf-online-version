const Module = require("../modules/client.module");
const { errorHandler, codedError } = require("../../../Core/http-handler");

const get = async (ctx) => {
	try {
		const data = await Module.get(ctx.request.query, ctx.state.user);

		if (!data) throw codedError("404:CLIENT_NOT_FOUND");

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

const show = async (ctx) => {
	try {
		const data = await Module.show(ctx.request.params, ctx.state.user);

		if (!data) throw new Error("404:client_not_found");

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

const create = async (ctx) => {
	try {
		const data = await Module.create(ctx.request.body);

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

const auth = async (ctx) => {
	try {
		const data = await Module.auth(
			{
				...ctx.request.body,
				apiKey: ctx.headers["x-api-key"] || ctx.request.body.apiKey,
			},
			ctx.state.user
		);

		ctx.body = data;
	} catch (error) {
		const _exception = errorHandler(error, ctx);

		ctx.status = _exception.status || 500;

		ctx.body = {
			code: _exception.code,
			message: _exception.message,
		};
	}
};

const update = async (ctx) => {
	try {
		const data = await Module.update(ctx.request.body, ctx.state.user);

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

const destroy = async (ctx) => {
	try {
		const data = await Module.destroy(ctx.request.body, ctx.state.user);

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

const updatePassword = async (ctx) => {
	try {
		const data = await Module.updatePassword(ctx.request.body, ctx.state.user);

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
	get,
	show,
	create,
	update,
	destroy,
	auth,
	updatePassword,
};
