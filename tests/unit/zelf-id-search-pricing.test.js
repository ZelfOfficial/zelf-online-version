jest.mock("../../Repositories/Wallet/modules/stellar", () => ({
	createStellarWallet: jest.fn(),
	healPublicDataXlm: jest.fn(),
}));

jest.mock("../../Repositories/Tags/modules/tags-search.module", () => ({
	searchTag: jest.fn(),
}));

jest.mock("../../Repositories/Tags/modules/tags-ipfs.module", () => ({
	unPinFiles: jest.fn(),
	unpinContinuationSiblings: jest.fn(),
}));

const moment = require("moment");
const TagsSearchModule = require("../../Repositories/Tags/modules/tags-search.module");
const { searchTag, previewTag } = require("../../Repositories/ZelfID/modules/zelf-id.module");
const { getZelfIdCheckoutPrice } = require("../../Repositories/ZelfID/modules/zelf-id-plan.module");
const { Domain } = require("../../Repositories/Tags/modules/domain.class");

const buildDomainConfig = () => {
	const domain = new Domain({
		name: "zelf",
		tags: {
			payment: {
				pricingTable: {
					"1-5": { 1: 30, 2: 54, 3: 77, 4: 90, 5: 105, lifetime: 300 },
					"6-15": { 1: 24, 2: 43, 3: 61, 4: 77, 5: 90, lifetime: 360 },
				},
				planPricing: {
					premium: {
						"1-5": { 1: 30, 2: 54, 3: 77, 4: 90, 5: 105, lifetime: 300 },
						"6-15": { 1: 29, 2: 50, 3: 70, 4: 88, 5: 100, lifetime: 290 },
					},
					unlimited: {
						"1-5": { 1: 150, 2: 270, 3: 380, 4: 450, 5: 525, lifetime: 1500 },
						"6-15": { 1: 99, 2: 180, 3: 250, 4: 310, 5: 360, lifetime: 990 },
					},
				},
				rewardPrice: 10,
				whitelist: {},
			},
		},
	});

	return {
		name: "zelf",
		getTagKey: () => "tagName",
		getPrice: (tagName, duration, referralTagName, options = {}) => {
			const length = String(tagName).split(".")[0].length;
			const key = length >= 6 && length <= 15 ? "6-15" : "1-5";
			const table = domain._pricingTableForPlan(options.plan);
			const cell = domain._lookupTablePrice(table, length, `${duration}`);
			return {
				duration: `${duration}`,
				price: cell,
				currency: "USD",
				reward: 0,
				discount: 0,
				priceWithoutDiscount: cell,
				discountType: "percentage",
			};
		},
	};
};

describe("zelf-id search available pricing", () => {
	const domainConfig = buildDomainConfig();

	beforeEach(() => {
		jest.clearAllMocks();
	});

	const mockAvailableTagsSearch = (bare, tagsTableUsd = 30) => {
		TagsSearchModule.searchTag.mockResolvedValue({
			available: true,
			tagName: bare,
			price: { duration: "1", price: tagsTableUsd, currency: "USD" },
		});
	};

	const paymentOptionsUsd = (bare) =>
		getZelfIdCheckoutPrice({ tagName: `${bare}.zelf`, duration: "1", domainConfig }).price;

	test.each([
		["abc", 3, 30],
		["abcd", 4, 30],
		["abcde", 5, 30],
		["ninechars", 9, 24],
	])("GET search available %i-char name uses Zelf ID upgrade USD (not Tags default table)", async (bare, length, tagsTableUsd) => {
		expect(length).toBe(bare.length);
		mockAvailableTagsSearch(bare, tagsTableUsd);

		const result = await searchTag({ tagName: bare, domain: "zelf", domainConfig }, {});

		expect(result.available).toBe(true);
		expect(result.plan).toBe("free");
		expect(result.allowedPlans).toEqual(length <= 5 ? ["free", "unlimited"] : ["free", "premium", "unlimited"]);
		expect(result.price.plan).toBe("free");
		expect(result.price.allowedPlans).toEqual(result.allowedPlans);
		expect(result.price.price).toBe(paymentOptionsUsd(bare));
		expect(result.price.price).not.toBe(tagsTableUsd);
	});

	test("preview passes through available search pricing", async () => {
		mockAvailableTagsSearch("abc", 30);

		const preview = await previewTag({ tagName: "abc", domain: "zelf", domainConfig }, {});

		expect(preview.available).toBe(true);
		expect(preview.price.price).toBe(paymentOptionsUsd("abc"));
		expect(preview.plan).toBe("free");
	});
});

describe("zelf-id search legacy records", () => {
	const domainConfig = buildDomainConfig();

	beforeEach(() => {
		jest.clearAllMocks();
	});

	test("unexpired legacy .hold stays taken with hold metadata", async () => {
		const expiresAt = moment().add(29, "day").format("YYYY-MM-DD HH:mm:ss");
		TagsSearchModule.searchTag.mockResolvedValue({
			available: false,
			tagName: "mik",
			tagObject: {
				publicData: {
					type: "hold",
					tagName: "mik.zelf.hold",
					expiresAt,
				},
				ipfsId: "pin-hold",
			},
			ipfs: [{ id: "pin-hold" }],
		});

		const result = await searchTag({ tagName: "mik", domain: "zelf", domainConfig }, {});

		expect(result.available).toBe(false);
		expect(result.tagObject.publicData.type).toBe("hold");
		expect(result.tagObject.publicData.tagName).toBe("mik.zelf.hold");
		expect(result.tagObject.publicData.expiresAt).toBe(expiresAt);
		expect(result.plan).toBeUndefined();
	});

	test("planless v3.6 mainnet infers plan and keeps expiry (6+ premium)", async () => {
		const expiresAt = moment().add(8, "month").format("YYYY-MM-DD HH:mm:ss");
		TagsSearchModule.searchTag.mockResolvedValue({
			available: false,
			tagName: "abcdef",
			tagObject: {
				publicData: {
					type: "mainnet",
					tagName: "abcdef.zelf",
					expiresAt,
					duration: "1",
					price: 24,
					renewedAt: "2025-01-01 12:00:00",
				},
				ipfsId: "pin-v36",
			},
			ipfs: [{ id: "pin-v36" }],
		});

		const result = await searchTag({ tagName: "abcdef", domain: "zelf", domainConfig }, {});

		expect(result.available).toBe(false);
		expect(result.tagObject.publicData.plan).toBe("premium");
		expect(result.tagObject.publicData.expiresAt).toBe(expiresAt);
	});

	test("planless v3.6 short mainnet infers unlimited", async () => {
		const expiresAt = moment().add(6, "month").format("YYYY-MM-DD HH:mm:ss");
		TagsSearchModule.searchTag.mockResolvedValue({
			available: false,
			tagName: "mik",
			tagObject: {
				publicData: {
					type: "mainnet",
					tagName: "mik.zelf",
					expiresAt,
				},
				ipfsId: "pin-short",
			},
			ipfs: [{ id: "pin-short" }],
		});

		const result = await searchTag({ tagName: "mik", domain: "zelf", domainConfig }, {});

		expect(result.available).toBe(false);
		expect(result.tagObject.publicData.plan).toBe("unlimited");
		expect(result.tagObject.publicData.expiresAt).toBe(expiresAt);
	});
});
