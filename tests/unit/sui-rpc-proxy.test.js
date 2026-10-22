jest.mock("../../Core/axios", () => {
	const post = jest.fn(async () => {
		throw new Error("json_rpc_post_should_not_run");
	});
	return {
		getCleanInstance: () => ({ post }),
	};
});

jest.mock("../../Repositories/RPC/models/rpc-log.model", () => ({
	create: jest.fn(async () => ({})),
}));

jest.mock("../../Repositories/sui/modules/sui-graphql.client", () => ({
	querySuiGraphql: jest.fn(),
}));

const { getCleanInstance } = require("../../Core/axios");
const { querySuiGraphql } = require("../../Repositories/sui/modules/sui-graphql.client");
const { forwardRequest } = require("../../Repositories/RPC/modules/rpc.module");

describe("POST /api/rpc/sui graphQL translation", () => {
	const post = getCleanInstance().post;

	beforeEach(() => {
		querySuiGraphql.mockReset();
		post.mockClear();
	});

	it("answers sui_getChainIdentifier without posting JSON-RPC", async () => {
		querySuiGraphql.mockResolvedValue({ chainIdentifier: "4btiuiMPvEENsttpZC7CZ53DruC3MAgfznDbASZ7DR6S" });

		const result = await forwardRequest({
			chain: "sui",
			method: "sui_getChainIdentifier",
			params: [],
		});

		expect(post).not.toHaveBeenCalled();
		expect(result).toMatchObject({
			chain: "sui",
			chainId: 101,
			method: "sui_getChainIdentifier",
			result: "4btiuiMPvEENsttpZC7CZ53DruC3MAgfznDbASZ7DR6S",
		});
	});

	it("accepts the official suix_getBalance alias", async () => {
		querySuiGraphql.mockResolvedValue({
			address: {
				balance: {
					coinType: { repr: "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI" },
					totalBalance: "1",
				},
			},
		});

		const result = await forwardRequest({
			chain: "sui",
			method: "suix_getBalance",
			params: ["0x7ba661f0e68dcfa31c8c20f21d42bc0b973920ee79904bd5683c9259a9925fdf"],
		});

		expect(post).not.toHaveBeenCalled();
		expect(result.result.totalBalance).toBe("1");
		expect(result.method).toBe("suix_getBalance");
	});

	it("returns a clear error for Sui methods that are not translated", async () => {
		await expect(
			forwardRequest({
				chain: "sui",
				method: "sui_getObject",
				params: ["0x2"],
			})
		).rejects.toMatchObject({
			status: 501,
			code: "sui_json_rpc_unavailable",
		});
		expect(post).not.toHaveBeenCalled();
		expect(querySuiGraphql).not.toHaveBeenCalled();
	});
});
