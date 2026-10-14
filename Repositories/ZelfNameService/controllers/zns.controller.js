const Module = require("../modules/zns.module");
const Modulev2 = require("../modules/zns.v2.module");
const ZNSTokenModule = require("../modules/zns-token.module");
const RevenueCatModule = require("../modules/revenue-cat.module");
const ZelfIdRevenueCatV4 = require("../../ZelfIDRevenueCatV4/zelf-id-revenue-cat-v4.module");
const { updateOldZelfNameObject } = require("../modules/my-zns.module");
const ZNSRecoveryModule = require("../modules/zns-recovery.module");

/**
 * Standard error handler for controllers
 * @param {Object} ctx - Koa context
 * @param {Error} error - Error object
 */
const handleError = (ctx, error) => {
	console.error({ error });
	ctx.status = error.status || 500;
	ctx.body = { error: error.message };
};

/**
 * Handle zelfPay logic for searchZelfName functions
 * @param {Object} data - Search result data
 * @param {Object} user - User object
 * @returns {Object|null} - ZelfPay object or null
 */
const handleZelfPayLogic = async (data, user) => {
	if (!data || !data.available || !data.zelfName.includes("zelfpay")) {
		return null;
	}

	const zelfName = data.zelfName.replace("zelfpay", "zelf");
	const zelfNameData = await Module.searchZelfName({ zelfName }, user);
	const zelfNameObject = zelfNameData.ipfs?.length ? zelfNameData.ipfs[0] : zelfNameData.arweave[0];

	if (zelfNameObject) {
		return await Modulev2.createZelfPay(zelfNameObject, user);
	}

	return null;
};

/**
 * Handle old zelfName object updates
 * @param {Object} data - Search result data
 * @returns {Object} - Updated data
 */
const handleOldZelfNameUpdate = async (data) => {
	if (data && data.ipfs?.length) {
		const zelfNameObject = data.ipfs[0];

		if (!zelfNameObject.publicData.registeredAt) {
			return await updateOldZelfNameObject(zelfNameObject);
		}
	}

	return data;
};

const searchZelfName = async (ctx) => {
	try {
		const data = await Module.searchZelfName(ctx.request.query, ctx.state.user);

		// Handle zelfPay logic
		const zelfPayResult = await handleZelfPayLogic(data, ctx.state.user);

		if (zelfPayResult) {
			ctx.body = { data: zelfPayResult };
			return;
		}

		ctx.body = { data };
	} catch (error) {
		handleError(ctx, error);
	}
};

/**
 * Search for a zelfName
 * @param {Object} ctx - Koa context
 * @returns {Object} - Search results
 */
const searchZelfName_v2 = async (ctx) => {
	try {
		let data = await Modulev2.searchZelfName(ctx.request.query, ctx.state.user);

		// Handle zelfPay logic
		const zelfPayResult = await handleZelfPayLogic(data, ctx.state.user);

		// If zelfPay result is found, return it
		if (zelfPayResult) {
			ctx.body = { data: zelfPayResult };
			return;
		}

		// Handle old zelfName objects update
		data = await handleOldZelfNameUpdate(data);

		ctx.body = { data };
	} catch (error) {
		handleError(ctx, error);
	}
};

const leaseZelfName = async (ctx) => {
	try {
		const data = await Module.leaseZelfName({ ...ctx.request.body, zelfName: `${ctx.request.body.zelfName}`.toLowerCase() }, ctx.state.user);

		ctx.body = { data };
	} catch (error) {
		handleError(ctx, error);
	}
};

const leaseZelfName_v2 = async (ctx) => {
	try {
		const data = await Modulev2.leaseZelfName({ ...ctx.request.body, zelfName: `${ctx.request.body.zelfName}`.toLowerCase() }, ctx.state.user);

		ctx.body = { data };
	} catch (error) {
		handleError(ctx, error);
	}
};

const leaseRecovery = async (ctx) => {
	try {
		const data = await ZNSRecoveryModule.leaseRecovery(
			{ ...ctx.request.body, zelfName: `${ctx.request.body.zelfName}`.toLowerCase() },
			ctx.state.user
		);

		ctx.body = { data };
	} catch (error) {
		handleError(ctx, error);
	}
};

const leaseConfirmation = async (ctx) => {
	try {
		const data = await Modulev2.leaseConfirmation(ctx.request.body, ctx.state.user);

		ctx.body = { data };
	} catch (error) {
		handleError(ctx, error);
	}
};

