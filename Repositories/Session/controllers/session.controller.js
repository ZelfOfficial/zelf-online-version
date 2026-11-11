const Module = require("../modules/session.module");
// const HttpHandler = require("../../../Core/http-handler");

/**
 * @param {*} request
 * @param {*} response
 * @param {*} next
 */
const get = async (request, response) => {
	// try {
	// 	const data = await Module.get(request.params, request.user);
	// 	const responseBody = {
	// 		data: data.docs ? data.docs : data,
	// 		total: data.total,
	// 		limit: data.limit,
	// 		page: data.page,
	// 		pages: data.pages,
	// 	};
	// 	ctx.send(responseBody);
	// } catch (error) {
	// 	console.error(error);
	// 	const { code, message } = HttpHandler.errorHandler(error);
	// 	ctx.send(code, message);
	// }
};

/**
 * @param {*} request
 * @param {*} response
 */
const show = async (request, response) => {
	// try {
	// 	const data = await Module.show(request.params, request.user);
	// 	ctx.send({
	// 		data,
	// 	});
	// } catch (error) {
	// 	console.error(error);
	// 	const { code, message } = HttpHandler.errorHandler(error);
	// 	ctx.send(code, message);
	// }
};

/**
 * @param {*} request - restify request
 * @param {*} response - restify response
 */
const create = async (ctx) => {
	try {
		const origin = ctx.request.header.origin || null;
		const referer = ctx.request.header.referer || null;
		const clientIp = ctx.request.ip;
		const userAgent = ctx.request.header["user-agent"] || null;

		const forwardedFor = ctx.request.header["x-forwarded-for"] || "No X-Forwarded-For header";

		console.log(`Request Details: 
			Origin: ${origin}
			Referer: ${referer}
			Client IP: ${clientIp}
			User Agent: ${userAgent}
			X-Forwarded-For: ${forwardedFor}
		`);

		if (process.env.NODE_ENV === "production" && (!origin || !clientIp)) {
			ctx.status = 403;

			ctx.body = { error: "rejected" };

			return;
		}

		const claims = Module.presentedSessionClaims(ctx.get("authorization"), ctx.state.user);
		const data = await Module.insert({ ...ctx.request.body, clientIP: clientIp }, claims);

		ctx.body = { data };
	} catch (error) {
		console.error({ error });

		ctx.status = error.status || 500;

		if (error.clientCode) {
			ctx.body = { error: error.clientCode, code: error.clientCode };
			return;
		}

		ctx.body = { error: error.message };
	}
};

/**
 * @param {*} request - restify request
 * @param {*} response - restify response
 */
const update = async (request, response) => {
	// try {
	// 	await Module.update(request.params, request.user);
	// 	ctx.send({
	// 		status: "completed",
	// 	});
	// } catch (error) {
	// 	console.error(error);
	// 	const { code, message } = HttpHandler.errorHandler(error);
	// 	ctx.send(code, message);
	// }
};

/**
 * @param {*} request - restify request
 * @param {*} response - restify response
 */
const destroy = async (request, response) => {
	// try {
	// 	await Module.destroy(request.params, request.user);
	// 	ctx.send({
	// 		status: "completed",
	// 	});
	// } catch (error) {
	// 	console.error(error);
	// 	const { code, message } = HttpHandler.errorHandler(error);
	// 	ctx.send(code, message);
	// }
};

const getPublicKey = async (ctx) => {
	try {
		const clientIP = ctx.request.ip;
		const { identifier, name, email } = ctx.request.query;

		const data = await Module.extractPublicKey({ identifier, clientIP, name, email });

		ctx.body = { data };
	} catch (error) {
		console.error({ error });

		ctx.status = error?.status || 500;

		ctx.body = { error: error?.message || error };
	}
};

const decryptContent = async (ctx) => {
	try {
		const data = await Module.decryptContent(ctx.request.body);

		ctx.body = { data };
	} catch (error) {
		ctx.status = error.status || 500;

		ctx.body = { error: error.message };
	}
};

module.exports = {
	get,
	show,
	create,
	update,
	destroy,
	getPublicKey,
	decryptContent,
};
