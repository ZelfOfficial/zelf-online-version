const Module = require("../modules/ipfs.module");

const get = async (ctx) => {
	try {
		const data = await Module.get(ctx.request.query, ctx.state.user, { restrictToCaller: true });

		ctx.body = { data };
	} catch (error) {
		console.error(error);
		ctx.status = error.status || 500;

		ctx.body = { error: error.message };
	}
};

/**
 * show a single IPFS via cid
 * @param {Object} ctx
 * @author Miguel Trevino
 */
const show = async (ctx) => {
	try {
		const data = await Module.show(ctx.request.params, ctx.state.user);

		ctx.body = { data };
	} catch (error) {
		ctx.status = error.status || 500;

		ctx.body = { error: error.message };
	}
};

/**
 * upload an IPFS file - i.e a wallet in base64 qrCode
 * @param {Object} ctx
 */
const create = async (ctx) => {
	try {
		const data = await Module.insert(ctx.request.body, ctx.state.user);

		ctx.body = { data };
	} catch (error) {
		console.error({ error });

		ctx.status = error.status || 500;

		ctx.body = { error: error.message };
	}
};

const destroy = async (ctx) => {
	try {
		const data = await Module.destroy(ctx.request.params, ctx.state.user);

		ctx.body = { data };
	} catch (error) {
		console.error({ error });

		ctx.status = error.status || 500;

		ctx.body = { error: error.message };
	}
};

module.exports = {
	get,
	show,
	create,
	destroy,
};
