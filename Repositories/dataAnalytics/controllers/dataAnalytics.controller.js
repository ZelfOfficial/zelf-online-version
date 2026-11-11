const Module = require("../modules/dataAnalytics.module");

/**
 * Log a short error message instead of dumping full error objects (avoids huge Axios dumps)
 * @param {string} context - e.g. "chart_data", "data_analytics"
 * @param {Error} error
 */
const logError = (context, error) => {
	const status = error.response?.status || error.status;
	const msg =
		error.response?.data?.msg ?? error.message ?? "Unknown error";
	// Truncate long API messages (e.g. Binance "Illegal characters...legal range is '^[A-Z...'")
	const shortMsg = msg.length > 80 ? msg.slice(0, 77) + "..." : msg;
	console.error(`[${context}] ${status || "Error"}: ${shortMsg}`);
};

const data_analytics = async (ctx) => {
	try {
		const data = await Module.getAssetDetails({ ...ctx.params, ...ctx.query });

		ctx.body = { data };
	} catch (error) {
		logError("data_analytics", error);
		if (error.clientCode) {
			ctx.status = error.status || 400;
			ctx.body = { code: error.clientCode, message: error.clientMessage || error.clientCode };
			return;
		}
		ctx.status = error.response?.status ?? error.status ?? 500;
		ctx.body = { error: error.message };
	}
};

const chart_data = async (ctx) => {
	try {
		const data = await Module.getChart({ ...ctx.params, ...ctx.query });

		ctx.body = { data };
	} catch (error) {
		logError("chart_data", error);
		if (error.clientCode) {
			ctx.status = error.status || 400;
			ctx.body = { code: error.clientCode, message: error.clientMessage || error.clientCode };
			return;
		}
		ctx.status = error.response?.status ?? error.status ?? 500;
		ctx.body = { error: error.message };
	}
};

module.exports = {
	data_analytics,
	chart_data,
};
