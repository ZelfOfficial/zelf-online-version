const Module = require("../modules/wallet.module");
const SessionModule = require("../../Session/modules/session.module");

/**
 * @param {*} request
 * @param {*} response
 */
const get = async (ctx) => {
	try {
		const data = await Module.get(ctx.request.params, ctx.state.user);

		const responseBody = {
			data: data.docs ? data.docs : data,
			total: data.total,
			limit: data.limit,
			page: data.page,
			pages: data.pages,
		};

		ctx.body = responseBody;
	} catch (error) {
		console.error(error);

		ctx.status = error.status || 500;

		ctx.body = { error: error.message };
	}
};

/**
 * @param {*} request
 * @param {*} response
 */
const show = async (ctx) => {
	try {
		const data = await Module.show(ctx.request.params, ctx.state.user);

		ctx.body = { data };
	} catch (error) {
		console.error(error);
		ctx.status = error.status || 500;

		ctx.body = { error: error.message };
	}
};

/**
 * @param {*} request - restify request
 * @param {*} response - restify response
 */
const create = async (ctx) => {
	try {
		const data = await Module.insert(ctx.request.body, ctx.state.user);
		// delete the session
		await SessionModule.deleteSession(ctx.state.user);

		ctx.body = { data };
	} catch (error) {
		console.error({ error });

		ctx.status = error.status || 500;

		ctx.body = { error: error.message };
	}
};

/**
 * decrypt wallet
 * @param {Object} request
 * @param {Object} response
 * @param {Object} next
 * @author Miguel Trevino
 */
const decryptWallet = async (ctx) => {
	try {
		const data = await Module.decryptWallet(ctx.request.body, ctx.state.user);

		ctx.body = { data };
	} catch (error) {
		console.error(error);

		ctx.status = error.status || 500;

		await SessionModule.deleteSession(ctx.state.user);

		ctx.body = { error: error.message };
	}
};

/**
 * validate a zkProof
 * @param {Object} ctx
 */
const zkProof = async (ctx) => {
	try {
		const data = await Module.validateZkProof(ctx.request.body, ctx.state.user);

		await SessionModule.deleteSession(ctx.state.user);

		ctx.body = { data };
	} catch (error) {
		console.error(error);

		ctx.status = error.status || 500;

		await SessionModule.deleteSession(ctx.state.user);

		ctx.body = { error: error.message };
	}
};

/**
 * See wallet
 * @param {Object} request
 * @param {Object} response
 * @param {Object} next
 * @author Miguel Trevino
 */
const seeWallet = async (ctx) => {
	try {
		const data = await Module.seeWallet(ctx.request.body, ctx.state.user);

		// delete the session
		await SessionModule.deleteSession(ctx.state.user);

		ctx.body = { data };
	} catch (error) {
		console.error(error);

		ctx.status = error.status || 500;

		ctx.body = { error: error.message };
	}
};

const importWallet = async (ctx) => {
	try {
		const data = await Module.importWallet(ctx.request.body, ctx.state.user);

		ctx.body = { data };
	} catch (error) {
		console.error({ error });

		ctx.status = error.status || 500;

		ctx.body = { error: error.message };
	}
};

const searchOpenWallets = async (ctx) => {
	try {
		const data = await Module.searchOpenWallets(ctx.request.query);

		ctx.body = { data };
	} catch (error) {
		console.error(error);

		ctx.status = error.status || 500;

		ctx.body = { error: error.message };
	}
};

const ipfsUpload = async (ctx) => {
	try {
		const data = await Module.ipfsUpload(ctx.request.body, ctx.state.user);

		ctx.body = { data };
	} catch (error) {
		console.error(error);

		ctx.status = error.status || 500;

		ctx.body = { error: error.message };
	}
};

module.exports = {
	get,
	show,
	create,
	decryptWallet,
	seeWallet,
	importWallet,
	searchOpenWallets,
	ipfsUpload,
	zkProof,
};
