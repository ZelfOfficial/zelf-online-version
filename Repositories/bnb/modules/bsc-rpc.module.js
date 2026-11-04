// JSON-RPC transport for BNB Smart Chain with short timeouts and ordered fallbacks.
// Primary: BSC_RPC_URL (paid QuickNode). Fallbacks: BSC_FALLBACK_RPC_URLS (comma list) or the public BNB Chain endpoints
// (documented limit 10K requests / 5 min per IP; we send at most one request per balance lookup).

require("dotenv").config();

const { getCleanInstance } = require("../../../Core/axios");

const DEFAULT_PUBLIC_RPCS = ["https://bsc-dataseed.bnbchain.org", "https://bsc-rpc.publicnode.com", "https://bsc-dataseed1.defibit.io"];
const RPC_TIMEOUT_MS = Number(process.env.BSC_RPC_TIMEOUT_MS || 2500);

const instance = getCleanInstance(RPC_TIMEOUT_MS);

const getRpcUrls = () => {
	const fallbacks = (process.env.BSC_FALLBACK_RPC_URLS || "")
		.split(",")
		.map((u) => u.trim())
		.filter(Boolean);

	return [...new Set([process.env.BSC_RPC_URL, ...(fallbacks.length ? fallbacks : DEFAULT_PUBLIC_RPCS)].filter(Boolean))];
};

/** Host only, so logs never carry a provider key embedded in the URL path. */
const redactRpcUrl = (url) => {
	try {
		return new URL(url).host;
	} catch (_) {
		return "invalid-url";
	}
};

/**
 * Send one JSON-RPC request; try each endpoint in order until one returns a result.
 * @param {string} method
 * @param {Array} params
 * @returns {Promise<{ result: any, rpc: string }>}
 */
const rpcCall = async (method, params) => {
	const errors = [];

	for (const url of getRpcUrls()) {
		try {
			const { data } = await instance.post(url, { jsonrpc: "2.0", id: 1, method, params }, { headers: { "Content-Type": "application/json" }, timeout: RPC_TIMEOUT_MS });

			if (data && data.result !== undefined && !data.error) return { result: data.result, rpc: redactRpcUrl(url) };

			errors.push(`${redactRpcUrl(url)}: ${data?.error?.message || "empty_result"}`);
		} catch (error) {
			errors.push(`${redactRpcUrl(url)}: ${error?.code || error?.message || "error"}`);
		}
	}

	const error = new Error(`bsc_rpc_unavailable (${errors.join("; ")})`);

	error.status = 503;

	throw error;
};

module.exports = { rpcCall, getRpcUrls, redactRpcUrl, DEFAULT_PUBLIC_RPCS, RPC_TIMEOUT_MS };