const leaseConfirmation_v2 = async (ctx) => {
	try {
		const data = await Modulev2.leaseConfirmation(ctx.request.body, ctx.state.user);

		ctx.body = { data };
	} catch (error) {
		handleError(ctx, error);
	}
};

const previewZelfName = async (ctx) => {
	try {
		const data = await Module.previewZelfName(
			{
				...ctx.request.body,
				zelfName: `${ctx.request.body.zelfName}`.toLowerCase(),
			},
			ctx.state.user
		);

		ctx.body = { data };
	} catch (error) {
		handleError(ctx, error);
	}
};

const previewZelfName_v2 = async (ctx) => {
	try {
		const data = await Modulev2.previewZelfName(
			{
				...ctx.request.body,
				zelfName: `${ctx.request.body.zelfName}`.toLowerCase(),
			},
			ctx.state.user
		);

		ctx.body = { data };
	} catch (error) {
		handleError(ctx, error);
	}
};

const previewZelfProof = async (ctx) => {
	try {
		const data = await Module.previewZelfProof(ctx.request.body.zelfProof, ctx.state.user);

		ctx.body = { data };
	} catch (error) {
		handleError(ctx, error);
	}
};

const decryptZelfName = async (ctx) => {
	try {
		const data = await Module.decryptZelfName(
			{
				...ctx.request.body,
				zelfName: `${ctx.request.body.zelfName}`.toLowerCase(),
			},
			ctx.state.user
		);

		ctx.body = { data };
	} catch (error) {
		handleError(ctx, error);
	}
};

const decryptZelfName_v2 = async (ctx) => {
	try {
		const data = await Modulev2.decryptZelfName(
			{
				...ctx.request.body,
				zelfName: `${ctx.request.body.zelfName}`.toLowerCase(),
			},
			ctx.state.user
		);

		ctx.body = { data };
	} catch (error) {
		handleError(ctx, error);
	}
};

const leaseOfflineZelfName = async (ctx) => {
	try {
		const data = await Module.leaseOffline(ctx.request.body, ctx.state.user);

		ctx.body = { data };
	} catch (error) {
		handleError(ctx, error);
	}
};

const leaseOfflineZelfName_v2 = async (ctx) => {
	try {
		ctx.request.body.zelfName = `${ctx.request.body.zelfName}`.toLowerCase();

		const data = await Modulev2.leaseOffline(ctx.request.body, ctx.state.user);

		ctx.body = { data };
	} catch (error) {
		handleError(ctx, error);
	}
};

const revenueCatWebhook = async (ctx) => {
	try {
		// Zelf ID products (Android/iOS) are credited by the v4 handler; everything else stays on v3.
		const data = ZelfIdRevenueCatV4.isZelfIdProductEvent(ctx.request.body?.event)
			? await ZelfIdRevenueCatV4.forwardToV4(ctx.request.body)
			: await RevenueCatModule.webhookHandler(ctx.request.body);

		ctx.body = { data };
	} catch (error) {
		console.error(error);

		ctx.status = error.status || 500;

		ctx.body = { error: error.message };
	}
};

const referralRewards = async (ctx) => {
	try {
		const data = await ZNSTokenModule.releaseReferralRewards(ctx.state.user);

		ctx.body = { data };
	} catch (error) {
		handleError(ctx, error);
	}
};

/**
 * purchase rewards for user
 * @param {Object} ctx
 * @returns {Object} data
 */
const purchaseRewards = async (ctx) => {
	try {
		const data = await ZNSTokenModule.releasePurchaseRewards(ctx.state.user);

		ctx.body = { data };
	} catch (error) {
		handleError(ctx, error);
	}
};

const update = async (ctx) => {
	try {
		const data = await Module.update(ctx.request.body, ctx.state.user);

		ctx.body = { data };
	} catch (error) {
		handleError(ctx, error);
	}
};

module.exports = {
	searchZelfName,
	searchZelfName_v2,
	leaseZelfName,
	leaseZelfName_v2,
	leaseConfirmation,
	leaseConfirmation_v2,
	previewZelfName,
	previewZelfName_v2,
	previewZelfProof,
	decryptZelfName,
	decryptZelfName_v2,
	leaseOfflineZelfName,
	leaseOfflineZelfName_v2,
	revenueCatWebhook,
	referralRewards,
	purchaseRewards,
	update,
	leaseRecovery,
};
