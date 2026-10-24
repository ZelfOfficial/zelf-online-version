jest.mock("../../Repositories/Tags/modules/tag-smart-contract-payment.module", () => ({
	throwPaymentConfirmationTagNotFound: jest.fn(),
	verifySmartContractPayment: jest.fn(),
}));

jest.mock("../../Repositories/Tags/modules/my-tags.module", () => ({
	confirmPayUniqueAddress: jest.fn(),
}));

jest.mock("../../Repositories/ZelfID/modules/zelf-id-purchase-manual-review.module", () => ({
	recordPurchaseManualReview: jest.fn(),
}));

jest.mock("../../Repositories/ZelfID/modules/zelf-id.module", () => ({
	searchTag: jest.fn(),
}));

const moment = require("moment");
const { buildMetadata } = require("../../Repositories/ZelfID/modules/zelf-ids-payment.module");
const { addDurationToTag } = require("../../Repositories/ZelfID/modules/my-zelf-id.module");
const { expandStoredExtraParams, PINATA_KEYVALUE_MAX_LENGTH, PIN_EXTRA_PARAMS_SAFE_LENGTH } = require("../../Repositories/Tags/modules/tags-addresses.module");

const readExtra = (value, planTerm) => {
	const built = value && typeof value === "object" && value.metadata ? value : null;
	const raw = built ? built.metadata.extraParams : value;
	const term = planTerm || built?.planTerm;
	const extra = expandStoredExtraParams(raw);
	if (term?.planExpiresAt && !extra.planExpiresAt) extra.planExpiresAt = term.planExpiresAt;
	if (term?.paymentMethod && !extra.paymentMethod) extra.paymentMethod = term.paymentMethod;
	return extra;
};

const { zelfPlanLicense } = require("../fixtures/zelf-plan-license.fixture");
const domainConfig = zelfPlanLicense();

