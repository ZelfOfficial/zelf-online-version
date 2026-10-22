jest.mock("../../Repositories/binance/modules/binance.module", () => ({
	getTickerPrice: jest.fn(async () => ({ price: "2" })),
}));

jest.mock("../../Repositories/sui/modules/sui-graphql.client", () => ({
	querySuiGraphql: jest.fn(),
}));

const { getTickerPrice } = require("../../Repositories/binance/modules/binance.module");
const { querySuiGraphql } = require("../../Repositories/sui/modules/sui-graphql.client");
const { METADATA_BATCH, getAddress, getTokens, getTransaction, getTransactions, resetSuiMetadataCache } = require("../../Repositories/sui/modules/sui-scrapping.module");

const ADDRESS = "0x7ba661f0e68dcfa31c8c20f21d42bc0b973920ee79904bd5683c9259a9925fdf";
const SENDER = "0xd265672730b0540ffd3569530682a0f02ef984b703457790554eb0e19329663a";
const SUI_TYPE = "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI";
const USDC_TYPE = "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC";

const suiNode = (raw = "94770000000") => ({
	coinType: { repr: SUI_TYPE },
	totalBalance: raw,
	coinMetadata: { decimals: 9, name: "Sui", symbol: "SUI", iconUrl: "" },
});

const usdcNode = () => ({
	coinType: { repr: USDC_TYPE },
	totalBalance: "2500000",
	coinMetadata: { decimals: 6, name: "USD Coin", symbol: "USDC", iconUrl: "https://example.com/usdc.png" },
});

const txNode = (digest, amount = "1000000000") => ({
	digest,
	sender: { address: SENDER },
	kind: { __typename: "ProgrammableTransaction" },
	gasInput: { gasPrice: "100", gasBudget: "5000000" },
	effects: {
		status: "SUCCESS",
		timestamp: "2026-10-22T03:36:43.776Z",
		checkpoint: { sequenceNumber: 336708231 },
		gasEffects: {
			gasSummary: { computationCost: 1000, storageCost: 2000, storageRebate: 500, nonRefundableStorageFee: 50 },
		},
		balanceChanges: {
			nodes: [
				{ owner: { address: ADDRESS }, amount, coinType: { repr: SUI_TYPE } },
				{ owner: { address: SENDER }, amount: `-${amount}`, coinType: { repr: SUI_TYPE } },
			],
		},
	},
});

const graphqlError = (code = "sui_graphql_http_403") => {
	const error = new Error(code);
	error.status = 502;
	error.code = code;
	return error;
};

const metadataFor = (variables = {}) => {
	const result = {};
	for (const [key, coinType] of Object.entries(variables)) {
		const index = key.replace(/^t/, "");
		const type = String(coinType);
		if (type.includes("::sui::SUI")) result[`c${index}`] = { decimals: 9, symbol: "SUI", name: "Sui", iconUrl: "" };
		else if (type.includes("::usdc::USDC")) {
			result[`c${index}`] = { decimals: 6, symbol: "USDC", name: "USD Coin", iconUrl: "https://example.com/usdc.png" };
		}
	}
	return result;
};

const queryRejection = () => {
	const error = new Error("sui_graphql_query_rejected");
	error.code = "sui_graphql_query_rejected";
	error.queryError = true;
	error.status = 400;
	return error;
};

