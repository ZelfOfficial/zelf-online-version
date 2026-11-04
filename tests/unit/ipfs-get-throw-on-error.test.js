/**
 * A Pinata failure must stay an exception. Stripe webhooks pass throwOnError so an outage
 * is not collapsed into "no account" and acknowledged.
 */
jest.mock("../../Core/ipfs", () => ({
	filter: jest.fn(),
	retrieve: jest.fn(),
}));

const IPFS = require("../../Core/ipfs");
const { get } = require("../../Repositories/IPFS/modules/ipfs.module");

beforeEach(() => {
	IPFS.filter.mockReset();
	IPFS.filter.mockResolvedValue([]);
});

test("get forwards throwOnError to the IPFS filter", async () => {
	await get({ key: "accountEmail", value: "owner@zelf.example", throwOnError: true });

	expect(IPFS.filter).toHaveBeenCalledWith("accountEmail", "owner@zelf.example", { throwOnError: true });
});

test("get leaves throwOnError unset for ordinary lookups", async () => {
	await get({ key: "accountEmail", value: "owner@zelf.example", limit: 5 });

	expect(IPFS.filter).toHaveBeenCalledWith("accountEmail", "owner@zelf.example", { limit: 5 });
});
