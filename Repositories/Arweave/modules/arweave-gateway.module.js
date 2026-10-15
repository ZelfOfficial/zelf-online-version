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

const _normalizeHost = (host) => String(host || "").trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");

/** Ordered Zelf Link gateway hosts (ar.io first by default), de-duplicated. */
const getArnsGatewayHosts = () => {
	const list = Array.isArray(config.arwave.arnsGatewayHosts) ? config.arwave.arnsGatewayHosts : String(config.arwave.arnsGatewayHosts || "").split(",");
	const hosts = [...list, config.arwave.arnsGatewayHost].map(_normalizeHost).filter(Boolean);
	return [...new Set(hosts.length ? hosts : ["ar.io"])];
};

const getArnsGatewayHost = () => getArnsGatewayHosts()[0];

const getExplorerUrl = () => EXPLORER_URL;

const buildTxUrl = (txId) => `${getPublicGatewayUrl()}/${txId}`;

const buildExplorerUrl = (txId) => `${EXPLORER_URL}/${txId}`;

/**
 * Build ARNS undername URL on the configured gateway host.
 * @param {string} tagName
 * @param {string} domain
 * @returns {string}
 */
const _arnsLabel = (tagName, domain) => (domain === "zelf" || !domain ? `${tagName}_zelf` : `${tagName}_${domain}_zelf`);

const buildArnsUndernameUrl = (tagName, domain, host = getArnsGatewayHost()) => `https://${_arnsLabel(tagName, domain)}.${host}`;

/** Zelf Link on every configured gateway, in preference order. */
const buildArnsUndernameUrls = (tagName, domain) => getArnsGatewayHosts().map((host) => buildArnsUndernameUrl(tagName, domain, host));

const ZELF_LINK_PROBE_TIMEOUT_MS = 2500;
const ZELF_LINK_CACHE_MS = 5 * 60 * 1000;
const _zelfLinkCache = new Map();

const _probe = async (url) => {
	try {
		const response = await axios.get(url, {
			timeout: ZELF_LINK_PROBE_TIMEOUT_MS,
			maxRedirects: 3,
			responseType: "stream",
			validateStatus: () => true,
		});
		response.data?.destroy?.();
		return response.status >= 200 && response.status < 300;
	} catch (_error) {
		return false;
	}
};

/**
 * First gateway that serves the Zelf Link (probed in order, cached per name for a few minutes).
 * @returns {Promise<{ url: string, urls: string[], resolved: boolean, cached: boolean }>}
 */
const resolveZelfLink = async (tagName, domain = "zelf", { probe = _probe, now = Date.now } = {}) => {
	const urls = buildArnsUndernameUrls(tagName, domain);
	const key = `${tagName}.${domain}`.toLowerCase();
	const hit = _zelfLinkCache.get(key);
	if (hit && hit.expiresAt > now()) return { ...hit.value, cached: true };

	let url = null;
	for (const candidate of urls) {
		if (await probe(candidate)) {
			url = candidate;
			break;
		}
	}

	const value = { url: url || urls[0], urls, resolved: Boolean(url) };
	// Cache misses for less time so a freshly published link shows up quickly.
	_zelfLinkCache.set(key, { value, expiresAt: now() + (url ? ZELF_LINK_CACHE_MS : 60 * 1000) });
	return { ...value, cached: false };
};

const _clearZelfLinkCache = () => _zelfLinkCache.clear();

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

/**
 * Fetch raw transaction bytes from the public gateway, then fall back to GraphQL pool.
 * @param {string} txId
 * @returns {Promise<ArrayBuffer|null>}
 */
const fetchTxData = async (txId) => {
	const fetchFromBase = async (baseUrl) => {
		const response = await axios.get(`${_normalizeGatewayBase(baseUrl)}/${txId}`, {
			responseType: "arraybuffer",
			timeout: ARWEAVE_HTTP_TIMEOUT_MS,
			validateStatus: (status) => status >= 200 && status < 300,
		});
		if (response?.data && response.data.byteLength > 0) {
			return response.data;
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
	buildArnsUndernameUrls,
	getArnsGatewayHosts,
	resolveZelfLink,
	_clearZelfLinkCache,
	isSingleTagLookupKey,
	postGraphqlToGateway,
	postGraphql,
	fetchTxData,
	fetchTxAsBase64Png,
};
