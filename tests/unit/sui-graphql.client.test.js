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
	CHECKPOINT_LAG_BACKOFF_MS,
	CHECKPOINT_LAG_RETRIES,
	ENDPOINT_COOLDOWN_MS,
	PUBLIC_SUI_GRAPHQL_URL,
	RATE_LIMIT_COOLDOWN_MS,
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
		jest.useRealTimers();
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

	it("retries a timed-out endpoint after the cooldown instead of leaving it dead", async () => {
		const token = "super-secret-token";
		process.env.SUI_RPC_URL = `https://example.quiknode.pro/${token}`;
		const started = 1_700_000_000_000;
		jest.useFakeTimers({ now: started });
		jest.spyOn(console, "error").mockImplementation(() => {});
		postJson.mockImplementation(async (url) => {
			if (String(url).includes(token)) throw new ProviderError("sui_graphql_ETIMEDOUT");
			return { data: { chainIdentifier: "ok" } };
		});

		try {
			await querySuiGraphql("query { chainIdentifier }");
			postJson.mockClear();
			await querySuiGraphql("query { chainIdentifier }");
			expect(postJson.mock.calls.map((call) => call[0])).toEqual([PUBLIC_SUI_GRAPHQL_URL]);

			jest.setSystemTime(started + ENDPOINT_COOLDOWN_MS);
			postJson.mockClear();
			await querySuiGraphql("query { chainIdentifier }");
			expect(postJson.mock.calls[0][0]).toBe(`https://example.quiknode.pro/${token}/graphql`);
		} finally {
			jest.useRealTimers();
		}
	});

	it("falls through on 429 without a long cooldown", async () => {
		const token = "super-secret-token";
		process.env.SUI_RPC_URL = `https://example.quiknode.pro/${token}`;
		const started = 1_700_000_000_000;
		jest.useFakeTimers({ now: started });
		const logs = [];
		jest.spyOn(console, "error").mockImplementation((...args) => {
			logs.push(args.map((part) => String(part)).join(" "));
		});
		postJson.mockImplementation(async (url) => {
			if (String(url).includes(token)) throw new ProviderError("sui_graphql_http_429", { status: 429 });
			return { data: { chainIdentifier: "public" } };
		});

		try {
			await expect(querySuiGraphql("query { chainIdentifier }")).resolves.toEqual({ chainIdentifier: "public" });
			expect(postJson.mock.calls.map((call) => call[0])).toEqual([
				`https://example.quiknode.pro/${token}/graphql`,
				PUBLIC_SUI_GRAPHQL_URL,
			]);

			postJson.mockClear();
			await querySuiGraphql("query { chainIdentifier }");
			expect(postJson.mock.calls.map((call) => call[0])).toEqual([PUBLIC_SUI_GRAPHQL_URL]);

			jest.setSystemTime(started + RATE_LIMIT_COOLDOWN_MS);
			postJson.mockClear();
			await querySuiGraphql("query { chainIdentifier }");
			expect(postJson.mock.calls[0][0]).toBe(`https://example.quiknode.pro/${token}/graphql`);
			expect(logs.join("\n")).not.toContain(token);
		} finally {
			jest.useRealTimers();
		}
	});

	it("treats RESOURCE_EXHAUSTED as a bad query and does not fail over", async () => {
		const token = "super-secret-token";
		process.env.SUI_RPC_URL = `https://example.quiknode.pro/${token}`;
		jest.spyOn(console, "error").mockImplementation(() => {});
		postJson.mockResolvedValue({
			errors: [{ message: "service quota exceeded", extensions: { code: "RESOURCE_EXHAUSTED" } }],
		});

		await expect(querySuiGraphql("query { balances { nodes { coinMetadata { decimals } } } }")).rejects.toMatchObject({
			code: "sui_graphql_query_rejected",
			queryError: true,
			status: 400,
		});
		expect(postJson).toHaveBeenCalledTimes(1);
		expect(postJson.mock.calls[0][0]).toBe(`https://example.quiknode.pro/${token}/graphql`);

		postJson.mockClear();
		postJson.mockResolvedValue({
			errors: [{ message: "bad selection", extensions: { code: "GRAPHQL_VALIDATION_FAILED" } }],
		});
		await expect(querySuiGraphql("query { bad }")).rejects.toMatchObject({ code: "sui_graphql_query_rejected", queryError: true });
		expect(postJson).toHaveBeenCalledTimes(1);

		postJson.mockClear();
		postJson.mockResolvedValue({ data: { chainIdentifier: "back" } });
		await expect(querySuiGraphql("query { chainIdentifier }")).resolves.toEqual({ chainIdentifier: "back" });
		expect(postJson.mock.calls[0][0]).toBe(`https://example.quiknode.pro/${token}/graphql`);
	});

	it("retries a lagging checkpoint on the same endpoint, including a client cursor", async () => {
		const token = "super-secret-token";
		process.env.SUI_RPC_URL = `https://example.quiknode.pro/${token}`;
		jest.useFakeTimers();
		jest.spyOn(console, "error").mockImplementation(() => {});
		const cursor = "cursor-from-client";
		let calls = 0;
		postJson.mockImplementation(async () => {
			calls += 1;
			if (calls <= CHECKPOINT_LAG_RETRIES) {
				return {
					errors: [{ message: "Checkpoint 336708231 in the future", extensions: { code: "BAD_USER_INPUT" } }],
				};
			}
			return { data: { address: { balances: { nodes: [] } } } };
		});

		try {
			const pending = querySuiGraphql("query SuiCoinBalances($after: String)", { after: cursor, first: 50 });
			await jest.advanceTimersByTimeAsync(CHECKPOINT_LAG_BACKOFF_MS * CHECKPOINT_LAG_RETRIES);
			await expect(pending).resolves.toEqual({ address: { balances: { nodes: [] } } });

			expect(postJson).toHaveBeenCalledTimes(CHECKPOINT_LAG_RETRIES + 1);
			expect(postJson.mock.calls.every((call) => call[0] === `https://example.quiknode.pro/${token}/graphql`)).toBe(true);
			expect(postJson.mock.calls.every((call) => call[1].variables.after === cursor)).toBe(true);
		} finally {
			jest.useRealTimers();
		}
	});

	it("fails a lagging checkpoint over after retries without a long cooldown", async () => {
		const token = "super-secret-token";
		process.env.SUI_RPC_URL = `https://example.quiknode.pro/${token}`;
		const started = 1_700_000_000_000;
		jest.useFakeTimers({ now: started });
		jest.spyOn(console, "error").mockImplementation(() => {});
		postJson.mockImplementation(async (url) => {
			if (String(url).includes(token)) {
				return { errors: [{ message: "Checkpoint 99 in the future", extensions: { code: "BAD_USER_INPUT" } }] };
			}
			return { data: { transactions: { nodes: [{ digest: "ok" }] } } };
		});

		try {
			const pending = querySuiGraphql("query SuiHistory($before: String)", { before: "page-6" });
			await jest.advanceTimersByTimeAsync(CHECKPOINT_LAG_BACKOFF_MS * CHECKPOINT_LAG_RETRIES);
			await expect(pending).resolves.toEqual({ transactions: { nodes: [{ digest: "ok" }] } });

			const primaryCalls = postJson.mock.calls.filter((call) => String(call[0]).includes(token));
			expect(primaryCalls).toHaveLength(CHECKPOINT_LAG_RETRIES + 1);
			expect(postJson.mock.calls.at(-1)[0]).toBe(PUBLIC_SUI_GRAPHQL_URL);

			postJson.mockClear();
			const skipped = querySuiGraphql("query { chainIdentifier }");
			await jest.advanceTimersByTimeAsync(0);
			await expect(skipped).resolves.toEqual({ transactions: { nodes: [{ digest: "ok" }] } });
			expect(postJson.mock.calls.map((call) => call[0])).toEqual([PUBLIC_SUI_GRAPHQL_URL]);

			jest.setSystemTime(Date.now() + RATE_LIMIT_COOLDOWN_MS);
			postJson.mockClear();
			const again = querySuiGraphql("query { chainIdentifier }");
			await jest.advanceTimersByTimeAsync(CHECKPOINT_LAG_BACKOFF_MS * CHECKPOINT_LAG_RETRIES);
			await again;
			expect(String(postJson.mock.calls[0][0])).toBe(`https://example.quiknode.pro/${token}/graphql`);
			expect(Date.now() - started).toBeLessThan(ENDPOINT_COOLDOWN_MS);
		} finally {
			jest.useRealTimers();
		}
	});

	it("still refuses a genuine BAD_USER_INPUT without retrying or failing over", async () => {
		const token = "super-secret-token";
		process.env.SUI_RPC_URL = `https://example.quiknode.pro/${token}`;
		jest.spyOn(console, "error").mockImplementation(() => {});
		postJson.mockResolvedValue({
			errors: [{ message: "Variable \"$after\" got invalid value.", extensions: { code: "BAD_USER_INPUT" } }],
		});

		await expect(querySuiGraphql("query { x }", { after: "not-a-cursor" })).rejects.toMatchObject({
			code: "sui_graphql_query_rejected",
			queryError: true,
		});
		expect(postJson).toHaveBeenCalledTimes(1);
	});

	it("does not fail over or cool down an endpoint when the query exceeds the node limit", async () => {
		const token = "super-secret-token";
		process.env.SUI_RPC_URL = `https://example.quiknode.pro/${token}`;
		jest.spyOn(console, "error").mockImplementation(() => {});
		postJson.mockResolvedValue({
			errors: [{ message: "Exceeded the maximum number of output nodes (21). Please try a simpler query." }],
		});

		await expect(querySuiGraphql("query { balances { coinMetadata { decimals } } }")).rejects.toMatchObject({
			code: "sui_graphql_query_rejected",
			queryError: true,
			status: 400,
		});
		expect(postJson).toHaveBeenCalledTimes(1);

		postJson.mockClear();
		postJson.mockResolvedValue({ data: { chainIdentifier: "back" } });
		await expect(querySuiGraphql("query { chainIdentifier }")).resolves.toEqual({ chainIdentifier: "back" });
		expect(postJson.mock.calls[0][0]).toBe(`https://example.quiknode.pro/${token}/graphql`);
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
