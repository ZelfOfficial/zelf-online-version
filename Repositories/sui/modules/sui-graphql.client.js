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

/** How long a timed-out or missing endpoint stays off the preferred path. */
const ENDPOINT_COOLDOWN_MS = 60 * 1000;
/** 429 is a burst, not an outage. Skip the endpoint briefly, then try it again. */
const RATE_LIMIT_COOLDOWN_MS = 5 * 1000;

/** url → timestamp (ms) when it may be tried again. */
const cooldownUntil = new Map();

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

/** GraphQL `extensions.code` values that mean the query is bad, not the endpoint. */
const QUERY_REJECTION_CODES = new Set([
	"RESOURCE_EXHAUSTED",
	"GRAPHQL_VALIDATION_FAILED",
	"GRAPHQL_PARSE_FAILED",
	"BAD_USER_INPUT",
	"VALIDATION_ERROR",
]);

/**
 * Complexity and validation failures are a bad query, not a dead endpoint.
 * Sui's node limit comes back as `extensions.code = RESOURCE_EXHAUSTED`.
 */
const isQueryRejection = (errors) =>
	(errors || []).some((entry) => {
		const code = String(entry?.extensions?.code || entry?.code || "").toUpperCase();
		if (QUERY_REJECTION_CODES.has(code)) return true;
		return /complex|too many|output nodes|query nodes|maximum number of nodes|cannot query field|unknown argument|expected type|validation/i.test(
			String(entry?.message || "")
		);
	});

const queryRejectionError = () => {
	const error = new ProviderError("sui_graphql_query_rejected", { status: 400, retryable: false });
	error.queryError = true;
	return error;
};

const cooling = (url, now = Date.now()) => (cooldownUntil.get(url) || 0) > now;

const coolDown = (url, ms) => {
	cooldownUntil.set(url, Date.now() + ms);
};

/**
 * Runs a GraphQL query. Returns the `data` object.
 * Timeouts and 404s skip that endpoint for ENDPOINT_COOLDOWN_MS. A 429 skips it
 * only for RATE_LIMIT_COOLDOWN_MS and still falls through to the next endpoint.
 * Query-limit and validation errors are thrown immediately: they are not an outage
 * and must not fail over or cool down an endpoint.
 */
const querySuiGraphql = async (query, variables) => {
	let urls = suiGraphqlEndpoints().filter((url) => !cooling(url));
	if (!urls.length) urls = suiGraphqlEndpoints();

	let lastCode = "sui_graphql_unavailable";

	for (const url of urls) {
		try {
			const body = await postJson(url, { query, variables }, { label: "sui_graphql" });
			if (body?.errors?.length && isQueryRejection(body.errors)) {
				console.error("[sui-graphql] query_rejected");
				throw queryRejectionError();
			}
			if (!isGraphqlEnvelope(body) || body.errors?.length) {
				lastCode = body?.errors?.length ? "sui_graphql_error" : "sui_graphql_invalid_response";
				console.error("[sui-graphql] endpoint_failed", lastCode);
				continue;
			}
			return body.data ?? null;
		} catch (error) {
			if (error?.queryError || error?.code === "sui_graphql_query_rejected") throw error;
			lastCode = safeCode(error, "sui_graphql_unavailable");
			const status = error?.status;
			if (status === 429) coolDown(url, RATE_LIMIT_COOLDOWN_MS);
			else if (status === 404 || status === 410 || !status) coolDown(url, ENDPOINT_COOLDOWN_MS);
			console.error("[sui-graphql] endpoint_failed", lastCode);
		}
	}

	throw new ProviderError(lastCode, { status: 502, retryable: true });
};

const resetSuiGraphqlClient = () => {
	cooldownUntil.clear();
};

module.exports = {
	ENDPOINT_COOLDOWN_MS,
	PUBLIC_SUI_GRAPHQL_URL,
	RATE_LIMIT_COOLDOWN_MS,
	graphqlUrlFromRpc,
	querySuiGraphql,
	resetSuiGraphqlClient,
	suiGraphqlEndpoints,
};
