const { errorHandler } = require("../../Core/http-handler");
const {
	filterSessionInboundTransactions,
	parseTagPayAmount,
	coerceInitiatedAtUnix,
	txUnixSeconds,
	tagPayLegacyCumulativeConfirmation,
} = require("../../Repositories/Tags/modules/tag-pay-session-tx.util");

describe("tag-pay-session-tx.util", () => {
	describe("parseTagPayAmount", () => {
		it("accepts finite non-negative numbers", () => {
			expect(parseTagPayAmount(1.5)).toBe(1.5);
			expect(parseTagPayAmount("2")).toBe(2);
			expect(parseTagPayAmount(0)).toBe(0);
		});
		it("returns null for invalid values", () => {
			expect(parseTagPayAmount("x")).toBeNull();
			expect(parseTagPayAmount(NaN)).toBeNull();
			expect(parseTagPayAmount(-1)).toBeNull();
		});
	});

	describe("coerceInitiatedAtUnix", () => {
		it("floors valid numbers", () => {
			expect(coerceInitiatedAtUnix(1700000000.7)).toBe(1700000000);
		});
		it("returns null for invalid", () => {
			expect(coerceInitiatedAtUnix(null)).toBeNull();
			expect(coerceInitiatedAtUnix("")).toBeNull();
			expect(coerceInitiatedAtUnix("nope")).toBeNull();
		});
	});

	describe("txUnixSeconds", () => {
		it("reads common timestamp fields", () => {
			expect(txUnixSeconds({ timestamp: 1700000000 })).toBe(1700000000);
			expect(txUnixSeconds({ timeStamp: "1700000000" })).toBe(1700000000);
			expect(txUnixSeconds({ blocktime: 1700000000 })).toBe(1700000000);
		});
		it("converts ms to seconds", () => {
			expect(txUnixSeconds({ timestamp: 1700000000000 })).toBe(1700000000);
		});
		it("parses YYYY-MM-DD HH:mm:ss date", () => {
			expect(txUnixSeconds({ date: "2023-11-14 12:00:00" })).toBeGreaterThan(1e9);
		});
	});

	describe("filterSessionInboundTransactions", () => {
		const t0 = 1_700_000_000;
		const prevEnv = process.env.TAG_PAY_LEGACY_CUMULATIVE_CONFIRMATION;

		afterEach(() => {
			process.env.TAG_PAY_LEGACY_CUMULATIVE_CONFIRMATION = prevEnv;
		});

		it("with initiatedAt, includes only IN at or after cutoff (skew 60s default)", () => {
			process.env.TAG_PAY_LEGACY_CUMULATIVE_CONFIRMATION = "false";
			const txs = [
				{ traffic: "IN", amount: "99", timestamp: t0 - 120 },
				{ traffic: "IN", amount: "10", timestamp: t0 },
				{ traffic: "OUT", amount: "1", timestamp: t0 },
				{ traffic: "in", amount: "3", timestamp: t0 + 1 },
			];
			const filtered = filterSessionInboundTransactions(txs, t0);
			const sum = filtered.reduce((s, x) => s + Number(x.amount), 0);
			expect(sum).toBeCloseTo(13);
		});

		it("without initiatedAt returns empty unless legacy env is true", () => {
			process.env.TAG_PAY_LEGACY_CUMULATIVE_CONFIRMATION = "false";
			expect(filterSessionInboundTransactions([{ traffic: "IN", amount: "1", timestamp: t0 }], null)).toEqual([]);
			process.env.TAG_PAY_LEGACY_CUMULATIVE_CONFIRMATION = "true";
			const out = filterSessionInboundTransactions([{ traffic: "IN", amount: "1", timestamp: 1 }], null);
			expect(out).toHaveLength(1);
		});

		it("excludes IN rows with unknown time when session is scoped", () => {
			process.env.TAG_PAY_LEGACY_CUMULATIVE_CONFIRMATION = "false";
			const txs = [{ traffic: "IN", amount: "5" }];
			expect(filterSessionInboundTransactions(txs, t0)).toEqual([]);
		});
	});

	describe("tagPayLegacyCumulativeConfirmation", () => {
		const prev = process.env.TAG_PAY_LEGACY_CUMULATIVE_CONFIRMATION;
		afterEach(() => {
			process.env.TAG_PAY_LEGACY_CUMULATIVE_CONFIRMATION = prev;
		});
		it("reads env at call time", () => {
			process.env.TAG_PAY_LEGACY_CUMULATIVE_CONFIRMATION = "true";
			expect(tagPayLegacyCumulativeConfirmation()).toBe(true);
			process.env.TAG_PAY_LEGACY_CUMULATIVE_CONFIRMATION = "false";
			expect(tagPayLegacyCumulativeConfirmation()).toBe(false);
		});
	});
});

describe("errorHandler payment_confirmation tag_not_found", () => {
	it("returns distinct client code and message", () => {
		const err = new Error("404:TAG_NOT_FOUND");
		err.clientCode = "TAG_NOT_FOUND";
		err.clientMessage = "Tag not found or not indexed";
		const r = errorHandler(err);
		expect(r.status).toBe(404);
		expect(r.code).toBe("TAG_NOT_FOUND");
		expect(r.message).toBe("Tag not found or not indexed");
	});
});
