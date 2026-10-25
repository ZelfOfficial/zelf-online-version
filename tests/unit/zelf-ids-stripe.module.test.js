const {
	SOURCE,
	TYPE,
	buildLeaseStripeMetadata,
	parseLeaseStripeMetadata,
	inspectStripeLeaseSession,
} = require("../../Repositories/ZelfID/modules/zelf-ids-stripe.module");

describe("zelf-ids-stripe.module metadata", () => {
	test("buildLeaseStripeMetadata stamps identifiers as strings", () => {
		const metadata = buildLeaseStripeMetadata({
			tagName: "ONE610",
			domain: "zelf",
			duration: 3,
			plan: "premium",
			amountUsd: 61,
		});

		expect(metadata).toEqual({
			source: SOURCE,
			type: TYPE,
			tagName: "ONE610",
			domain: "zelf",
			duration: "3",
			plan: "premium",
			amountUsd: "61",
		});
	});

	test("buildLeaseStripeMetadata normalizes lifetime duration", () => {
		const metadata = buildLeaseStripeMetadata({
			tagName: "alice",
			domain: "zelf",
			duration: "999",
			plan: "unlimited",
			amountUsd: "360.00",
		});

		expect(metadata.duration).toBe("lifetime");
		expect(parseLeaseStripeMetadata(metadata)).toMatchObject({
			tagName: "alice",
			domain: "zelf",
			duration: "lifetime",
			plan: "unlimited",
			amountUsd: "360.00",
		});
	});

	test("parseLeaseStripeMetadata rejects missing identifiers or the wrong source", () => {
		expect(parseLeaseStripeMetadata({ source: SOURCE, type: TYPE, tagName: "a", domain: "zelf" })).toBeNull();
		expect(
			parseLeaseStripeMetadata({
				source: "dashboard",
				type: TYPE,
				tagName: "a",
				domain: "zelf",
				duration: "1",
				plan: "premium",
			})
		).toBeNull();
	});

	test("inspectStripeLeaseSession requires paid status and lease metadata", () => {
		const metadata = buildLeaseStripeMetadata({
			tagName: "qa99",
			domain: "zelf",
			duration: "1",
			plan: "unlimited",
			amountUsd: "36",
		});

		expect(inspectStripeLeaseSession({ metadata, payment_status: "unpaid" })).toEqual({
			ok: false,
			reason: "unpaid",
			metadata: {
				tagName: "qa99",
				domain: "zelf",
				duration: "1",
				plan: "unlimited",
				amountUsd: "36",
			},
		});

		expect(
			inspectStripeLeaseSession({
				id: "cs_test_1",
				metadata,
				payment_status: "paid",
				created: 1710000000,
				amount_total: 3600,
			})
		).toEqual({
			ok: true,
			metadata: {
				tagName: "qa99",
				domain: "zelf",
				duration: "1",
				plan: "unlimited",
				amountUsd: "36",
			},
			created: 1710000000,
			amountTotal: 3600,
			sessionId: "cs_test_1",
		});
	});

	test("upgrade term start round-trips, and a quote without one stays without one", () => {
		const startedAt = "2026-01-01T00:00:00.000Z";
		const withStart = buildLeaseStripeMetadata({
			tagName: "qa99",
			domain: "zelf",
			duration: "1",
			plan: "unlimited",
			amountUsd: "70",
			upgradeTerm: {
				id: "term-1",
				planExpiresAt: "2027-06-01 00:00:00",
				amountPaidUsd: 29,
				duration: "1",
				termStartedAt: startedAt,
			},
		});
		expect(withStart.upgradeTermStartedAt).toBe(startedAt);
		expect(parseLeaseStripeMetadata(withStart).upgradeTerm).toMatchObject({
			planExpiresAt: "2027-06-01 00:00:00",
			amountPaidUsd: 29,
			termStartedAt: startedAt,
		});

		const legacy = buildLeaseStripeMetadata({
			tagName: "qa99",
			domain: "zelf",
			duration: "1",
			plan: "unlimited",
			amountUsd: "70",
			upgradeTerm: {
				id: "term-1",
				planExpiresAt: "2027-06-01 00:00:00",
				amountPaidUsd: 29,
				duration: "1",
			},
		});
		expect(legacy.upgradeTermStartedAt).toBeUndefined();
		expect(parseLeaseStripeMetadata(legacy).upgradeTerm.termStartedAt).toBeNull();
	});
});