describe("sui portfolio graphql", () => {
	beforeEach(() => {
		resetSuiMetadataCache();
		querySuiGraphql.mockReset();
		getTickerPrice.mockResolvedValue({ price: "2" });
	});

	it("returns the human SUI balance for an address that holds 94.77 SUI", async () => {
		querySuiGraphql.mockImplementation(async (text, variables) => {
			expect(text).not.toMatch(/balance\(coinType:[\s\S]*coinMetadata/);
			if (text.includes("SuiCoinBalances")) expect(text).not.toMatch(/coinMetadata/);
			if (text.includes("SuiNativeBalance")) return { address: { balance: suiNode("94770000000") } };
			if (text.includes("SuiCoinBalances")) {
				return {
					address: {
						balances: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [suiNode("94770000000"), usdcNode()] },
					},
				};
			}
			if (text.includes("SuiCoinMeta")) return metadataFor(variables);
			if (text.includes("SuiHistory")) {
				return { transactions: { pageInfo: { hasPreviousPage: false, startCursor: null }, nodes: [txNode("Digest111")] } };
			}
			throw new Error(`unexpected query: ${text.slice(0, 40)}`);
		});

		const result = await getAddress({ id: ADDRESS });

		expect(result.balance).toBe("94.77");
		expect(result._balance).toBe("94.77");
		expect(result.address).toBe(ADDRESS);
		expect(result.account).toMatchObject({ asset: "SUI", price: "2" });
		expect(result.fiatBalance).toBe(189.54);
		expect(result.tokenHoldings.tokens.map((token) => [token.symbol, token.amount, token.decimals])).toEqual([
			["SUI", "94.77", 9],
			["USDC", "2.5", 6],
		]);
		expect(result.tokenHoldings.tokens[0].address_token).toBe("0x2");
		expect(result.tokenHoldings.tokens[1].coinType).toBe(`${USDC_TYPE}`);
		expect(result.transactions).toHaveLength(1);
		expect(result.transactions[0]).toMatchObject({
			hash: "Digest111",
			asset: "SUI",
			amount: "1.000000",
			traffic: "IN",
			from: SENDER,
			to: ADDRESS,
			block: "336708231",
		});
	});

	it("rejects a failed balance lookup instead of returning zero", async () => {
		querySuiGraphql.mockRejectedValue(graphqlError());

		await expect(getAddress({ id: ADDRESS })).rejects.toMatchObject({
			status: 502,
			code: "sui_balance_unavailable",
			message: "sui_balance_unavailable",
		});
	});

	it("rejects a failed token lookup instead of returning an empty list", async () => {
		querySuiGraphql.mockRejectedValue(graphqlError("sui_graphql_http_400"));

		await expect(getTokens({ id: ADDRESS }, { page: "0", show: "10" })).rejects.toMatchObject({
			status: 502,
			code: "sui_tokens_unavailable",
		});
	});

	it("keeps coin decimals and walks the next balance page", async () => {
		querySuiGraphql.mockImplementation(async (text, variables) => {
			if (text.includes("SuiCoinMeta")) return metadataFor(variables);
			if (!variables.after) {
				return {
					address: {
						balances: {
							pageInfo: { hasNextPage: true, endCursor: "page-2" },
							nodes: Array.from({ length: 10 }, () => suiNode("1000000000")),
						},
					},
				};
			}
			return {
				address: {
					balances: {
						pageInfo: { hasNextPage: false, endCursor: null },
						nodes: [usdcNode()],
					},
				},
			};
		});

		const first = await getTokens({ id: ADDRESS }, { page: "0", show: "10" });
		expect(first.total).toBe(10);
		expect(first.hasNextPage).toBe(true);
		expect(first.tokens[0]).toMatchObject({ symbol: "SUI", decimals: 9, amount: "1", price: "2", address_token: "0x2" });

		const second = await getTokens({ id: ADDRESS }, { page: "1", show: "10" });
		expect(second.tokens.map((token) => token.symbol)).toEqual(["USDC"]);
		expect(second.tokens[0]).toMatchObject({ decimals: 6, amount: "2.5", image: "https://example.com/usdc.png" });
		expect(second.hasNextPage).toBe(false);
	});

	it("walks transaction pages of 100 by chunking GraphQL's 50-item cap", async () => {
		const nodesFor = (start) => Array.from({ length: 50 }, (_, index) => txNode(`D${start + index}`, String((start + index + 1) * 1000)));
		querySuiGraphql.mockImplementation(async (_text, variables) => {
			if (!variables.before) {
				return { transactions: { pageInfo: { hasPreviousPage: true, startCursor: "older" }, nodes: nodesFor(50) } };
			}
			return { transactions: { pageInfo: { hasPreviousPage: false, startCursor: "oldest" }, nodes: nodesFor(0) } };
		});

		const result = await getTransactions({ id: ADDRESS }, { page: "0", show: "100" });

		expect(querySuiGraphql).toHaveBeenCalledTimes(2);
		expect(result.transactions).toHaveLength(100);
		expect(result.pagination).toMatchObject({
			page: "0",
			show: "100",
			hasNextPage: false,
			records: "100",
			nextCursor: null,
		});
		expect(result.transactions[0].hash).toBe("D99");
		expect(result.transactions[99].hash).toBe("D0");
	});

	it("reports another history page when GraphQL has older transactions", async () => {
		querySuiGraphql.mockResolvedValue({
			transactions: {
				pageInfo: { hasPreviousPage: true, startCursor: "next-older" },
				nodes: Array.from({ length: 10 }, (_, index) => txNode(`Newest${index}`)),
			},
		});

		const result = await getTransactions({ id: ADDRESS }, { page: "0", show: "10" });

		expect(result.pagination).toMatchObject({
			records: "11",
			page: "0",
			show: "10",
			hasNextPage: true,
			nextCursor: "next-older",
		});
	});

	it("follows an explicit history cursor", async () => {
		querySuiGraphql.mockResolvedValue({
			transactions: { pageInfo: { hasPreviousPage: false, startCursor: null }, nodes: [txNode("Older")] },
		});

		await getTransactions({ id: ADDRESS }, { page: "3", show: "10", cursor: "cursor-1" });

		expect(querySuiGraphql.mock.calls[0][1]).toMatchObject({ before: "cursor-1", last: 10 });
	});

	it("loads 80 coin balances in metadata batches that stay under the query limit", async () => {
		const coins = Array.from({ length: 80 }, (_, index) => ({
			coinType: { repr: `0x${(index + 1).toString(16).padStart(64, "0")}::coin::C${index}` },
			totalBalance: "1000",
		}));
		const metaSizes = [];
		let inFlight = 0;
		let maxInFlight = 0;

		querySuiGraphql.mockImplementation(async (text, variables) => {
			if (text.includes("SuiCoinBalances")) {
				expect(text).not.toMatch(/coinMetadata/);
				const start = variables.after === "p2" ? 50 : 0;
				const nodes = coins.slice(start, start + variables.first);
				const hasNextPage = start + nodes.length < coins.length;
				return {
					address: {
						balances: { pageInfo: { hasNextPage, endCursor: hasNextPage ? "p2" : null }, nodes },
					},
				};
			}
			if (text.includes("SuiCoinMeta")) {
				inFlight += 1;
				maxInFlight = Math.max(maxInFlight, inFlight);
				metaSizes.push((text.match(/coinMetadata\(/g) || []).length);
				await Promise.resolve();
				inFlight -= 1;
				return {};
			}
			throw new Error(`unexpected query: ${text.slice(0, 40)}`);
		});

		const result = await getTokens({ id: ADDRESS }, { page: "0", show: "100" });

		expect(result.tokens).toHaveLength(80);
		expect(result.tokens[0]).toMatchObject({ symbol: "C0", decimals: null, amount: "1000" });
		expect(metaSizes).toHaveLength(Math.ceil(80 / METADATA_BATCH));
		expect(metaSizes.every((size) => size > 0 && size <= METADATA_BATCH)).toBe(true);
		expect(maxInFlight).toBe(1);
	});

	it("treats a metadata complexity rejection as missing metadata, not an outage", async () => {
		const coins = [suiNode("2000000000"), usdcNode(), ...Array.from({ length: 8 }, (_, index) => ({
			coinType: { repr: `0x${(index + 3).toString(16).padStart(64, "0")}::coin::C${index}` },
			totalBalance: "10",
		}))];
		querySuiGraphql.mockImplementation(async (text) => {
			if (text.includes("SuiCoinBalances")) {
				return { address: { balances: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: coins } } };
			}
			if (text.includes("SuiCoinMeta")) throw queryRejection();
			throw new Error(`unexpected query: ${text.slice(0, 40)}`);
		});

		const result = await getTokens({ id: ADDRESS }, { page: "0", show: "25" });

		expect(result.tokens).toHaveLength(coins.length);
		expect(result.tokens[0]).toMatchObject({ symbol: "SUI", decimals: 9, amount: "2" });
		expect(result.tokens[1]).toMatchObject({ symbol: "USDC", decimals: 6, amount: "2.5" });
		expect(result.tokens[2]).toMatchObject({ symbol: "C0", decimals: null, amount: "10" });
	});

	it("returns the SUI balance when the token list and history fail", async () => {
		querySuiGraphql.mockImplementation(async (text) => {
			if (text.includes("SuiNativeBalance")) return { address: { balance: { coinType: { repr: SUI_TYPE }, totalBalance: "94770000000" } } };
			throw graphqlError("sui_graphql_http_403");
		});

		const result = await getAddress({ id: ADDRESS });

		expect(result.balance).toBe("94.77");
		expect(result._balance).toBe("94.77");
		expect(result.tokenHoldings.tokens.map((token) => token.symbol)).toEqual(["SUI"]);
		expect(result.transactions).toEqual([]);
	});

	it("returns history when the page touches more coin types than one metadata query allows", async () => {
		const types = Array.from({ length: 8 }, (_, index) => `0x${(index + 1).toString(16).padStart(64, "0")}::coin::T${index}`);
		const nodes = types.map((repr, index) => {
			const base = txNode(`H${index}`, "1000");
			return {
				...base,
				effects: {
					...base.effects,
					balanceChanges: { nodes: [{ owner: { address: ADDRESS }, amount: "1000", coinType: { repr } }] },
				},
			};
		});
		const metaSizes = [];
		querySuiGraphql.mockImplementation(async (text) => {
			if (text.includes("SuiHistory")) {
				return { transactions: { pageInfo: { hasPreviousPage: false, startCursor: null }, nodes } };
			}
			if (text.includes("SuiCoinMeta")) {
				metaSizes.push((text.match(/coinMetadata\(/g) || []).length);
				throw queryRejection();
			}
			throw new Error(`unexpected query: ${text.slice(0, 40)}`);
		});

		const result = await getTransactions({ id: ADDRESS }, { page: "0", show: "10" });

		expect(result.transactions).toHaveLength(8);
		expect(metaSizes).toEqual([METADATA_BATCH, 8 - METADATA_BATCH]);
		expect(result.transactions.map((row) => row.asset)).toEqual(["T7", "T6", "T5", "T4", "T3", "T2", "T1", "T0"]);
		expect(result.transactions[0].amount).toBe("1000");
	});

	it("returns 404 for an unknown transaction and 502 when GraphQL fails", async () => {
		querySuiGraphql.mockResolvedValueOnce({ transaction: null });
		await expect(getTransaction({ id: "missing" })).rejects.toMatchObject({ status: 404, code: "transaction_not_found" });

		querySuiGraphql.mockRejectedValueOnce(graphqlError());
		await expect(getTransaction({ id: "missing" })).rejects.toMatchObject({ status: 502, code: "sui_transaction_unavailable" });
	});
});