describe("zelf-ids-payment.module", () => {
	test("buildMetadata stamps a long name as the requested paid plan", () => {
		const tagObject = {
			publicData: {
				origin: "online",
				type: "mainnet",
				plan: "free",
				hasPassword: "true",
				v: "4",
				duration: "0",
			},
		};

		const { metadata, fullTagName, planTerm } = buildMetadata(
			{ tagName: "zid12345", domain: "zelf", duration: 1, price: 24, plan: "premium" },
			tagObject,
			domainConfig
		);

		expect(fullTagName).toBe("zid12345.zelf");
		expect(metadata.tagName).toBe("zid12345.zelf");
		expect(metadata.domain).toBe("zelf");

		const extra = readExtra({ metadata, planTerm });
		expect(extra.plan).toBe("premium");
		expect(extra.type).toBe("mainnet");
		expect(Number(extra.v)).toBe(4);
		expect(extra.origin).toBe("online");
		expect(extra.expiresAt).toBeUndefined();
		expect(moment(extra.planExpiresAt).diff(moment(), "month")).toBeGreaterThanOrEqual(11);
	});

	test("buildMetadata can stamp a long name as unlimited when requested", () => {
		const tagObject = {
			publicData: {
				origin: "online",
				type: "mainnet",
				plan: "free",
				hasPassword: "true",
				v: "4",
			},
		};

		const { metadata, planTerm } = buildMetadata(
			{ tagName: "zid12345", domain: "zelf", duration: 1, price: 24, plan: "unlimited" },
			tagObject,
			domainConfig
		);
		const extra = readExtra({ metadata, planTerm });
		expect(extra.plan).toBe("unlimited");
		expect(extra.type).toBe("mainnet");
	});

	test("buildMetadata stamps a short hold as unlimited", () => {
		const tagObject = {
			publicData: {
				origin: "online",
				type: "hold",
				hasPassword: "true",
				v: "4",
			},
		};

		const { metadata, planTerm } = buildMetadata({ tagName: "mik", domain: "zelf", duration: 1, price: 99 }, tagObject, domainConfig);
		const extra = readExtra({ metadata, planTerm });
		expect(extra.plan).toBe("unlimited");
		expect(extra.type).toBe("mainnet");
	});

	test("buildMetadata resets free → paid instead of adding the free duration", () => {
		const tagObject = {
			publicData: {
				origin: "online",
				type: "mainnet",
				plan: "free",
				duration: "1",
				hasPassword: "true",
				v: "4",
				expiresAt: moment().add(99, "year").format("YYYY-MM-DD HH:mm:ss"),
			},
		};

		const { metadata, planTerm } = buildMetadata(
			{ tagName: "zid12345", domain: "zelf", duration: 1, price: 24, plan: "premium" },
			tagObject,
			domainConfig
		);
		const extra = readExtra({ metadata, planTerm });
		expect(extra.duration).toBe("1");
		expect(extra.expiresAt).toBe(tagObject.publicData.expiresAt);
		expect(moment(extra.planExpiresAt).diff(moment(), "year", true)).toBeGreaterThan(0.9);
		expect(moment(extra.planExpiresAt).diff(moment(), "year", true)).toBeLessThan(1.2);
	});

	test("a 1y coupon on a free name stays one year when the record was already rewritten as paid", () => {
		const freePublic = {
			origin: "online",
			type: "mainnet",
			plan: "free",
			duration: 100,
			hasPassword: "true",
			v: "4",
			expiresAt: moment().add(100, "year").format("YYYY-MM-DD HH:mm:ss"),
		};
		const rewritten = {
			publicData: {
				...freePublic,
				plan: "unlimited",
				duration: "1",
				expiresAt: moment().add(1, "year").format("YYYY-MM-DD HH:mm:ss"),
			},
		};

		const { metadata, planTerm } = buildMetadata(
			{
				tagName: "myname",
				domain: "zelf",
				duration: 1,
				price: 0,
				plan: "unlimited",
				paymentMethod: "coupon",
				basePublicData: freePublic,
			},
			rewritten,
			domainConfig
		);
		const extra = readExtra({ metadata, planTerm });
		expect(extra.duration).toBe("100");
		expect(planTerm.duration).toBe("1");
		expect(extra.paymentMethod).toBe("coupon");
		expect(extra.expiresAt).toBe(freePublic.expiresAt);
		expect(moment(extra.planExpiresAt).diff(moment(), "year", true)).toBeGreaterThan(0.9);
		expect(moment(extra.planExpiresAt).diff(moment(), "year", true)).toBeLessThan(1.2);

		const stacked = readExtra(
			buildMetadata(
				{ tagName: "myname", domain: "zelf", duration: 1, price: 0, plan: "unlimited", paymentMethod: "coupon" },
				rewritten,
				domainConfig
			)
		);
		expect(stacked.duration).toBe("2");
	});

	test("a $0 whitelist grant stores paymentMethod whitelist", () => {
		const tagObject = {
			publicData: {
				origin: "online",
				type: "mainnet",
				plan: "free",
				duration: "1",
				hasPassword: "true",
				v: "4",
				expiresAt: moment().add(1, "year").format("YYYY-MM-DD HH:mm:ss"),
			},
		};
		const extra = readExtra(
			buildMetadata(
				{ tagName: "myname", domain: "zelf", duration: 1, price: 0, plan: "unlimited", paymentMethod: "whitelist" },
				tagObject,
				domainConfig
			)
		);
		expect(extra.paymentMethod).toBe("whitelist");
		expect(extra.price).toBe(0);
		expect(extra.duration).toBe("1");
		expect(extra.expiresAt).toBe(tagObject.publicData.expiresAt);
		expect(moment(extra.planExpiresAt).diff(moment(), "year", true)).toBeLessThan(1.2);
	});

	test("buildMetadata adds years onto an active paid expiration", () => {
		const stored = moment().add(8, "month").format("YYYY-MM-DD HH:mm:ss");
		const tagObject = {
			publicData: {
				origin: "online",
				type: "mainnet",
				plan: "premium",
				duration: "2",
				hasPassword: "true",
				v: "4",
				expiresAt: stored,
			},
		};

		const { metadata, planTerm } = buildMetadata(
			{ tagName: "zid12345", domain: "zelf", duration: 3, price: 72, plan: "premium" },
			tagObject,
			domainConfig
		);
		const extra = readExtra({ metadata, planTerm });
		expect(extra.duration).toBe("5");
		expect(moment(extra.expiresAt).diff(moment(stored, "YYYY-MM-DD HH:mm:ss"), "year", true)).toBeGreaterThanOrEqual(2.9);
	});

	test("buildMetadata stamps lifetime as 100 years from today", () => {
		const tagObject = {
			publicData: {
				origin: "online",
				type: "mainnet",
				plan: "premium",
				duration: "2",
				hasPassword: "true",
				v: "4",
				expiresAt: moment().add(8, "month").format("YYYY-MM-DD HH:mm:ss"),
			},
		};

		const { metadata, planTerm } = buildMetadata(
			{ tagName: "zid12345", domain: "zelf", duration: "999", price: 240, plan: "premium" },
			tagObject,
			domainConfig
		);
		const extra = readExtra({ metadata, planTerm });
		expect(extra.duration).toBe("lifetime");
		expect(moment(extra.expiresAt).diff(moment(), "year", true)).toBeGreaterThanOrEqual(99);
	});

	test("buildMetadata converts a hold pin to canonical mainnet", () => {
		const tagObject = {
			publicData: {
				origin: "online",
				type: "hold",
				tagName: "alice.zelf.hold",
				hasPassword: "true",
				v: "4",
				expiresAt: moment().add(29, "day").format("YYYY-MM-DD HH:mm:ss"),
			},
		};

		const { metadata, fullTagName, planTerm } = buildMetadata(
			{ tagName: "alice", domain: "zelf", duration: 1, price: 55 },
			tagObject,
			domainConfig
		);
		expect(fullTagName).toBe("alice.zelf");
		const extra = readExtra({ metadata, planTerm });
		expect(extra.type).toBe("mainnet");
		expect(extra.plan).toBe("unlimited");
	});

	test("buildMetadata resets v4miguelunittest1.zelf from now for free and planless v3.6", () => {
		const leftover = "2027-09-01 21:00:00";
		const freeObject = {
			publicData: {
				origin: "online",
				type: "mainnet",
				plan: "free",
				duration: "1",
				hasPassword: "true",
				v: "4",
				expiresAt: leftover,
			},
		};
		const freeExtra = readExtra(
			buildMetadata(
				{ tagName: "v4miguelunittest1", domain: "zelf", duration: 1, price: 24, plan: "premium" },
				freeObject,
				domainConfig
			)
		);
		expect(freeExtra.plan).toBe("premium");
		expect(freeExtra.duration).toBe("1");
		expect(freeExtra.expiresAt).toBe(leftover);
		expect(moment(freeExtra.planExpiresAt).diff(moment(), "year", true)).toBeGreaterThan(0.9);
		expect(moment(freeExtra.planExpiresAt).diff(moment(), "year", true)).toBeLessThan(1.2);

		const planlessObject = {
			publicData: {
				origin: "online",
				type: "mainnet",
				duration: "1",
				price: 0,
				hasPassword: "true",
				v: "3",
				expiresAt: leftover,
			},
		};
		const planlessExtra = readExtra(
			buildMetadata(
				{ tagName: "v4miguelunittest1", domain: "zelf", duration: 1, price: 24, plan: "premium" },
				planlessObject,
				domainConfig
			)
		);
		expect(planlessExtra.duration).toBe("1");
		expect(moment(planlessExtra.expiresAt).diff(moment(), "year", true)).toBeLessThan(2);
	});

	test("buildMetadata adds onto v4miguelunittest2.zelf for v4 premium and v3.6 paid", () => {
		const stored = moment().add(8, "month").format("YYYY-MM-DD HH:mm:ss");
		const v4Object = {
			publicData: {
				origin: "online",
				type: "mainnet",
				plan: "premium",
				duration: "1",
				hasPassword: "true",
				v: "4",
				expiresAt: stored,
			},
		};
		const v4Extra = readExtra(
			buildMetadata(
				{ tagName: "v4miguelunittest2", domain: "zelf", duration: 1, price: 24, plan: "premium" },
				v4Object,
				domainConfig
			)
		);
		expect(v4Extra.duration).toBe("2");
		expect(moment(v4Extra.expiresAt).diff(moment(stored, "YYYY-MM-DD HH:mm:ss"), "year", true)).toBeGreaterThanOrEqual(0.9);

		const v36Object = {
			publicData: {
				origin: "online",
				type: "mainnet",
				duration: "1",
				price: 24,
				renewedAt: "2026-03-01 12:00:00",
				hasPassword: "true",
				v: "3",
				expiresAt: stored,
			},
		};
		const v36Extra = readExtra(
			buildMetadata(
				{ tagName: "v4miguelunittest2", domain: "zelf", duration: 1, price: 24, plan: "premium" },
				v36Object,
				domainConfig
			)
		);
		expect(v36Extra.duration).toBe("2");
		expect(moment(v36Extra.expiresAt).diff(moment(stored, "YYYY-MM-DD HH:mm:ss"), "year", true)).toBeGreaterThanOrEqual(0.9);
	});

	test("addDurationToTag refuses unlimited -> premium downgrade before payment is captured", async () => {
		const tagObject = {
			publicData: {
				origin: "online",
				type: "mainnet",
				plan: "unlimited",
				duration: "1",
				tagName: "zid12345.zelf",
				hasPassword: "true",
				v: "4",
				expiresAt: moment().add(1, "year").format("YYYY-MM-DD HH:mm:ss"),
			},
		};

		await expect(
			addDurationToTag({ tagName: "zid12345", domain: "zelf", duration: 1, price: 29, plan: "premium", domainConfig }, tagObject)
		).rejects.toThrow("409:plan_downgrade_not_allowed");
	});

	test("buildMetadata keeps v=3 on a legacy Tags proof while still stamping plan", () => {
		const tagObject = {
			publicData: {
				origin: "online",
				type: "mainnet",
				tagName: "legacyname.zelf",
				hasPassword: "true",
				v: "3",
				expiresAt: moment().add(6, "month").format("YYYY-MM-DD HH:mm:ss"),
			},
		};

		const { metadata, planTerm } = buildMetadata(
			{ tagName: "legacyname", domain: "zelf", duration: 1, price: 24, plan: "premium" },
			tagObject,
			domainConfig
		);
		const extra = readExtra({ metadata, planTerm });
		expect(Number(extra.v)).toBe(3);
		expect(extra.plan).toBe("premium");
		expect(extra.type).toBe("mainnet");
	});

	test("stored keyvalues for the longest name and domain stay within the pin limit", () => {
		const tagName = "a".repeat(27);
		const domain = `${"b".repeat(61)}cd`;
		const leaseExpiresAt = moment().add(100, "year").format("YYYY-MM-DD HH:mm:ss");
		const tagObject = {
			publicData: {
				origin: "online",
				type: "mainnet",
				plan: "free",
				duration: "100",
				hasPassword: "true",
				v: "4",
				domain,
				expiresAt: leaseExpiresAt,
			},
		};
		const paths = [
			["coupon", "coupon", 0],
			["whitelist", "whitelist", 0],
			["stripe", "stripe", 990],
			["crypto", "crypto", 990],
		];
		const durations = [1, 5, "lifetime"];
		const maxByPath = {};

		for (const [label, paymentMethod, price] of paths) {
			for (const duration of durations) {
				const { metadata, fullTagName, planTerm } = buildMetadata(
					{ tagName, domain, duration, price, plan: "unlimited", paymentMethod },
					tagObject,
					domainConfig
				);
				const stored = metadata.extraParams;
				const v3 = JSON.parse(stored);
				expect(stored.length).toBeLessThanOrEqual(PIN_EXTRA_PARAMS_SAFE_LENGTH);
				expect(stored.length).toBeLessThanOrEqual(PINATA_KEYVALUE_MAX_LENGTH);
				expect(fullTagName.length).toBeLessThanOrEqual(PINATA_KEYVALUE_MAX_LENGTH);
				expect(String(metadata.domain).length).toBeLessThanOrEqual(PINATA_KEYVALUE_MAX_LENGTH);
				expect(v3.expiresAt).toBe(leaseExpiresAt);
				expect(v3.plan).toBe("unlimited");
				expect(v3.duration).toBe("100");
				expect(planTerm.duration).toBe(duration === "lifetime" ? "lifetime" : String(duration));
				expect(v3.registeredAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
				expect(v3.planExpiresAt).toBeUndefined();
				expect(v3.paymentMethod).toBeUndefined();
				expect(v3.couponId).toBeUndefined();
				expect(v3.e).toBeUndefined();
				const expanded = readExtra({ metadata, planTerm });
				expect(expanded.paymentMethod).toBe(paymentMethod);
				if (duration === "lifetime") {
					expect(expanded.planExpiresAt).toBeUndefined();
				} else {
					expect(moment.utc(expanded.planExpiresAt, "YYYY-MM-DD HH:mm:ss").diff(moment.utc(), "year", true)).toBeGreaterThan(duration - 0.2);
					expect(moment.utc(expanded.planExpiresAt, "YYYY-MM-DD HH:mm:ss").diff(moment.utc(), "year", true)).toBeLessThan(duration + 0.2);
				}
				maxByPath[label] = Math.max(maxByPath[label] || 0, stored.length);
			}
		}

		expect(maxByPath).toEqual({
			coupon: 214,
			whitelist: 214,
			stripe: 216,
			crypto: 216,
		});
	});

	test("a v3 parser reads expiresAt, plan, and duration from the pin", () => {
		const leaseExpiresAt = "2126-10-24 18:00:00";
		const built = buildMetadata(
			{ tagName: "myname", domain: "zelf", duration: 1, price: 0, plan: "premium", paymentMethod: "coupon" },
			{
				publicData: {
					origin: "online",
					type: "mainnet",
					plan: "free",
					duration: "100",
					hasPassword: "true",
					v: "4",
					registeredAt: "2019-06-01 00:00:00",
					expiresAt: leaseExpiresAt,
				},
			},
			domainConfig
		);
		const v3 = JSON.parse(built.metadata.extraParams);
		expect(v3.expiresAt).toBe(leaseExpiresAt);
		expect(v3.plan).toBe("premium");
		expect(v3.duration).toBe("100");
		expect(v3.registeredAt).toBe("2019-06-01 00:00:00");
		expect(built.planTerm.duration).toBe("1");
		expect(built.planTerm.paymentMethod).toBe("coupon");
		expect(built.planTerm.planExpiresAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
	});

	test("buildMetadata throws before a keyvalue over the pin limit is stored", () => {
		const tagObject = {
			publicData: {
				origin: "x".repeat(300),
				type: "mainnet",
				plan: "free",
				duration: "100",
				hasPassword: "true",
				v: "4",
				expiresAt: moment().add(100, "year").format("YYYY-MM-DD HH:mm:ss"),
			},
		};
		expect(() =>
			buildMetadata({ tagName: "myname", domain: "zelf", duration: 1, price: 0, plan: "premium", paymentMethod: "coupon" }, tagObject, domainConfig)
		).toThrow("409:stored_metadata_too_long");
	});
});
