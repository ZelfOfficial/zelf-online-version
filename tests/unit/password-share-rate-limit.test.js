const { errorHandler } = require("../../Core/http-handler");
const {
	assertPasswordShareRateLimit,
	_resetPasswordShareRateLimit,
} = require("../../Repositories/PasswordShare/modules/password-share-rate-limit.module");

describe("password share rate limit", () => {
	const previous = {
		create: process.env.PASSWORD_SHARE_CREATE_RATE_LIMIT_PER_MINUTE,
		metadata: process.env.PASSWORD_SHARE_METADATA_RATE_LIMIT_PER_MINUTE,
		reveal: process.env.PASSWORD_SHARE_REVEAL_RATE_LIMIT_PER_MINUTE,
	};

	beforeEach(() => {
		_resetPasswordShareRateLimit();
		process.env.PASSWORD_SHARE_CREATE_RATE_LIMIT_PER_MINUTE = "2";
		process.env.PASSWORD_SHARE_METADATA_RATE_LIMIT_PER_MINUTE = "2";
		process.env.PASSWORD_SHARE_REVEAL_RATE_LIMIT_PER_MINUTE = "1";
	});

	afterAll(() => {
		_resetPasswordShareRateLimit();
		for (const [kind, value] of Object.entries(previous)) {
			const envName =
				kind === "create"
					? "PASSWORD_SHARE_CREATE_RATE_LIMIT_PER_MINUTE"
					: kind === "metadata"
						? "PASSWORD_SHARE_METADATA_RATE_LIMIT_PER_MINUTE"
						: "PASSWORD_SHARE_REVEAL_RATE_LIMIT_PER_MINUTE";
			if (value === undefined) delete process.env[envName];
			else process.env[envName] = value;
		}
	});

	test("caps reveal per IP and creation per session identifier", () => {
		expect(() => assertPasswordShareRateLimit("reveal", "203.0.113.8")).not.toThrow();

		try {
			assertPasswordShareRateLimit("reveal", "203.0.113.8");
			throw new Error("expected rate limit");
		} catch (error) {
			const handled = errorHandler(error);
			expect(handled.status).toBe(429);
			expect(handled.code).toBe("PASSWORD_SHARE_RATE_LIMITED");
			expect(handled.message).toBe("PASSWORD_SHARE_RATE_LIMITED");
			expect(error.retryAfterSeconds).toBeGreaterThan(0);
		}

		expect(() => assertPasswordShareRateLimit("reveal", "203.0.113.9")).not.toThrow();

		expect(() => assertPasswordShareRateLimit("create", "203.0.113.8", "owner-a")).not.toThrow();
		expect(() => assertPasswordShareRateLimit("create", "203.0.113.8", "owner-a")).not.toThrow();
		expect(() => assertPasswordShareRateLimit("create", "203.0.113.8", "owner-a")).toThrow(/PASSWORD_SHARE_RATE_LIMITED/);
		expect(() => assertPasswordShareRateLimit("create", "203.0.113.8", "owner-b")).not.toThrow();
	});
});
