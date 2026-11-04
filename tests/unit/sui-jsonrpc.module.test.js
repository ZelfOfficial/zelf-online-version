jest.mock("../../Repositories/sui/modules/sui-graphql.client", () => ({
	querySuiGraphql: jest.fn(),
}));

const { querySuiGraphql } = require("../../Repositories/sui/modules/sui-graphql.client");
const { SUPPORTED_SUI_JSONRPC_METHODS, translateSuiJsonRpc } = require("../../Repositories/sui/modules/sui-jsonrpc.module");

const OWNER = "0x7ba661f0e68dcfa31c8c20f21d42bc0b973920ee79904bd5683c9259a9925fdf";
const SUI_TYPE = "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI";

const txNode = (digest) => ({
	digest,
	sender: { address: OWNER },
	gasInput: { gasPrice: "100", gasBudget: "1000", gasSponsor: { address: OWNER } },
	effects: {
		status: "SUCCESS",
		timestamp: "2026-10-22T03:36:43.776Z",
		checkpoint: { sequenceNumber: 42 },
		epoch: { epochId: 12 },
		gasEffects: { gasSummary: { computationCost: 10, storageCost: 20, storageRebate: 5, nonRefundableStorageFee: 1 } },
		balanceChanges: { nodes: [{ owner: { address: OWNER }, amount: "94770000000", coinType: { repr: SUI_TYPE } }] },
	},
});

describe("sui json-rpc graphQL translation", () => {
	beforeEach(() => {
		querySuiGraphql.mockReset();
	});

	it("translates chain identifier and the latest checkpoint", async () => {
		querySuiGraphql.mockResolvedValueOnce({ chainIdentifier: "4btiuiMPvEENsttpZC7CZ53DruC3MAgfznDbASZ7DR6S" });
		await expect(translateSuiJsonRpc("sui_getChainIdentifier", [])).resolves.toBe("4btiuiMPvEENsttpZC7CZ53DruC3MAgfznDbASZ7DR6S");

		querySuiGraphql.mockResolvedValueOnce({ checkpoint: { sequenceNumber: 336708079 } });
		await expect(translateSuiJsonRpc("sui_getLatestCheckpointSequenceNumber", [])).resolves.toBe("336708079");
	});

	it("translates getBalance and suix_getAllBalances", async () => {
		querySuiGraphql.mockResolvedValueOnce({
			address: { balance: { coinType: { repr: SUI_TYPE }, totalBalance: "94770000000" } },
		});

		await expect(translateSuiJsonRpc("sui_getBalance", [OWNER, "0x2::sui::SUI"])).resolves.toEqual({
			coinType: "0x2::sui::SUI",
			coinObjectCount: null,
			totalBalance: "94770000000",
			lockedBalance: {},
		});

		querySuiGraphql.mockResolvedValueOnce({
			address: {
				balances: {
					pageInfo: { hasNextPage: true, endCursor: "more" },
					nodes: [{ coinType: { repr: SUI_TYPE }, totalBalance: "10" }],
				},
			},
		});
		querySuiGraphql.mockResolvedValueOnce({
			address: {
				balances: {
					pageInfo: { hasNextPage: false, endCursor: null },
					nodes: [{ coinType: { repr: "0xabc::coin::COIN" }, totalBalance: "5" }],
				},
			},
		});

		const balances = await translateSuiJsonRpc("suix_getAllBalances", [OWNER]);
		expect(balances.map((row) => row.coinType)).toEqual(["0x2::sui::SUI", "0xabc::coin::COIN"]);
		expect(querySuiGraphql.mock.calls[2][1]).toMatchObject({ after: "more" });
	});

	it("translates queryTransactionBlocks with a FromAddress filter", async () => {
		querySuiGraphql.mockResolvedValue({
			transactions: {
				pageInfo: { hasNextPage: false, hasPreviousPage: true, startCursor: "older", endCursor: "newer" },
				nodes: [txNode("OlderDigest"), txNode("NewerDigest")],
			},
		});

		const page = await translateSuiJsonRpc("suix_queryTransactionBlocks", [{ filter: { FromAddress: OWNER } }, null, 10, true]);

		expect(querySuiGraphql.mock.calls[0][1]).toMatchObject({
			last: 10,
			before: null,
			filter: { sentAddress: OWNER },
		});
		expect(page.hasNextPage).toBe(true);
		expect(page.nextCursor).toBe("older");
		expect(page.data.map((row) => row.digest)).toEqual(["NewerDigest", "OlderDigest"]);
		expect(page.data[0].balanceChanges[0]).toEqual({
			owner: { AddressOwner: OWNER },
			coinType: "0x2::sui::SUI",
			amount: "94770000000",
		});
		expect(page.data[0].effects.status).toEqual({ status: "success" });
		expect(page.data[0].timestampMs).toBe(String(Date.parse("2026-10-22T03:36:43.776Z")));
	});

	it("translates coin metadata and reference gas price", async () => {
		querySuiGraphql.mockResolvedValueOnce({
			coinMetadata: { address: "0xmeta", decimals: 9, name: "Sui", symbol: "SUI", description: "Native", iconUrl: null },
		});
		await expect(translateSuiJsonRpc("suix_getCoinMetadata", ["0x2::sui::SUI"])).resolves.toMatchObject({
			decimals: 9,
			symbol: "SUI",
			id: "0xmeta",
		});

		querySuiGraphql.mockResolvedValueOnce({ epoch: { referenceGasPrice: "100" } });
		await expect(translateSuiJsonRpc("sui_getReferenceGasPrice", [])).resolves.toBe("100");
	});

	it("returns null for an unknown transaction block", async () => {
		querySuiGraphql.mockResolvedValue({ transaction: null });
		await expect(translateSuiJsonRpc("sui_getTransactionBlock", ["missing"])).resolves.toBeNull();
	});

	it("rejects filters that GraphQL cannot express and methods it does not translate", async () => {
		await expect(translateSuiJsonRpc("sui_queryTransactionBlocks", [{ filter: { FromAndToAddress: { from: OWNER, to: OWNER } } }])).rejects.toMatchObject({
			status: 400,
			code: "sui_json_rpc_filter_unsupported",
		});

		await expect(translateSuiJsonRpc("executeTransactionBlock", [])).rejects.toMatchObject({
			status: 501,
			code: "sui_json_rpc_unavailable",
			details: {
				supported: SUPPORTED_SUI_JSONRPC_METHODS,
			},
		});

		await expect(translateSuiJsonRpc("sui_getObject", ["0x2"])).rejects.toMatchObject({
			status: 501,
			details: {
				supported: expect.arrayContaining([
					"sui_getChainIdentifier",
					"sui_getLatestCheckpointSequenceNumber",
					"sui_getBalance",
					"suix_getAllBalances",
					"suix_queryTransactionBlocks",
				]),
			},
		});
	});
});
