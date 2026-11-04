/**
 * Source A (Trust Wallet RPC) returns balances only — no token name/symbol/logo.
 * Without `solana-spl-known-metadata`, ZNS shows up as a generic "SPL <mint>" row.
 *
 * Manual QA reference: lookup `one610.zelf` → take its Solana address →
 * `GET /api/solana/address/<address>?source=sourceA` → ZNS row should have
 * symbol "ZNS" / name "Zelf" (mirrors the OkLink response).
 */
const { parsedTokenAccountsToHoldings } = require("../../Repositories/Solana/modules/solana-source-a-rpc.module");
const { ZNS_MAINNET_MINT, WSOL_MINT } = require("../../Repositories/Solana/modules/solana-spl-known-metadata");

const owner = "5d1jNutWr7jEGxrzjGGGLb1fVe8mqHxK6wsdcQ2x4Eak";

const accountFor = (mint, { decimals = 9, uiAmount = 1, amount = "1000000000", pubkey = "PubKeyXYZ" } = {}) => ({
	pubkey,
	account: {
		data: {
			parsed: {
				info: {
					mint,
					state: "initialized",
					tokenAmount: { amount, decimals, uiAmount },
				},
			},
		},
	},
});

describe("parsedTokenAccountsToHoldings", () => {
	it("labels the ZNS mint as Zelf/ZNS instead of generic SPL", () => {
		const result = parsedTokenAccountsToHoldings(owner, [
			accountFor(ZNS_MAINNET_MINT, { decimals: 9, uiAmount: 136.0135, amount: "136013500000", pubkey: "GeMiVTLQZFYQ9ZkHtwhQWEd1H8EJ8CD4grA6618xz9SA" }),
		]);

		expect(result.tokens).toHaveLength(1);
		const [zns] = result.tokens;
		expect(zns).toMatchObject({
			name: "Zelf",
			symbol: "ZNS",
			tokenAddress: ZNS_MAINNET_MINT,
			tokenType: "SPL",
			amount: 136.0135,
			owner,
		});
		expect(zns.image).toMatch(/^https?:\/\//);
	});

	it("labels Wrapped SOL with WSOL display metadata", () => {
		const [wsol] = parsedTokenAccountsToHoldings(owner, [accountFor(WSOL_MINT, { decimals: 9, uiAmount: 0.00011, amount: "110000" })]).tokens;

		expect(wsol).toMatchObject({ name: "Wrapped SOL", symbol: "WSOL", tokenAddress: WSOL_MINT });
	});

	it("labels static popular mints (e.g. USDC) without needing Jupiter", () => {
		const usdc = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
		const [row] = parsedTokenAccountsToHoldings(owner, [accountFor(usdc, { decimals: 6, uiAmount: 12.5, amount: "12500000" })]).tokens;
		expect(row).toMatchObject({ name: "USD Coin", symbol: "USDC", tokenAddress: usdc, tokenType: "SPL" });
		expect(row.image).toContain("oklink.com");
		expect(row.symbol).not.toBe("SPL");
	});

	it("falls back to generic SPL placeholders for unknown mints", () => {
		const unknownMint = "5XZw2LKTyrfvfiskJ78AMpackRjPcyCif1WhUsPDuVqQ";
		const [unknown] = parsedTokenAccountsToHoldings(owner, [accountFor(unknownMint, { decimals: 6, uiAmount: 0.00000402, amount: "4" })]).tokens;

		expect(unknown.symbol).toBe("SPL");
		expect(unknown.name).toMatch(/^SPL /);
		expect(unknown.tokenAddress).toBe(unknownMint);
		expect(unknown.image).toBe("");
	});

	it("skips uninitialized accounts", () => {
		const row = accountFor(ZNS_MAINNET_MINT);
		row.account.data.parsed.info.state = "uninitialized";
		const result = parsedTokenAccountsToHoldings(owner, [row]);
		expect(result.tokens).toHaveLength(0);
	});
});

describe("rpcCall fallback when NaaS 401 and catalog refresh fails", () => {
	const mockPost = jest.fn();
	const mockRefresh = jest.fn();
	const naasUrl = "https://solana.twnodes.com/naas/session/expired-token";
	const fallbackUrl = "https://fallback-rpc.example.com";

	beforeEach(() => {
		jest.resetModules();
		mockPost.mockReset();
		mockRefresh.mockReset();
		mockRefresh.mockRejectedValue(new Error("naas_catalog_invalid_response"));

		jest.doMock("../../Core/axios", () => ({
			getCleanInstance: () => ({ post: mockPost }),
		}));
		jest.doMock("../../Core/helpers", () => ({
			generateRandomUserAgent: () => "test-agent",
		}));
		jest.doMock("../../Core/naas-gateway-catalog", () => ({
			getNaasNodeUrl: jest.fn().mockResolvedValue(naasUrl),
			NAAS_CHAIN: { SOLANA: "solana" },
			refreshNaasCatalogAfterUnauthorized: mockRefresh,
			isNaasNodeUnauthorizedError: (err) => err?.response?.status === 401,
		}));
		jest.doMock("../../Core/config", () => ({
			solana: { rpcUrl: fallbackUrl },
			extension: undefined,
		}));
		jest.doMock("../../Repositories/binance/modules/binance.module", () => ({
			getTickerPrice: jest.fn().mockResolvedValue({ price: 100 }),
		}));
		jest.doMock("../../Repositories/Solana/modules/jupiter-spl-metadata.module", () => ({
			enrichSplTokenRowsWithJupiter: jest.fn().mockResolvedValue(undefined),
		}));
	});

	// The NaaS node answers 401 to everything and the catalog refresh fails; the fallback
	// node answers by method. Responses are keyed by method because the history now runs
	// alongside balance/tokens and asks getTransaction per signature.
	const routeByMethod = (fallbackResults) => async (url, body) => {
		if (url === naasUrl) throw { response: { status: 401 } };
		return { data: { jsonrpc: "2.0", id: body.id, result: fallbackResults[body.method] ?? null } };
	};

	it("getTransactions uses fallback RPC instead of throwing when catalog refresh fails", async () => {
		const sig = { signature: "sig1", slot: 123, blockTime: 1700000000, err: null };
		mockPost.mockImplementation(routeByMethod({ getSignaturesForAddress: [sig], getTransaction: null }));

		const { getTransactions } = require("../../Repositories/Solana/modules/solana-source-a-rpc.module");
		const wallet = "8rG2cQUELobaZXjtZajpkaB6FFgK5egsXWfVy885Q6nt";
		const result = await getTransactions({ id: wallet }, { page: 0, show: 10 });

		const calls = mockPost.mock.calls.map(([url, body]) => [url, body.method]);
		expect(calls.slice(0, 2)).toEqual([
			[naasUrl, "getSignaturesForAddress"],
			[fallbackUrl, "getSignaturesForAddress"],
		]);
		expect(calls).toContainEqual([fallbackUrl, "getTransaction"]);
		expect(mockRefresh).toHaveBeenCalled();
		expect(result.transactions).toHaveLength(1);
		expect(result.transactions[0].hash).toBe("sig1");
	});

	it("getAddress uses fallback RPC for balance when catalog refresh fails", async () => {
		const lamports = 1_500_000_000;
		mockPost.mockImplementation(
			routeByMethod({ getBalance: { value: lamports }, getTokenAccountsByOwner: { value: [] }, getSignaturesForAddress: [] }),
		);

		const { getAddress } = require("../../Repositories/Solana/modules/solana-source-a-rpc.module");
		const wallet = "8rG2cQUELobaZXjtZajpkaB6FFgK5egsXWfVy885Q6nt";
		const result = await getAddress({ id: wallet });

		expect(mockRefresh).toHaveBeenCalledTimes(3);
		expect(result).not.toBeNull();
		expect(result.balance).toBe("1.5");
		expect(mockPost.mock.calls.every((call) => call[0] === naasUrl || call[0] === fallbackUrl)).toBe(true);
		expect(mockPost.mock.calls.filter((call) => call[0] === fallbackUrl)).toHaveLength(3);
	});
});
