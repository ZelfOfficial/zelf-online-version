jest.mock("../../Repositories/base/modules/base-scrapping.module", () => ({
	getAddress: jest.fn(),
	getTokens: jest.fn(),
	getTransactionsList: jest.fn(),
	getTransactionStatus: jest.fn(),
	getGasTracker: jest.fn(),
	getPortfolioSummary: jest.fn(),
}));

const { getTransactionsList } = require("../../Repositories/base/modules/base-scrapping.module");
const Controller = require("../../Repositories/base/controllers/base-scrapping.controller");

const TEST_ADDRESS = "0x75F766ae57E08C9470CCe2AC30dD2b6B009Fccde";

describe("Base transactions controller", () => {
	beforeEach(() => {
		getTransactionsList.mockReset();
	});

	it("returns BASE_HISTORY_FAILED when history throws", async () => {
		getTransactionsList.mockRejectedValue(new Error("history crashed"));
		const ctx = { request: { params: { address: TEST_ADDRESS }, query: {} }, status: 200, body: null };

		await Controller.transactions(ctx);

		expect(ctx.status).toBe(500);
		expect(ctx.body.code).toBe("BASE_HISTORY_FAILED");
	});
});
