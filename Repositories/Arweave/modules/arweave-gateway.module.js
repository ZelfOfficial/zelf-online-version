const axios = require("axios");
const config = require("../../../Core/config");

const EXPLORER_URL = "https://viewblock.io/arweave/tx";

/** Max wait for Arweave GraphQL / gateway HTTP (axios), in ms */
const ARWEAVE_HTTP_TIMEOUT_MS = 10_000;

/** Tag keys that resolve to a single tag — legacy query is faster and sufficient */
const SINGLE_TAG_LOOKUP_KEYS = new Set(["tagName", "zelfName"]);

const _normalizeGatewayBase = (url) => String(url || "").trim().replace(/\/+$/, "");

const _parseGatewayList = (raw) => {
	if (Array.isArray(raw)) {
		const parsed = raw.map(_normalizeGatewayBase).filter(Boolean);
		return parsed.length ? parsed : _fallbackGraphqlGateways();
	}
	if (!raw || typeof raw !== "string") return _fallbackGraphqlGateways();
	const parsed = raw.split(",").map(_normalizeGatewayBase).filter(Boolean);
	return parsed.length ? parsed : _fallbackGraphqlGateways();
};

const _fallbackGraphqlGateways = () =>
	_parseGatewayList(config.arwave?.graphqlGateways || config.arwave?.publicGatewayUrl || "https://arweave.net");

const getGraphqlGateways = () => _parseGatewayList(config.arwave.graphqlGateways);

const getPublicGatewayUrl = () =>
	_normalizeGatewayBase(config.arwave.publicGatewayUrl || "https://arweave.net");

const getArnsGatewayHost = () => {
	const host = String(config.arwave.arnsGatewayHost || "arweave.net").trim();
	return host.replace(/^https?:\/\//, "").replace(/\/+$/, "");
};

const getExplorerUrl = () => EXPLORER_URL;

const buildTxUrl = (txId) => `${getPublicGatewayUrl()}/${txId}`;

const buildExplorerUrl = (txId) => `${EXPLORER_URL}/${txId}`;

/**
 * Build ARNS undername URL on the configured gateway host.
 * @param {string} tagName
 * @param {string} domain
 * @returns {string}
 */
const buildArnsUndernameUrl = (tagName, domain) => {
	const host = getArnsGatewayHost();
	const recordKey = domain === "zelf" ? `${tagName}_zelf` : `${tagName}_${domain}_zelf`;
	return `https://${recordKey}.${host}`;
};

const isSingleTagLookupKey = (key) => SINGLE_TAG_LOOKUP_KEYS.has(key);

/**
 * POST GraphQL to a single gateway.
 * @param {string} gatewayBase
 * @param {string} queryString
 * @returns {Promise<Array|undefined>} transactions.edges
 */
const postGraphqlToGateway = async (gatewayBase, queryString) => {
	const graphqlUrl = `${_normalizeGatewayBase(gatewayBase)}/graphql`;
	const result = await axios.post(
		graphqlUrl,
		{ query: queryString },
		{
			headers: { "Content-Type": "application/json" },
			timeout: ARWEAVE_HTTP_TIMEOUT_MS,
		}
	);

	if (result.data?.errors?.length) {
		const msg = result.data.errors.map((e) => e.message).join("; ");
		const err = new Error(msg);
		err.graphqlErrors = result.data.errors;
		throw err;
	}

	return result.data?.data?.transactions?.edges;
};

/**
 * Try ranked GraphQL gateways in order until one succeeds.
 * @param {string} queryString
 * @returns {Promise<Array|undefined>} transactions.edges
 */
const postGraphql = async (queryString) => {
	const gateways = getGraphqlGateways();
	let lastError = null;

	for (let index = 0; index < gateways.length; index++) {
		const gatewayBase = gateways[index];
		try {
			return await postGraphqlToGateway(gatewayBase, queryString);
		} catch (error) {
			lastError = error;
			console.warn("Arweave GraphQL failed on gateway:", gatewayBase, error?.message || error);
		}
	}

	throw lastError || new Error("All Arweave GraphQL gateways failed");
};

const CONTENT_REDIRECT_LIMIT = 5;

const _redirectLocation = (response, currentUrl) => {
	const location = response?.headers?.location || response?.headers?.Location;
	if (!location || typeof location !== "string") return null;

	try {
		return new URL(location, currentUrl).toString();
	} catch (_error) {
		return null;
	}
};

/**
 * Fetch raw transaction bytes from the public gateway, then fall back to GraphQL pool.
 * arweave.net often answers 302; those hops are followed up to CONTENT_REDIRECT_LIMIT.
 * @param {string} txId
 * @returns {Promise<ArrayBuffer|null>}
 */
const fetchTxData = async (txId) => {
	const fetchFromBase = async (baseUrl) => {
		let url = `${_normalizeGatewayBase(baseUrl)}/${txId}`;

		for (let hop = 0; hop <= CONTENT_REDIRECT_LIMIT; hop++) {
			const response = await axios.get(url, {
				responseType: "arraybuffer",
				timeout: ARWEAVE_HTTP_TIMEOUT_MS,
				// arweave.net answers 302. Follow it instead of treating the redirect as an empty body.
				maxRedirects: CONTENT_REDIRECT_LIMIT,
				validateStatus: (status) => status >= 200 && status < 400,
			});

			if (response.status >= 300 && response.status < 400) {
				const nextUrl = _redirectLocation(response, url);
				if (!nextUrl || hop === CONTENT_REDIRECT_LIMIT) return null;
				url = nextUrl;
				continue;
			}

			if (response?.data && response.data.byteLength > 0) return response.data;
			return null;
		}

		return null;
	};

	try {
		const primary = await fetchFromBase(getPublicGatewayUrl());
		if (primary) return primary;
	} catch (error) {
		console.warn("Arweave tx fetch failed on public gateway:", error?.message || error);
	}

	for (let index = 0; index < getGraphqlGateways().length; index++) {
		const gatewayBase = getGraphqlGateways()[index];
		if (gatewayBase === getPublicGatewayUrl()) continue;
		try {
			const fallback = await fetchFromBase(gatewayBase);
			if (fallback) return fallback;
		} catch (error) {
			console.warn("Arweave tx fetch failed on gateway:", gatewayBase, error?.message || error);
		}
	}

	return null;
};

/**
 * Fetch transaction as a PNG data URL.
 * @param {string} txId
 * @returns {Promise<string|null>}
 */
const fetchTxAsBase64Png = async (txId) => {
	const data = await fetchTxData(txId);
	if (!data) return null;
	const base64Image = Buffer.from(data).toString("base64");
	return `data:image/png;base64,${base64Image}`;
};

module.exports = {
	ARWEAVE_HTTP_TIMEOUT_MS,
	getGraphqlGateways,
	getPublicGatewayUrl,
	getArnsGatewayHost,
	getExplorerUrl,
	buildTxUrl,
	buildExplorerUrl,
	buildArnsUndernameUrl,
	isSingleTagLookupKey,
	postGraphqlToGateway,
	postGraphql,
	fetchTxData,
	fetchTxAsBase64Png,
};
