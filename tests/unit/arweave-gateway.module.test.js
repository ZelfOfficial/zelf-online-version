const axios = require("axios");
const config = require("../../Core/config");
const {
	getGraphqlGateways,
	getPublicGatewayUrl,
	getArnsGatewayHost,
	buildTxUrl,
	resolveContentUrl,
	_clearContentUrlCache,
	buildExplorerUrl,
	buildArnsUndernameUrl,
	isSingleTagLookupKey,
	postGraphql,
	postGraphqlToGateway,
} = require("../../Repositories/Arweave/modules/arweave-gateway.module");

describe("arweave-gateway.module", () => {
	beforeEach(() => {
		jest.restoreAllMocks();
		_clearContentUrlCache();
	});

	it("returns default ranked graphql gateways", () => {
		expect(getGraphqlGateways()).toEqual(config.arwave.graphqlGateways);
	});

	it("returns default public gateway url", () => {
		expect(getPublicGatewayUrl()).toBe(config.arwave.publicGatewayUrl);
	});

	it("returns default arns gateway host", () => {
		expect(getArnsGatewayHost()).toBe("ar.io");
	});

	it("builds tx and explorer urls", () => {
		expect(buildTxUrl("abc123")).toBe("https://arweave.net/abc123");
		expect(buildExplorerUrl("abc123")).toBe("https://viewblock.io/arweave/tx/abc123");
	});

	it("returns the ar.io url when that gateway serves the transaction", async () => {
		const probe = jest.fn(async (url) => url.startsWith("https://ar.io/"));

		await expect(resolveContentUrl("abc123", { probe, now: () => 1 })).resolves.toBe("https://ar.io/abc123");
		expect(probe).toHaveBeenCalledTimes(1);
		expect(probe.mock.calls[0][0]).toBe("https://ar.io/abc123");
	});

	it("falls through to arweave.net when ar.io does not serve the transaction", async () => {
		const probe = jest.fn(async (url) => url.startsWith("https://arweave.net/"));

		await expect(resolveContentUrl("def456", { probe, now: () => 1 })).resolves.toBe("https://arweave.net/def456");
		expect(probe.mock.calls[0][0]).toBe("https://ar.io/def456");
		expect(probe.mock.calls[1][0]).toBe("https://arweave.net/def456");
	});

	it("builds arns undername urls", () => {
		expect(buildArnsUndernameUrl("migueltrevino", "zelf")).toBe("https://migueltrevino_zelf.ar.io");
		expect(buildArnsUndernameUrl("migueltrevino", "bdag")).toBe("https://migueltrevino_bdag_zelf.ar.io");
	});

	it("detects single-tag lookup keys", () => {
		expect(isSingleTagLookupKey("tagName")).toBe(true);
		expect(isSingleTagLookupKey("zelfName")).toBe(true);
		expect(isSingleTagLookupKey("domain")).toBe(false);
	});

	it("postGraphqlToGateway returns edges on success", async () => {
		jest.spyOn(axios, "post").mockResolvedValue({
			data: {
				data: {
					transactions: {
						edges: [{ node: { id: "tx1" } }],
					},
				},
			},
		});

		const edges = await postGraphqlToGateway("https://arweave.net", "{ transactions { edges { node { id } } } }");
		expect(edges).toHaveLength(1);
		expect(axios.post).toHaveBeenCalledWith(
			"https://arweave.net/graphql",
			expect.any(Object),
			expect.objectContaining({ timeout: 10000 })
		);
	});

	it("postGraphql fails over to the next gateway", async () => {
		jest
			.spyOn(axios, "post")
			.mockRejectedValueOnce(new Error("gateway down"))
			.mockResolvedValueOnce({
				data: {
					data: {
						transactions: {
							edges: [{ node: { id: "tx2" } }],
						},
					},
				},
			});

		const edges = await postGraphql("{ transactions { edges { node { id } } } }");
		expect(edges).toHaveLength(1);
		expect(axios.post).toHaveBeenCalledTimes(2);
		expect(axios.post.mock.calls[0][0]).toBe("https://arweave.net/graphql");
		expect(axios.post.mock.calls[1][0]).toBe("https://arweave-search.goldsky.com/graphql");
	});

	it("postGraphql throws after all gateways fail", async () => {
		jest.spyOn(axios, "post").mockRejectedValue(new Error("all down"));

		await expect(postGraphql("{ transactions { edges { node { id } } } }")).rejects.toThrow("all down");
		expect(axios.post).toHaveBeenCalledTimes(getGraphqlGateways().length);
	});
});
