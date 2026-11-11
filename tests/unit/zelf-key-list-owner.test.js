const Middleware = require("../../Repositories/ZelfKeys/middlewares/zelf-key.middleware");
const { listOwner } = require("../../Repositories/ZelfKeys/modules/zelf-key-list-owner");

const future = () => Date.now() + 10 * 60 * 1000;
const past = () => Date.now() - 1000;

const verifiedSession = (overrides = {}) => ({
	status: "active",
	domain: "zelf",
	verifiedTagName: "alice.zelf",
	verifiedUntil: new Date(future()),
	...overrides,
});

const runList = async (validation, user, query) => {
	const ctx = {
		request: { query: { ...query } },
		state: { user },
		status: undefined,
		body: undefined,
	};
	let continued = false;

	await validation(ctx, async () => {
		continued = true;
	});

	return { ctx, continued };
};

describe("Zelf Keys list owner", () => {
	let warn;
	let errorLog;

	beforeEach(() => {
		warn = jest.spyOn(console, "warn").mockImplementation(() => {});
		errorLog = jest.spyOn(console, "error").mockImplementation(() => {});
	});

	afterEach(() => {
		warn.mockRestore();
		errorLog.mockRestore();
	});

	test("a verified session lists that wallet, and a device identifier is not the owner", () => {
		const decision = Middleware.resolveListOwner({
			authUser: { session: "507f1f77bcf86cd799439011", identifier: "device-fingerprint", domain: "zelf" },
			session: verifiedSession(),
		});

		expect(decision).toEqual({ ok: true, tagName: "alice", domain: "zelf" });
		expect(listOwner({ tagName: decision.tagName, identifier: "device-fingerprint", domain: decision.domain }).fullTagName).toBe(
			"alice.zelf"
		);
	});

	test("a session without a verified name is not an owner, even when the token carries tagName", () => {
		const decision = Middleware.resolveListOwner({
			authUser: { session: "507f1f77bcf86cd799439011", tagName: "alice", identifier: "device-fingerprint", domain: "zelf" },
			session: verifiedSession({ verifiedTagName: null, verifiedUntil: null, tagName: "alice" }),
		});

		expect(decision.ok).toBe(false);
		expect(decision.status).toBe(403);
		expect(decision.code).toBe("ERR_SESSION_NOT_VERIFIED");
	});

	test("an expired verification is rejected", () => {
		const decision = Middleware.resolveListOwner({
			authUser: { session: "507f1f77bcf86cd799439011", domain: "zelf" },
			session: verifiedSession({ verifiedUntil: new Date(past()) }),
			now: Date.now(),
		});

		expect(decision.code).toBe("ERR_SESSION_NOT_VERIFIED");
		expect(decision.status).toBe(403);
	});

	test("a token tagName that is not the stamp is rejected", () => {
		const decision = Middleware.resolveListOwner({
			authUser: { session: "507f1f77bcf86cd799439011", tagName: "bob.zelf", domain: "zelf" },
			session: verifiedSession(),
		});

		expect(decision.code).toBe("ERR_SESSION_OWNER_MISMATCH");
		expect(decision.status).toBe(403);
	});

	test("a missing session document is not verified", () => {
		const decision = Middleware.resolveListOwner({
			authUser: { session: "507f1f77bcf86cd799439011", domain: "zelf" },
			session: null,
		});

		expect(decision.status).toBe(401);
		expect(decision.code).toBe("ERR_SESSION_REQUIRED");
	});

	test("a stamp without an expiry is still the owner, matching v4", () => {
		const decision = Middleware.resolveListOwner({
			authUser: { session: "507f1f77bcf86cd799439011", identifier: "device-fingerprint", domain: "zelf" },
			session: verifiedSession({ verifiedUntil: null, verifiedTagName: "JimBot.Zelf" }),
		});

		expect(decision).toEqual({ ok: true, tagName: "jimbot", domain: "zelf" });
		expect(listOwner({ tagName: decision.tagName, domain: decision.domain, identifier: "device-fingerprint" }).fullTagName).toBe(
			"jimbot.zelf"
		);
	});

	test("an inactive session is rejected", () => {
		const decision = Middleware.resolveListOwner({
			authUser: { session: "507f1f77bcf86cd799439011", domain: "zelf" },
			session: verifiedSession({ status: "used" }),
		});

		expect(decision.code).toBe("ERR_SESSION_REQUIRED");
		expect(decision.status).toBe(401);
	});

	test("a query tagName is dropped and cannot select another wallet", () => {
		const ctx = {
			request: { query: { category: "password", tagName: "victim.zelf" } },
			state: { user: { identifier: "device-fingerprint", accountType: "staff", domain: "zelf" } },
		};

		Middleware.assignVerifiedListOwner(ctx, { tagName: "alice", domain: "zelf" });

		expect(ctx.request.query.tagName).toBeUndefined();
		expect(ctx.state.user.tagName).toBe("alice");
		expect(listOwner(ctx.state.user).fullTagName).toBe("alice.zelf");
		expect(listOwner({ tagName: "alice.zelf", domain: "zelf" }).fullTagName).toBe("alice.zelf");
	});

	test("a staff query and a device identifier are not a wallet name", () => {
		expect(() =>
			listOwner({ accountType: "staff", identifier: "device-fingerprint", domain: "zelf" })
		).toThrow("403:ERR_SESSION_NOT_VERIFIED");
		expect(errorLog).not.toHaveBeenCalled();
		expect(warn).not.toHaveBeenCalled();
	});

	test("a missing category stays a validation error and does not log a session rejection", async () => {
		const { ctx, continued } = await runList(Middleware.listValidation, { accountType: "staff", exp: 1 }, {});

		expect(continued).toBe(false);
		expect(ctx.status).toBe(409);
		expect(ctx.body.validationError).toBeTruthy();
		expect(warn).not.toHaveBeenCalled();
		expect(errorLog).not.toHaveBeenCalled();
	});

	test.each([
		["staff token", { accountType: "staff", email: "staff@zelf.world", exp: 1 }],
		["duration token", { zelfName: "alice.zelf", exp: 1 }],
		["client token", { email: "person@zelf.world", exp: 1 }],
		["missing user", undefined],
	])("%s cannot list and returns one line without a stack", async (_label, user) => {
		const { ctx, continued } = await runList(Middleware.listValidation, user, { category: "password", tagName: "victim.zelf" });

		expect(continued).toBe(false);
		expect(ctx.status).toBe(401);
		expect(ctx.body).toEqual({
			message: "A verified session is required",
			code: "ERR_SESSION_REQUIRED",
		});
		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn.mock.calls[0]).toEqual(["zelf-keys list: ERR_SESSION_REQUIRED"]);
		expect(errorLog).not.toHaveBeenCalled();
	});

	test("list-all uses the same session requirement", async () => {
		const { ctx, continued } = await runList(Middleware.listAllValidation, { zelfName: "alice.zelf", exp: 1 }, { tagName: "victim.zelf" });

		expect(continued).toBe(false);
		expect(ctx.status).toBe(401);
		expect(ctx.body.code).toBe("ERR_SESSION_REQUIRED");
		expect(warn).toHaveBeenCalledTimes(1);
		expect(errorLog).not.toHaveBeenCalled();
	});

	test("a session id that is not an ObjectId is a 401 and not a stack", async () => {
		const { ctx, continued } = await runList(
			Middleware.listValidation,
			{ session: "not-a-session", identifier: "device-fingerprint", domain: "zelf" },
			{ category: "notes" }
		);

		expect(continued).toBe(false);
		expect(ctx.status).toBe(401);
		expect(ctx.body.code).toBe("ERR_SESSION_REQUIRED");
		expect(warn).toHaveBeenCalledTimes(1);
		expect(typeof warn.mock.calls[0][0]).toBe("string");
		expect(errorLog).not.toHaveBeenCalled();
	});

	test("rejectListRequest writes the status and a single string", () => {
		const ctx = { status: 200, body: undefined };
		const allowed = Middleware.rejectListRequest(ctx, Middleware.LIST_ACCESS.NOT_VERIFIED);

		expect(allowed).toBe(false);
		expect(ctx.status).toBe(403);
		expect(ctx.body.code).toBe("ERR_SESSION_NOT_VERIFIED");
		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn.mock.calls[0]).toEqual(["zelf-keys list: ERR_SESSION_NOT_VERIFIED"]);
		expect(errorLog).not.toHaveBeenCalled();
	});
});
