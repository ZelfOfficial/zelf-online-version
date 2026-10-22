const { ProviderError, postJson } = require("../../TxNotifications/adapters/http.util");

/**
 * Shared Sui GraphQL client (portfolio routes, JSON-RPC translation, tx watcher).
 *
 * Order: `${SUI_RPC_URL}/graphql`, then `${RPC_PROXY_SUI_URL}/graphql`, then
 * `SUI_GRAPHQL_URL` when set, then the public mainnet endpoint. The legacy
 * `fullnode.*.sui.io` JSON-RPC hosts are skipped — they no longer serve GraphQL.
 * URLs and path tokens are never logged.
 */

const PUBLIC_SUI_GRAPHQL_URL = "https://graphql.mainnet.sui.io/graphql";

const LEGACY_JSON_RPC_HOSTS = new Set(["fullnode.mainnet.sui.io", "fullnode.testnet.sui.io", "fullnode.devnet.sui.io"]);

/** Hosts that answered 404/network and should not be retried until the set is cleared. */
const deadUrls = new Set();

const graphqlUrlFromRpc = (rpcUrl) => {
	const raw = String(rpcUrl || "").trim();
	if (!raw) return null;

	let url;
	try {
		url = new URL(raw);
	} catch (_error) {
		return null;
	}

	if (LEGACY_JSON_RPC_HOSTS.has(url.hostname)) return null;

	const path = url.pathname.replace(/\/+$/, "");
	url.pathname = path.endsWith("/graphql") ? path : `${path}/graphql`;
	return url.toString();
};

const pushUnique = (urls, value) => {
	const next = String(value || "").trim();
	if (next && !urls.includes(next)) urls.push(next);
};

/** Candidate GraphQL endpoints, preferred first. */
const suiGraphqlEndpoints = () => {
	const urls = [];
	pushUnique(urls, graphqlUrlFromRpc(process.env.SUI_RPC_URL));
	pushUnique(urls, graphqlUrlFromRpc(process.env.RPC_PROXY_SUI_URL));
	pushUnique(urls, process.env.SUI_GRAPHQL_URL);
	pushUnique(urls, PUBLIC_SUI_GRAPHQL_URL);
	return urls;
};

const isGraphqlEnvelope = (data) =>
	Boolean(data) && typeof data === "object" && (Object.prototype.hasOwnProperty.call(data, "data") || Object.prototype.hasOwnProperty.call(data, "errors"));

const safeCode = (error, fallback) => {
	const code = error?.code || error?.message;
	return typeof code === "string" && /^[a-z0-9_]+$/i.test(code) ? code : fallback;
};

/**
 * Runs a GraphQL query. Returns the `data` object.
 * Transport failures try the next endpoint. A GraphQL `errors` payload also
 * tries the next endpoint so a provider with a stale schema does not hide the
 * public mainnet service.
 */
const querySuiGraphql = async (query, variables) => {
	let urls = suiGraphqlEndpoints().filter((url) => !deadUrls.has(url));
	if (!urls.length) {
		deadUrls.clear();
		urls = suiGraphqlEndpoints();
	}

	let lastCode = "sui_graphql_unavailable";

	for (const url of urls) {
		try {
			const body = await postJson(url, { query, variables }, { label: "sui_graphql" });
			if (!isGraphqlEnvelope(body) || body.errors?.length) {
				lastCode = body?.errors?.length ? "sui_graphql_error" : "sui_graphql_invalid_response";
				console.error("[sui-graphql] endpoint_failed", lastCode);
				continue;
			}
			return body.data ?? null;
		} catch (error) {
			lastCode = safeCode(error, "sui_graphql_unavailable");
			const status = error?.status;
			if (status === 404 || status === 410 || !status) deadUrls.add(url);
			console.error("[sui-graphql] endpoint_failed", lastCode);
		}
	}

	throw new ProviderError(lastCode, { status: 502, retryable: true });
};

const resetSuiGraphqlClient = () => {
	deadUrls.clear();
};

module.exports = {
	PUBLIC_SUI_GRAPHQL_URL,
	graphqlUrlFromRpc,
	querySuiGraphql,
	resetSuiGraphqlClient,
	suiGraphqlEndpoints,
};
