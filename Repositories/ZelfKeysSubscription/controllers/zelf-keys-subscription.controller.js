const Module = require("../modules/zelf-keys-subscription.module.js");

const getActiveSubscription = async (ctx) => {
	try {
		const data = await Module.getActiveSubscription(ctx.state.user);

		ctx.status = data?.url ? 200 : 404;
		ctx.body = {
			success: Boolean(data?.url),
			data,
			message: data?.url ? "Active subscription found" : "No active subscription found",
		};
	} catch (error) {
		console.error(error);

		ctx.status = error.status || 500;
		ctx.body = { error: error.message };
	}
};

const getAvailablePlans = async (ctx) => {
	try {
		const data = await Module.getAvailablePlans();

		ctx.status = 200;
		ctx.body = {
			success: true,
			plans: data.plans,
		};
	} catch (error) {
		console.error(error);

		ctx.status = error.status || 500;
		ctx.body = { error: error.message };
	}
};

const createCryptoPayment = async (ctx) => {
	try {
		const data = await Module.createCryptoPayment(ctx.request.body, ctx.state.user);

		ctx.status = 200;
		ctx.body = { data };
	} catch (error) {
		console.error(error);

		ctx.status = error.status || 500;
		ctx.body = { error: error.message };
	}
};

const confirmCryptoPayment = async (ctx) => {
	try {
		const data = await Module.confirmCryptoPayment(ctx.request.body, ctx.state.user);

		ctx.status = 200;
		ctx.body = {
			success: data.success,
			paymentConfirmed: data.paymentConfirmed,
			transactionHash: data.transactionHash,
			subscriptionCreated: data.subscriptionCreated,
			message: data.message,
		};
	} catch (error) {
		console.error("Error confirming crypto payment:", error);

		ctx.status = error.status || 500;
		ctx.body = {
			success: false,
			error: error.message,
			paymentConfirmed: false,
		};
	}
};

module.exports = {
	getActiveSubscription,
	getAvailablePlans,
	createCryptoPayment,
	confirmCryptoPayment,
};
