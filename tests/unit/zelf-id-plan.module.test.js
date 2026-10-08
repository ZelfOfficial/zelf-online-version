const moment = require("moment");
const {
	ZELF_ID_RESERVATION_DURATION,
	ZELF_ID_RESERVATION_HOURS,
	getReservationExpiresAt,
	getBareName,
	getBareNameLength,
	getReservationPinName,
	requiresHoldReservation,
	allowedPlansForName,
	resolvePaidPlan,
	resolveZelfIdPlan,
	resolveComplimentaryPlan,
	resolveUpgradePlan,
	effectivePlan,
	isUnpaidExpiredReservation,
	resolveV4PaymentStamp,
	resolvePaidExpiresAt,
	resolvePaidDurationStamp,
	hasActivePaidLease,
	normalizePaymentDuration,
	paymentDurationYears,
	isHoldName,
	isUnpaidReservation,
	FREE_EXPIRATION_YEARS,
	getZelfIdPrice,
	getZelfIdCheckoutPrice,
} = require("../../Repositories/ZelfID/modules/zelf-id-plan.module");

const licenseQuote = (price, extras = {}) => ({
	duration: "1",
	price,
	currency: "USD",
	reward: 0,
	discount: 0,
	priceWithoutDiscount: price,
	discountType: "percentage",
	length: extras.length,
	...extras,
});

const licenseDomain = (priceByName = {}) => ({
	getPrice: (tagName, duration, referralTagName) => {
		const bare = String(tagName || "").split(".")[0];
		let price = priceByName[bare] ?? priceByName["*"] ?? 40;
		if (referralTagName && String(referralTagName).includes("vip")) price = 0;
		else if (referralTagName) price = Math.round(price * 0.9 * 100) / 100;
		if (`${duration}` === "2") price = price * 2;
		if (`${duration}` === "lifetime") price = price * 10;
		return licenseQuote(price, { duration: `${duration}`, length: bare.length });
	},
});

