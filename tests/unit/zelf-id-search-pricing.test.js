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
		// Which plans a length may take comes from the license; fixture license for tests.
		tags: require("../fixtures/zelf-plan-license.fixture").zelfPlanLicenseData().tags,
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

	test.each([
		["abc", 3, 30, 1, true],
		["abcd", 4, 30, 1, true],
		["abcde", 5, 30, 1, true],
		["ninechars", 9, 24, 100, false],
	])("GET search available %i-char name is free (price 0), not the Tags table", async (bare, length, tagsTableUsd, termYears, shortName) => {
		expect(length).toBe(bare.length);
		mockAvailableTagsSearch(bare, tagsTableUsd);

		const result = await searchTag({ tagName: bare, domain: "zelf", domainConfig }, {});

		expect(result.available).toBe(true);
		expect(result.plan).toBe("free");
		expect(result.allowedPlans).toEqual(length <= 5 ? ["free", "unlimited"] : ["free", "premium", "unlimited"]);
		expect(result.price.plan).toBe("free");
		expect(result.price.allowedPlans).toEqual(result.allowedPlans);
		expect(result.price.price).toBe(0);
		expect(result.price.reward).toBe(0);
		expect(result.price.currency).toBe("USD");
		expect(result.price.price).not.toBe(tagsTableUsd);
		expect(result.price.quotedPlan).toBeUndefined();
		expect(result.plans.free).toEqual({ price: 0, termYears, currency: "USD" });
		expect(result.eligibility).toEqual({
			premium: length > 5,
			unlimited: true,
			shortName,
			freeTermYears: termYears,
		});
	});

	test("preview passes through available search pricing", async () => {
		mockAvailableTagsSearch("abc", 30);

		const preview = await previewTag({ tagName: "abc", domain: "zelf", domainConfig }, {});

		expect(preview.available).toBe(true);
		expect(preview.price.price).toBe(0);
		expect(preview.plan).toBe("free");
		expect(preview.plans.free.termYears).toBe(1);
		expect(preview.eligibility.shortName).toBe(true);
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

describe("zelf-id search plan-aware pricing (license planPricing only)", () => {
	// Fixture license; production reads these from the IPFS license JSON.
	const licensed = new Domain({
		name: "zelf",
		tags: {
			payment: {
				pricingTable: {},
				planPricing: {
					premium: { "6-15": { 1: 11, 2: 22, lifetime: 33 } },
					unlimited: { "1-5": { 1: 70, lifetime: 700 }, "6-15": { 1: 44, 3: 55, lifetime: 66 } },
				},
				whitelist: {},
			},
		},
	});
	licensed.getTagKey = () => "tagName";

	beforeEach(() => {
		jest.clearAllMocks();
		TagsSearchModule.searchTag.mockResolvedValue({ available: true, tagName: "x" });
	});

	test("no plan: plans lists every offered plan for a long name; price is the free record", async () => {
		const result = await searchTag({ tagName: "miguelito", domain: "zelf", domainConfig: licensed }, {});
		expect(result.plans.premium).toEqual({ 1: 11, 2: 22, lifetime: 33 });
		expect(result.plans.unlimited).toEqual({ 1: 44, 3: 55, lifetime: 66 });
		expect(result.plans.free).toEqual({ price: 0, termYears: 100, currency: "USD" });
		expect(result.price.price).toBe(0);
		expect(result.price.reward).toBe(0);
		expect(result.price.quotedPlan).toBeUndefined();
		expect(result.plan).toBe("free");
		expect(result.eligibility).toEqual({ premium: true, unlimited: true, shortName: false, freeTermYears: 100 });
	});

	test("no plan: short name only lists the plans the license prices for it", async () => {
		const result = await searchTag({ tagName: "abc", domain: "zelf", domainConfig: licensed }, {});
		expect(result.plans.premium).toBeUndefined();
		expect(result.plans.unlimited).toEqual({ 1: 70, lifetime: 700 });
		expect(result.plans.free).toEqual({ price: 0, termYears: 1, currency: "USD" });
		expect(result.price.price).toBe(0);
		expect(result.eligibility.shortName).toBe(true);
		expect(result.eligibility.premium).toBe(false);
		expect(result.eligibility.freeTermYears).toBe(1);
	});

	test("plan=unlimited quotes unlimited on a long name", async () => {
		const result = await searchTag({ tagName: "miguelito", domain: "zelf", domainConfig: licensed, plan: "unlimited", duration: "lifetime" }, {});
		expect(result.price.price).toBe(66);
		expect(result.price.quotedPlan).toBe("unlimited");
		expect(result.plan).toBe("free");
	});

	test("plan=premium on a short name is rejected", async () => {
		await expect(searchTag({ tagName: "abc", domain: "zelf", domainConfig: licensed, plan: "premium" }, {})).rejects.toThrow(
			"409:PLAN_NOT_OFFERED_FOR_NAME"
		);
	});

	test("duration the license does not price for the plan is rejected", async () => {
		await expect(
			searchTag({ tagName: "miguelito", domain: "zelf", domainConfig: licensed, plan: "premium", duration: "3" }, {})
		).rejects.toThrow("409:PLAN_DURATION_NOT_OFFERED_BY_LICENSE");
	});

	test("duration 4 is quoted only when the license has that cell", async () => {
		await expect(
			searchTag({ tagName: "miguelito", domain: "zelf", domainConfig: licensed, plan: "premium", duration: "4" }, {})
		).rejects.toThrow("409:PLAN_DURATION_NOT_OFFERED_BY_LICENSE");

		const withFour = new Domain({
			name: "zelf",
			tags: {
				payment: {
					pricingTable: {},
					planPricing: { premium: { "6-15": { 1: 11, 4: 70 } }, unlimited: { "6-15": { 1: 44, 4: 80 } } },
					whitelist: {},
				},
			},
		});
		withFour.getTagKey = () => "tagName";
		const quoted = await searchTag(
			{ tagName: "miguelito", domain: "zelf", domainConfig: withFour, plan: "premium", duration: "4" },
			{}
		);
		expect(quoted.price.price).toBe(70);
		expect(quoted.price.quotedPlan).toBe("premium");
		expect(quoted.plans.premium["4"]).toBe(70);
		expect(quoted.plan).toBe("free");
	});
});

describe("zelf-id search free term and domains without plan prices", () => {
	const P = { 1: 29, 2: 43.49, 3: 56.99, 4: 69.49, 5: 80.99, lifetime: 144.99 };
	const U = { 1: 99, 2: 148.99, 3: 192.99, 4: 236.99, 5: 276.99, lifetime: 494.99 };

	const productionLike = (extra = {}) => {
		const domain = new Domain({
			name: "zelf",
			tags: {
				payment: {
					rewardPrice: 10,
					pricingTable: { "6-15": { 1: 24 } },
					planPricing: {
						premium: { "6-15": P, "16-27": P },
						unlimited: { 1: U, 2: U, 3: U, 4: U, 5: U, "6-15": U, "16-27": U },
					},
					whitelist: {},
				},
			},
			zelfkeys: extra.zelfkeys,
		});
		domain.getTagKey = () => "tagName";
		return domain;
	};

	beforeEach(() => {
		jest.clearAllMocks();
		TagsSearchModule.searchTag.mockResolvedValue({ available: true, tagName: "x" });
	});

	test("12-character name is free, with premium and unlimited including 4y and 5y", async () => {
		const domainConfig = productionLike({
			zelfkeys: { planLimits: { free: { passwords: 5, zotp: 3 } } },
		});
		const result = await searchTag({ tagName: "abcdefghijkl", domain: "zelf", domainConfig }, {});
		expect(result.price.price).toBe(0);
		expect(result.price.reward).toBe(0);
		expect(result.price.length).toBe(12);
		expect(result.plans.free).toEqual({
			price: 0,
			termYears: 100,
			currency: "USD",
			limits: { passwords: 5, zotp: 3 },
		});
		expect(result.plans.premium).toEqual(P);
		expect(result.plans.unlimited["4"]).toBe(236.99);
		expect(result.plans.unlimited["5"]).toBe(276.99);
		expect(result.eligibility).toEqual({ premium: true, unlimited: true, shortName: false, freeTermYears: 100 });
	});

	test("4-character name has no premium and a 1-year free term", async () => {
		const domainConfig = productionLike({
			zelfkeys: { planLimits: { free: { passwords: 5, zotp: 3 } } },
		});
		const result = await searchTag({ tagName: "xq7k", domain: "zelf", domainConfig }, {});
		expect(result.price.price).toBe(0);
		expect(result.plans.premium).toBeUndefined();
		expect(result.plans.free.limits).toBeUndefined();
		expect(result.plans.free.termYears).toBe(1);
		expect(result.eligibility.premium).toBe(false);
		expect(result.eligibility.shortName).toBe(true);
		expect(result.eligibility.freeTermYears).toBe(1);
		expect(result.allowedPlans).toEqual(["free", "unlimited"]);
	});

	test("plan=unlimited&duration=lifetime quotes that cell and keeps the record free", async () => {
		const result = await searchTag(
			{ tagName: "abcdefghijkl", domain: "zelf", domainConfig: productionLike(), plan: "unlimited", duration: "lifetime" },
			{}
		);
		expect(result.price.price).toBe(494.99);
		expect(result.price.quotedPlan).toBe("unlimited");
		expect(result.price.plan).toBe("free");
		expect(result.plan).toBe("free");
	});

	test("a domain with no planPricing is rejected for a new name and still returned when owned", async () => {
		const avax = new Domain({
			name: "avax",
			status: "active",
			tags: { payment: { pricingTable: { "6-15": { 1: 0.05 } }, planPricing: {} } },
		});
		avax.getTagKey = () => "tagName";

		await expect(searchTag({ tagName: "newname", domain: "avax", domainConfig: avax }, {})).rejects.toThrow("409:DOMAIN_NOT_OFFERED");

		TagsSearchModule.searchTag.mockResolvedValue({
			available: false,
			tagName: "owned",
			tagObject: { publicData: { type: "mainnet", tagName: "owned.avax", plan: "free" } },
		});
		const owned = await searchTag({ tagName: "owned", domain: "avax", domainConfig: avax }, {});
		expect(owned.available).toBe(false);
		expect(owned.tagObject.publicData.tagName).toBe("owned.avax");
		expect(owned.plans).toBeUndefined();
	});
});
