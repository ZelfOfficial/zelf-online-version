jest.mock("../../Repositories/sui/modules/sui-graphql.client", () => ({
	querySuiGraphql: jest.fn(),
}));

const { querySuiGraphql } = require("../../Repositories/sui/modules/sui-graphql.client");
const sui = require("../../Repositories/TxNotifications/adapters/sui.adapter");

const ADDRESS = "0x7ba661f0e68dcfa31c8c20f21d42bc0b973920ee79904bd5683c9259a9925fdf";
const SUI_TYPE = "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI";

describe("sui notification adapter graphql client", () => {
	beforeEach(() => {
		querySuiGraphql.mockReset();
	});

	it("polls through the shared GraphQL client", async () => {
		querySuiGraphql.mockResolvedValue({
			transactions: {
				pageInfo: { endCursor: "cursor-1" },
				nodes: [
					{
						digest: "4msw82FU7zpYbZz6TiocYxCDGmzGdyfTcMG5AQKPX95X",
						sender: { address: "0xd265672730b0540ffd3569530682a0f02ef984b703457790554eb0e19329663a" },
						effects: {
							status: "SUCCESS",
							timestamp: "2026-09-30T17:27:40.287Z",
							balanceChanges: {
								nodes: [{ owner: { address: ADDRESS }, amount: "12195224", coinType: { repr: SUI_TYPE } }],
							},
						},
					},
				],
			},
		});

		const result = await sui.poll({
			address: ADDRESS,
			state: {},
			seen: new Set(),
			minTimestampMs: 0,
		});

		expect(querySuiGraphql).toHaveBeenCalledTimes(1);
		expect(querySuiGraphql.mock.calls[0][0]).toContain("affectedAddress");
		expect(result.state.cursor).toBe("cursor-1");
		expect(result.transfers).toEqual([
			expect.objectContaining({
				network: "sui",
				hash: "4msw82FU7zpYbZz6TiocYxCDGmzGdyfTcMG5AQKPX95X",
				asset: "SUI",
				amount: "0.012195224",
			}),
		]);
	});
});