describe("zelf-id-plan.module", () => {
	test("reservation window defaults to 1 year", () => {
		expect(ZELF_ID_RESERVATION_DURATION).toEqual({ amount: 1, unit: "year" });
		const expiresAt = getReservationExpiresAt();
		const yearsUntilExpiry = moment(expiresAt, "YYYY-MM-DD HH:mm:ss").diff(moment(), "year", true);
		expect(yearsUntilExpiry).toBeGreaterThanOrEqual(0.99);
		expect(yearsUntilExpiry).toBeLessThan(1.1);
		expect(ZELF_ID_RESERVATION_HOURS).toBeGreaterThan(8700);
	});

	test("getBareName strips TLD and .hold", () => {
		expect(getBareName("mik.zelf")).toBe("mik");
		expect(getBareName("mik.hold")).toBe("mik");
		expect(getBareName("alice.zelf.hold")).toBe("alice");
		expect(getBareName("zid12345.zelf")).toBe("zid12345");
	});

	test("getReservationPinName is name.domain.hold", () => {
		expect(getReservationPinName("alice", "zelf")).toBe("alice.zelf.hold");
		expect(getReservationPinName("alice.zelf", "zelf")).toBe("alice.zelf.hold");
		expect(getReservationPinName("alice.zelf.hold", "zelf")).toBe("alice.zelf.hold");
		expect(getReservationPinName("alice.hold")).toBe("alice.zelf.hold");
	});

	test(".hold is only for names of 5 characters or fewer", () => {
		expect(requiresHoldReservation("mik.zelf")).toBe(true);
		expect(requiresHoldReservation("abcde")).toBe(true);
		expect(requiresHoldReservation("abcdef.zelf")).toBe(false);
		expect(requiresHoldReservation("zid12345.zelf")).toBe(false);
		expect(allowedPlansForName("mik.zelf")).toEqual(["unlimited"]);
		expect(allowedPlansForName("zid12345.zelf")).toEqual(["free", "premium", "unlimited"]);
		expect(resolvePaidPlan("mik.zelf")).toBe("unlimited");
		expect(resolvePaidPlan({ tagName: "abcdef.zelf", requestedPlan: "unlimited" })).toBe("unlimited");
		expect(resolvePaidPlan({ tagName: "abcdef.zelf", requestedPlan: "premium" })).toBe("premium");
	});

	test("resolveZelfIdPlan: long names lease free; short confirms are unlimited", () => {
		expect(resolveZelfIdPlan({ tagName: "zid12345.zelf" })).toBe("free");
		expect(resolveZelfIdPlan({ tagName: "mik.zelf" })).toBe("unlimited");
		expect(getBareNameLength("mik.zelf")).toBe(3);
	});

	test("resolveComplimentaryPlan: $0 stays free for 6+ and unlimited for 1–5", () => {
		expect(resolveComplimentaryPlan({ tagName: "zid12345.zelf", price: 0 })).toBeUndefined();
		expect(resolveComplimentaryPlan({ tagName: "mik.zelf", price: 0 })).toBe("unlimited");
		expect(resolveComplimentaryPlan({ tagName: "zid12345.zelf", price: 24 })).toBeUndefined();
		expect(resolveComplimentaryPlan({ tagName: "mik.zelf", price: 40 })).toBeUndefined();
	});

	test("resolveUpgradePlan: long names choose premium or unlimited; short stays unlimited", () => {
		expect(resolveUpgradePlan({ tagName: "zid12345.zelf", requestedPlan: "premium" })).toBe("premium");
		expect(resolveUpgradePlan({ tagName: "zid12345.zelf", requestedPlan: "unlimited" })).toBe("unlimited");
		expect(resolveUpgradePlan({ tagName: "zid12345.zelf" })).toBe("premium");
		expect(resolveUpgradePlan({ tagName: "mik.zelf", requestedPlan: "premium" })).toBe("unlimited");
		expect(resolvePaidPlan("mik")).toBe("unlimited");
	});

	test("getZelfIdPrice reads the license table and never hardcodes a dollar amount", () => {
		const domainConfig = licenseDomain({ mik: 40, alice: 55, zid12345: 24 });

		const year = getZelfIdPrice({ tagName: "mik.zelf", duration: "1", domainConfig });
		expect(year.plan).toBe("unlimited");
		expect(year.allowedPlans).toEqual(["unlimited"]);
		expect(year.price).toBe(40);

		const twoYears = getZelfIdPrice({ tagName: "alice", duration: "2", domainConfig });
		expect(twoYears.price).toBe(110);
		expect(twoYears.plan).toBe("unlimited");

		const referred = getZelfIdPrice({
			tagName: "mik",
			duration: "1",
			referralTagName: "friend.zelf",
			domainConfig,
		});
		expect(referred.price).toBe(36);
		expect(referred.plan).toBe("unlimited");

		const complimentary = getZelfIdPrice({
			tagName: "mik",
			duration: "1",
			referralTagName: "vip.zelf",
			domainConfig,
		});
		expect(complimentary.price).toBe(0);
		expect(complimentary.plan).toBe("unlimited");
	});

	test("getZelfIdPrice: long names can stay free or pick a paid plan from the license", () => {
		const domainConfig = licenseDomain({ zid12345: 24 });

		const free = getZelfIdPrice({ tagName: "zid12345.zelf", duration: "1", domainConfig });
		expect(free.plan).toBe("free");
		expect(free.allowedPlans).toEqual(["free", "premium", "unlimited"]);
		expect(free.price).toBe(24);

		const premium = getZelfIdPrice({
			tagName: "zid12345.zelf",
			duration: "1",
			domainConfig,
			requestedPlan: "premium",
		});
		expect(premium.plan).toBe("premium");
		expect(premium.price).toBe(24);

		const unlimited = getZelfIdPrice({
			tagName: "zid12345.zelf",
			duration: "1",
			domainConfig,
			requestedPlan: "unlimited",
		});
		expect(unlimited.plan).toBe("unlimited");
		expect(unlimited.price).toBe(24);
	});

	test("getZelfIdPrice uses planPricing when the license has Premium/Unlimited tables", () => {
		const { Domain } = require("../../Repositories/Tags/modules/domain.class");
		const domain = new Domain({
			name: "zelf",
			tags: {
				payment: {
					pricingTable: {
						"6-15": { 1: 24, 2: 43, 3: 61, 4: 77, 5: 90, lifetime: 360 },
					},
					planPricing: {
						premium: {
							"6-15": { 1: 29, 2: 50, 3: 70, 4: 88, 5: 100, lifetime: 290 },
						},
						unlimited: {
							"6-15": { 1: 99, 2: 180, 3: 250, 4: 310, 5: 360, lifetime: 990 },
						},
					},
					rewardPrice: 10,
					whitelist: {},
				},
			},
		});

		expect(domain._lookupTablePrice(domain._pricingTableForPlan(), 8, "1")).toBe(24);
		expect(domain._lookupTablePrice(domain._pricingTableForPlan("premium"), 8, "1")).toBe(29);
		expect(domain._lookupTablePrice(domain._pricingTableForPlan("unlimited"), 8, "3")).toBe(250);

		const domainConfig = {
			getPrice: (tagName, duration, referralTagName, options = {}) => {
				const cell = domain._lookupTablePrice(domain._pricingTableForPlan(options.plan), String(tagName).split(".")[0].length, `${duration}`);
				return licenseQuote(cell, { duration: `${duration}` });
			},
		};

		const fallback = getZelfIdPrice({ tagName: "zid12345.zelf", duration: "1", domainConfig });
		expect(fallback.price).toBe(24);

		const premium = getZelfIdPrice({
			tagName: "zid12345.zelf",
			duration: "1",
			domainConfig,
			requestedPlan: "premium",
		});
		expect(premium.price).toBe(29);
		expect(premium.plan).toBe("premium");

		const unlimited = getZelfIdPrice({
			tagName: "zid12345.zelf",
			duration: "3",
			domainConfig,
			requestedPlan: "unlimited",
		});
		expect(unlimited.price).toBe(250);
		expect(unlimited.plan).toBe("unlimited");

		const withoutPlanTables = new Domain({
			name: "zelf",
			tags: {
				payment: {
					pricingTable: {
						"6-15": { 1: 24, 2: 43, 3: 61, 4: 77, 5: 90, lifetime: 360 },
					},
					rewardPrice: 10,
					whitelist: {},
				},
			},
		});
		expect(withoutPlanTables._lookupTablePrice(withoutPlanTables._pricingTableForPlan("premium"), 8, "1")).toBe(24);
		expect(withoutPlanTables._lookupTablePrice(withoutPlanTables._pricingTableForPlan("unlimited"), 8, "1")).toBe(24);
	});

	test("getZelfIdCheckoutPrice charges the plan the payment stamps", () => {
		const tables = {
			default: { "6-15": { 1: 24 }, 5: { 1: 30 } },
			premium: { "6-15": { 1: 28 }, 5: { 1: 30 } },
			unlimited: { "6-15": { 1: 99 }, 5: { 1: 150 } },
		};
		const domainConfig = {
			getPrice: (tagName, duration, referralTagName, options = {}) => {
				const length = String(tagName).split(".")[0].length;
				const key = length >= 6 && length <= 15 ? "6-15" : length;
				return licenseQuote(tables[options.plan || "default"][key][`${duration}`], { duration: `${duration}`, length });
			},
		};

		// No plan from the client: long names pay premium (what buildMetadata stamps), not the default table.
		const noPlan = getZelfIdCheckoutPrice({ tagName: "zid12345.zelf", duration: "1", domainConfig });
		expect(noPlan).toMatchObject({ price: 28, plan: "premium" });
		expect(resolveUpgradePlan({ tagName: "zid12345.zelf" })).toBe(noPlan.plan);

		expect(getZelfIdCheckoutPrice({ tagName: "zid12345.zelf", duration: "1", domainConfig, requestedPlan: "unlimited" })).toMatchObject({
			price: 99,
			plan: "unlimited",
		});

		// Short names are unlimited only, even when the client asks for premium.
		expect(getZelfIdCheckoutPrice({ tagName: "abcde", duration: "1", domainConfig, requestedPlan: "premium" })).toMatchObject({
			price: 150,
			plan: "unlimited",
		});

		// The lease/search quote for a long name stays on the free (default) table.
		expect(getZelfIdPrice({ tagName: "zid12345.zelf", duration: "1", domainConfig })).toMatchObject({ price: 24, plan: "free" });
	});

	test("getZelfIdPrice requires a license getPrice", () => {
		expect(() => getZelfIdPrice({ tagName: "mik.zelf" })).toThrow("409:license_price_required");
	});

	test("effectivePlan: expired mainnet reads as free, not a hold", () => {
		expect(
			effectivePlan({
				type: "mainnet",
				plan: "unlimited",
				expiresAt: moment().subtract(1, "day").format("YYYY-MM-DD HH:mm:ss"),
			})
		).toBe("free");

		expect(
			effectivePlan({
				type: "mainnet",
				plan: "premium",
				tagName: "zid12345.zelf",
				expiresAt: moment().add(6, "month").format("YYYY-MM-DD HH:mm:ss"),
			})
		).toBe("premium");

		expect(
			effectivePlan({
				type: "mainnet",
				plan: "premium",
				tagName: "mik.zelf",
				expiresAt: moment().add(6, "month").format("YYYY-MM-DD HH:mm:ss"),
			})
		).toBe("unlimited");
	});

	test("isUnpaidExpiredReservation deletes only expired unpaid holds", () => {
		expect(
			isUnpaidExpiredReservation({
				type: "hold",
				expiresAt: moment().subtract(6, "hour").format("YYYY-MM-DD HH:mm:ss"),
			})
		).toBe(true);

		expect(
			isUnpaidExpiredReservation({
				type: "hold",
				expiresAt: moment().add(4, "hour").format("YYYY-MM-DD HH:mm:ss"),
			})
		).toBe(false);

		expect(
			isUnpaidExpiredReservation({
				type: "mainnet",
				plan: "unlimited",
				expiresAt: moment().subtract(1, "day").format("YYYY-MM-DD HH:mm:ss"),
			})
		).toBe(false);

		expect(
			isUnpaidExpiredReservation({
				type: "mainnet",
				plan: "premium",
				expiresAt: moment().subtract(1, "day").format("YYYY-MM-DD HH:mm:ss"),
			})
		).toBe(false);
	});

	test("resolveV4PaymentStamp: short is unlimited; long uses the requested paid plan", () => {
		const short = resolveV4PaymentStamp({ tagName: "mik", encryptVersion: 4, durationYears: 1 });
		expect(short.plan).toBe("unlimited");
		expect(moment(short.expiresAt).diff(moment(), "month")).toBeGreaterThanOrEqual(11);

		expect(resolveV4PaymentStamp({ tagName: "longname", encryptVersion: 4, requestedPlan: "premium" }).plan).toBe("premium");
		expect(resolveV4PaymentStamp({ tagName: "longname", encryptVersion: 4, requestedPlan: "unlimited" }).plan).toBe("unlimited");
		expect(resolveV4PaymentStamp({ tagName: "longname", encryptVersion: 4 }).plan).toBe("premium");

		expect(resolveV4PaymentStamp({ tagName: "legacy", encryptVersion: 3 })).toEqual({});
	});

	test("normalizePaymentDuration maps 999 to lifetime", () => {
		expect(normalizePaymentDuration("999")).toBe("lifetime");
		expect(normalizePaymentDuration(999)).toBe("lifetime");
		expect(normalizePaymentDuration("lifetime")).toBe("lifetime");
		expect(normalizePaymentDuration("4")).toBe("4");
		expect(paymentDurationYears("lifetime")).toBe(100);
		expect(paymentDurationYears("3")).toBe(3);
	});

	test("free 6–27 registrations use a 100-year sentinel", () => {
		expect(FREE_EXPIRATION_YEARS).toBe(100);
		expect(getBareNameLength("abcdef")).toBe(6);
		expect(getBareNameLength("a".repeat(27))).toBe(27);
		expect(getBareNameLength("abcde")).toBe(5);
		expect(getBareNameLength("a".repeat(28))).toBe(28);
		expect(allowedPlansForName("abcdef.zelf")).toEqual(["free", "premium", "unlimited"]);
		expect(allowedPlansForName("a".repeat(27))).toEqual(["free", "premium", "unlimited"]);
		expect(allowedPlansForName("abcde")).toEqual(["unlimited"]);
		expect(allowedPlansForName("a".repeat(28))).toEqual([]);
	});

	test("getZelfIdPrice: complimentary long names stay free; lifetime uses the 10-year license key", () => {
		const domainConfig = licenseDomain({ zid12345: 24 });

		const complimentary = getZelfIdPrice({
			tagName: "zid12345.zelf",
			duration: "1",
			referralTagName: "vip.zelf",
			domainConfig,
		});
		expect(complimentary.price).toBe(0);
		expect(complimentary.plan).toBe("free");

		const lifetime = getZelfIdPrice({
			tagName: "zid12345.zelf",
			duration: "999",
			domainConfig,
			requestedPlan: "premium",
		});
		expect(lifetime.price).toBe(240);
		expect(lifetime.plan).toBe("premium");
	});

	test("resolvePaidExpiresAt: free and expired reset from now; active paid yearly adds", () => {
		const freeNow = resolvePaidExpiresAt({
			publicData: { plan: "free", type: "mainnet", expiresAt: moment().add(99, "year").format("YYYY-MM-DD HH:mm:ss") },
			duration: "2",
		});
		expect(moment(freeNow).diff(moment(), "year", true)).toBeGreaterThanOrEqual(1.9);
		expect(moment(freeNow).diff(moment(), "year", true)).toBeLessThan(3);

		const stored = moment().add(8, "month").format("YYYY-MM-DD HH:mm:ss");
		const renewed = resolvePaidExpiresAt({
			publicData: { plan: "premium", type: "mainnet", expiresAt: stored },
			duration: "3",
		});
		expect(moment(renewed).diff(moment(stored, "YYYY-MM-DD HH:mm:ss"), "year", true)).toBeGreaterThanOrEqual(2.9);

		const expiredReset = resolvePaidExpiresAt({
			publicData: {
				plan: "premium",
				type: "mainnet",
				expiresAt: moment().subtract(2, "month").format("YYYY-MM-DD HH:mm:ss"),
			},
			duration: "1",
		});
		expect(moment(expiredReset).diff(moment(), "month", true)).toBeGreaterThanOrEqual(11);

		const lifetime = resolvePaidExpiresAt({
			publicData: { plan: "premium", type: "mainnet", expiresAt: stored },
			duration: "lifetime",
		});
		expect(moment(lifetime).diff(moment(), "year", true)).toBeGreaterThanOrEqual(99);
	});

	test("explicit plan wins over the 50-year fallback; missing plan with 50+ years resets", () => {
		const far = moment().add(80, "year").format("YYYY-MM-DD HH:mm:ss");
		const explicitPaid = resolvePaidExpiresAt({
			publicData: { plan: "premium", type: "mainnet", expiresAt: far },
			duration: "1",
		});
		expect(moment(explicitPaid).diff(moment(far, "YYYY-MM-DD HH:mm:ss"), "year", true)).toBeGreaterThanOrEqual(0.9);

		const missingPlan = resolvePaidExpiresAt({
			publicData: { type: "mainnet", expiresAt: far, tagName: "legacyname.zelf" },
			duration: "1",
		});
		expect(moment(missingPlan).diff(moment(), "year", true)).toBeGreaterThanOrEqual(0.9);
		expect(moment(missingPlan).diff(moment(), "year", true)).toBeLessThan(2);
	});

	test("legacy holds never infer premium and keep hold naming variants", () => {
		expect(isHoldName("alice.zelf.hold")).toBe(true);
		expect(isHoldName("alice.hold.zelf")).toBe(true);
		expect(isHoldName("alice.zelf")).toBe(false);
		expect(isUnpaidReservation({ type: "hold", tagName: "alice.zelf.hold" })).toBe(true);
		expect(isUnpaidReservation({ type: "reserved", tagName: "alice.zelf" })).toBe(true);
		expect(isUnpaidReservation({ status: "hold", tagName: "alice.zelf" })).toBe(true);
		expect(effectivePlan({ type: "hold", tagName: "abcdef.zelf.hold" })).toBeUndefined();

		const holdExpiry = resolvePaidExpiresAt({
			publicData: {
				type: "hold",
				tagName: "alice.zelf.hold",
				expiresAt: moment().add(29, "day").format("YYYY-MM-DD HH:mm:ss"),
			},
			duration: "1",
		});
		expect(moment(holdExpiry).diff(moment(), "month", true)).toBeGreaterThanOrEqual(11);
	});

	test("planless mainnet infers premium/unlimited; expired planless is free", () => {
		expect(
			effectivePlan({
				type: "mainnet",
				tagName: "abcdef.zelf",
				expiresAt: moment().add(6, "month").format("YYYY-MM-DD HH:mm:ss"),
			})
		).toBe("premium");
		expect(
			effectivePlan({
				type: "mainnet",
				tagName: "mik.zelf",
				expiresAt: moment().add(6, "month").format("YYYY-MM-DD HH:mm:ss"),
			})
		).toBe("unlimited");
		expect(
			effectivePlan({
				type: "mainnet",
				tagName: "abcdef.zelf",
				expiresAt: moment().subtract(1, "day").format("YYYY-MM-DD HH:mm:ss"),
			})
		).toBe("free");
	});

	test("resolvePaidDurationStamp resets free→paid and adds active yearly", () => {
		expect(
			resolvePaidDurationStamp({
				publicData: { plan: "free", duration: "1", type: "mainnet" },
				duration: "2",
			})
		).toBe("2");
		expect(
			resolvePaidDurationStamp({
				publicData: { plan: "premium", duration: "2", type: "mainnet" },
				duration: "3",
			})
		).toBe("5");
		expect(
			resolvePaidDurationStamp({
				publicData: { plan: "premium", duration: "2", type: "mainnet" },
				duration: "lifetime",
			})
		).toBe("lifetime");
	});

	test("v4miguelunittest1.zelf resets from now when free or planless v3.6", () => {
		const leftover = "2027-09-01 21:00:00";
		const freeStamp = resolvePaidExpiresAt({
			publicData: {
				tagName: "v4miguelunittest1.zelf",
				plan: "free",
				type: "mainnet",
				expiresAt: leftover,
			},
			duration: "1",
		});
		expect(hasActivePaidLease({ tagName: "v4miguelunittest1.zelf", plan: "free", type: "mainnet", expiresAt: leftover })).toBe(false);
		expect(moment(freeStamp).diff(moment(), "year", true)).toBeGreaterThanOrEqual(0.9);
		expect(moment(freeStamp).diff(moment(), "year", true)).toBeLessThan(2);
		expect(moment(freeStamp).format("YYYY-MM-DD")).not.toBe("2028-09-01");

		const planlessFree = resolvePaidExpiresAt({
			publicData: {
				tagName: "v4miguelunittest1.zelf",
				type: "mainnet",
				duration: "1",
				price: 0,
				expiresAt: leftover,
			},
			duration: "1",
		});
		expect(moment(planlessFree).diff(moment(), "year", true)).toBeGreaterThanOrEqual(0.9);
		expect(moment(planlessFree).diff(moment(), "year", true)).toBeLessThan(2);
		expect(
			resolvePaidDurationStamp({
				publicData: { tagName: "v4miguelunittest1.zelf", type: "mainnet", duration: "1", price: 0, expiresAt: leftover },
				duration: "1",
			})
		).toBe("1");
	});

	test("v4miguelunittest2.zelf adds onto stored expiry for v4 premium or v3.6 paid", () => {
		const stored = moment().add(8, "month").format("YYYY-MM-DD HH:mm:ss");
		expect(
			hasActivePaidLease({
				tagName: "v4miguelunittest2.zelf",
				plan: "premium",
				type: "mainnet",
				expiresAt: stored,
			})
		).toBe(true);

		const v4Paid = resolvePaidExpiresAt({
			publicData: {
				tagName: "v4miguelunittest2.zelf",
				plan: "premium",
				type: "mainnet",
				expiresAt: stored,
			},
			duration: "1",
		});
		expect(moment(v4Paid).diff(moment(stored, "YYYY-MM-DD HH:mm:ss"), "year", true)).toBeGreaterThanOrEqual(0.9);

		const v36Paid = resolvePaidExpiresAt({
			publicData: {
				tagName: "v4miguelunittest2.zelf",
				type: "mainnet",
				duration: "1",
				price: 24,
				renewedAt: "2026-03-01 12:00:00",
				expiresAt: stored,
			},
			duration: "1",
		});
		expect(moment(v36Paid).diff(moment(stored, "YYYY-MM-DD HH:mm:ss"), "year", true)).toBeGreaterThanOrEqual(0.9);
		expect(
			resolvePaidDurationStamp({
				publicData: {
					tagName: "v4miguelunittest2.zelf",
					type: "mainnet",
					duration: "1",
					price: 24,
					renewedAt: "2026-03-01 12:00:00",
					expiresAt: stored,
				},
				duration: "1",
			})
		).toBe("2");
	});
});
