jest.mock("../../Repositories/TxNotifications/adapters/http.util", () => {
	class ProviderError extends Error {
		constructor(code, options = {}) {
			super(code);
			this.name = "ProviderError";
			this.code = code;
			this.status = options.status ?? null;
		}
	}

	return {
		ProviderError,
		postJson: jest.fn(),
	};
});

const { ProviderError, postJson } = require("../../Repositories/TxNotifications/adapters/http.util");
const {
	PUBLIC_SUI_GRAPHQL_URL,
	querySuiGraphql,
	resetSuiGraphqlClient,
	suiGraphqlEndpoints,
} = require("../../Repositories/sui/modules/sui-graphql.client");

const ENV_KEYS = ["SUI_RPC_URL", "RPC_PROXY_SUI_URL", "SUI_GRAPHQL_URL"];

describe("sui graphql client", () => {
	let previousEnv;

	beforeEach(() => {
		previousEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
		for (const key of ENV_KEYS) delete process.env[key];
		resetSuiGraphqlClient();
		postJson.mockReset();
	});

	afterEach(() => {
		for (const key of ENV_KEYS) {
			if (previousEnv[key] === undefined) delete process.env[key];
			else process.env[key] = previousEnv[key];
		}
		resetSuiGraphqlClient();
		jest.restoreAllMocks();
	});

	it("prefers SUI_RPC_URL/graphql, then an explicit GraphQL URL, then the public endpoint", () => {
		process.env.SUI_RPC_URL = "https://example.sui-mainnet.quiknode.pro/secret-token/";
		process.env.SUI_GRAPHQL_URL = "https://graphql.example.test/graphql";

		expect(suiGraphqlEndpoints()).toEqual([
			"https://example.sui-mainnet.quiknode.pro/secret-token/graphql",
			"https://graphql.example.test/graphql",
			PUBLIC_SUI_GRAPHQL_URL,
		]);
	});

	it("does not query the legacy fullnode JSON-RPC host", () => {
		process.env.SUI_RPC_URL = "https://fullnode.mainnet.sui.io:443";
		process.env.RPC_PROXY_SUI_URL = "https://fullnode.testnet.sui.io";

		expect(suiGraphqlEndpoints()).toEqual([PUBLIC_SUI_GRAPHQL_URL]);
	});

	it("falls back when the preferred endpoint 404s and never logs the URL or token", async () => {
		const token = "super-secret-token";
		process.env.SUI_RPC_URL = `https://example.quiknode.pro/${token}`;
		const logs = [];
		jest.spyOn(console, "error").mockImplementation((...args) => {
			logs.push(args.map((part) => (typeof part === "string" ? part : JSON.stringify(part))).join(" "));
		});

		postJson.mockImplementation(async (url) => {
			if (String(url).includes(token)) throw new ProviderError("sui_graphql_http_404", { status: 404 });
			return { data: { chainIdentifier: "4btiui" } };
		});

		await expect(querySuiGraphql("query { chainIdentifier }")).resolves.toEqual({ chainIdentifier: "4btiui" });

		expect(postJson.mock.calls.map((call) => call[0])).toEqual([
			`https://example.quiknode.pro/${token}/graphql`,
			PUBLIC_SUI_GRAPHQL_URL,
		]);
		expect(logs.join("\n")).not.toContain(token);
		expect(logs.join("\n")).not.toContain("quiknode.pro");

		postJson.mockClear();
		await querySuiGraphql("query { chainIdentifier }");
		expect(postJson.mock.calls.map((call) => call[0])).toEqual([PUBLIC_SUI_GRAPHQL_URL]);
	});

	it("throws a code-only error when every endpoint fails", async () => {
		process.env.SUI_RPC_URL = "https://example.quiknode.pro/super-secret-token";
		postJson.mockRejectedValue(new ProviderError("sui_graphql_http_404", { status: 404 }));
		jest.spyOn(console, "error").mockImplementation(() => {});

		await expect(querySuiGraphql("query { chainIdentifier }")).rejects.toMatchObject({
			code: "sui_graphql_http_404",
			status: 502,
		});
		try {
			await querySuiGraphql("query { chainIdentifier }");
		} catch (error) {
			expect(String(error.message)).not.toContain("super-secret-token");
			expect(String(error.stack)).not.toContain("super-secret-token");
		}
	});
});
