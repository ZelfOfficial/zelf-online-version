/**
 * ZelfKey Controller - Handles HTTP requests for password manager operations
 * @author Miguel Trevino <miguel@zelf.world>
 */

const Module = require("../modules/zelf-key.module.js");
const { errorHandler } = require("../../../Core/http-handler");

/**
 * Store website password specifically
 * @param {Object} ctx - Koa context
 */
const storePassword = async (ctx) => {
	try {
		const data = await Module.storeData(
			{
				...ctx.request.body,
				type: "password",
			},
			ctx.state.user
		);

		ctx.body = { data };
	} catch (error) {
		const _exception = errorHandler(error, ctx);

		ctx.status = _exception.status;

		ctx.body = { message: _exception.message, code: _exception.code };
	}
};

/**
 * Bulk store website passwords with one face + masterPassword verification
 * @param {Object} ctx - Koa context
 */
const storePasswordsBulk = async (ctx) => {
	try {
		const data = await Module.storePasswordsBulk(ctx.request.body, ctx.state.user);

		ctx.body = { data };
	} catch (error) {
		const _exception = errorHandler(error, ctx);

		ctx.status = _exception.status;

		ctx.body = { message: _exception.message, code: _exception.code };
	}
};

/**
 * Store ZOTP
 * @param {Object} ctx - Koa context
 */
const storeZOTP = async (ctx) => {
	try {
		const data = await Module.storeData(
			{
				...ctx.request.body,
				type: "zotp",
			},
			ctx.state.user
		);

		ctx.body = { data };
	} catch (error) {
		const _exception = errorHandler(error, ctx);

		ctx.status = _exception.status;

		ctx.body = { message: _exception.message, code: _exception.code };
	}
};

/**
 * Store notes as key-value pairs
 * @param {Object} ctx - Koa context
 */
const storeNotes = async (ctx) => {
	try {
		const data = await Module.storeData(
			{
				...ctx.request.body,
				type: "notes",
			},
			ctx.state.user
		);

		ctx.body = { data };
	} catch (error) {
		const _exception = errorHandler(error, ctx);

		ctx.status = _exception.status;

		ctx.body = { message: _exception.message, code: _exception.code };
	}
};

/**
 * Store credit card information
 * @param {Object} ctx - Koa context
 */
const storeCreditCard = async (ctx) => {
	try {
		const data = await Module.storeData(
			{
				...ctx.request.body,
				type: "credit_card",
			},
			ctx.state.user
		);

		ctx.body = { data };
	} catch (error) {
		const _exception = errorHandler(error, ctx);

		ctx.status = _exception.status;

		ctx.body = { message: _exception.message, code: _exception.code };
	}
};

/**
 * Retrieve stored data (decrypt)
 * @param {Object} ctx - Koa context
 */
const retrieveData = async (ctx) => {
	try {
		const data = await Module.retrieveData(ctx.request.body, ctx.state.user);

		ctx.body = { data };
	} catch (error) {
		const _exception = errorHandler(error, ctx);

		ctx.status = _exception.status;

		ctx.body = { message: _exception.message, code: _exception.code };
	}
};

/**
 * Preview stored data without full decryption
 * @param {Object} ctx - Koa context
 */
const previewData = async (ctx) => {
	try {
		const data = await Module.previewData(ctx.request.body, ctx.state.user);

		ctx.body = { data };
	} catch (error) {
		const _exception = errorHandler(error, ctx);

		ctx.status = _exception.status;

		ctx.body = { message: _exception.message, code: _exception.code };
	}
};

/**
 * List data by category
 * @param {Object} ctx - Koa context
 */
const getProof = async (ctx) => {
	try {
		const data = await Module.getProof(ctx.request.query, ctx.state.user);

		ctx.body = { data };
	} catch (error) {
		const _exception = errorHandler(error, ctx);

		ctx.status = _exception.status;

		ctx.body = { message: _exception.message, code: _exception.code };
	}
};

const listData = async (ctx) => {
	try {
		const data = await Module.listData(ctx.request.query, ctx.state.user);

		ctx.body = { data };
	} catch (error) {
		const _exception = errorHandler(error, ctx);

		ctx.status = _exception.status;

		ctx.body = { message: _exception.message, code: _exception.code };
	}
};

/**
 * List all data across all categories
 * @param {Object} ctx - Koa context
 */
const listAllData = async (ctx) => {
	try {
		const data = await Module.listAllData(ctx.request.query, ctx.state.user);

		ctx.body = { data };
	} catch (error) {
		const _exception = errorHandler(error, ctx);

		ctx.status = _exception.status;

		ctx.body = { message: _exception.message, code: _exception.code };
	}
};

/**
 * List data by category (dashboard) - requires identifier
 * @param {Object} ctx - Koa context
 */
const listDataDashboard = async (ctx) => {
	try {
		const { identifier, category } = ctx.request.query;
		const data = await Module.listDataForDashboard(identifier, category, ctx.state.user);

		ctx.body = { data };
	} catch (error) {
		const _exception = errorHandler(error, ctx);

		ctx.status = _exception.status;

		ctx.body = { message: _exception.message, code: _exception.code };
	}
};

/**
 * List all data across all categories (dashboard) - requires identifier
 * @param {Object} ctx - Koa context
 */
const listAllDataDashboard = async (ctx) => {
	try {
		const { identifier } = ctx.request.query;
		const data = await Module.listAllDataForDashboard(identifier, ctx.state.user);

		ctx.body = { data };
	} catch (error) {
		const _exception = errorHandler(error, ctx);

		ctx.status = _exception.status;

		ctx.body = { message: _exception.message, code: _exception.code };
	}
};

/**
 * Count-only IPFS summary across ZelfKeys categories
 * @param {Object} ctx - Koa context
 */
const summarizeData = async (ctx) => {
	try {
		const data = await Module.summarizeData(ctx.request.query, ctx.state.user);

		ctx.body = { data };
	} catch (error) {
		const _exception = errorHandler(error, ctx);

		ctx.status = _exception.status;

		ctx.body = { message: _exception.message, code: _exception.code };
	}
};

/**
 * Delete ZelfKey
 * @param {Object} ctx - Koa context
 */
const deleteZelfKey = async (ctx) => {
	try {
		const data = await Module.deleteZelfKey(
			{
				id: ctx.request.params.id,
				faceBase64: ctx.request.body.faceBase64,
				masterPassword: ctx.request.body.masterPassword,
				removePGP: ctx.request.body.removePGP,
			},
			ctx.state.user
		);

		ctx.body = { data };
	} catch (error) {
		const _exception = errorHandler(error, ctx);

		ctx.status = _exception.status;

		ctx.body = { message: _exception.message, code: _exception.code };
	}
};

module.exports = {
	storePassword,
	storePasswordsBulk,
	storeZOTP,
	storeNotes,
	storeCreditCard,
	retrieveData,
	previewData,
	getProof,
	listData,
	listAllData,
	listDataDashboard,
	listAllDataDashboard,
	summarizeData,
	deleteZelfKey,
};
