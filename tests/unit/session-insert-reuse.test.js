const jwt = require("jsonwebtoken");
const config = require("../../Core/config");
const SessionModule = require("../../Repositories/Session/modules/session.module");

if (!config.JWT_SECRET) config.JWT_SECRET = "test-jwt-secret-key-for-testing-only";

const verifiedSession = () => ({
	_id: "507f1f77bcf86cd799439011",
	identifier: "device-1",
	clientIP: "203.0.113.8",
	domain: "zelf",
	ethAddress: "0xabc",
	activatedAt: new Date(),
	verifiedTagName: "alice.zelf",
	verifiedAt: new Date(),
	verifiedUntil: new Date(Date.now() + 10 * 60 * 1000),
});

const sessionIdOf = (token) => jwt.verify(token, config.JWT_SECRET).session;

describe("POST /api/sessions reuses a session only for its own token", () => {
	test("a caller without a token gets a new unverified session and never the existing token", () => {
		const existing = verifiedSession();
		const existingToken = SessionModule.sessionTokenResponse(existing, existing.ethAddress).token;

		const plan = SessionModule.prepareSessionInsert(
			{ identifier: "device-1", clientIP: "198.51.100.4" },
			null,
			existing
		);

		expect(plan.action).toBe("create");
		expect(plan.session).toBeUndefined();
		expect(plan.document.identifier).toBe("device-1");
		expect(plan.document.verifiedTagName).toBeNull();
		expect(plan.document.verifiedAt).toBeNull();
		expect(plan.document.verifiedUntil).toBeNull();
		expect(plan.document.tagName).toBeNull();

		const created = {
			...plan.document,
			_id: "507f1f77bcf86cd799439012",
			activatedAt: new Date(),
		};
		const createdToken = SessionModule.sessionTokenResponse(created, null).token;

		expect(sessionIdOf(createdToken)).not.toBe(sessionIdOf(existingToken));
		expect(jwt.verify(createdToken, config.JWT_SECRET).identifier).toBe("device-1");
		expect(jwt.verify(createdToken, config.JWT_SECRET).verifiedTagName).toBeUndefined();
	});

	test("the owner refresh with a valid token returns a token for that same session", () => {
		const existing = verifiedSession();
		const bearer = `Bearer ${SessionModule.sessionTokenResponse(existing, existing.ethAddress).token}`;
		const claims = SessionModule.claimsFromAuthorization(bearer);

		expect(claims.session).toBe(String(existing._id));

		const plan = SessionModule.prepareSessionInsert(
			{ identifier: "device-1", clientIP: "198.51.100.20" },
			claims,
			existing
		);

		expect(plan.action).toBe("refresh");
		expect(String(plan.session._id)).toBe(String(existing._id));

		const refreshed = SessionModule.sessionTokenResponse(plan.session, plan.session.ethAddress).token;
		const decoded = jwt.verify(refreshed, config.JWT_SECRET);

		expect(decoded.session).toBe(String(existing._id));
		expect(decoded.identifier).toBe("device-1");
		expect(decoded.verifiedTagName).toBeUndefined();
	});

	test("a token for a different session does not refresh the stored session", () => {
		const existing = verifiedSession();
		const plan = SessionModule.prepareSessionInsert(
			{ identifier: "device-1", clientIP: existing.clientIP },
			{ session: "507f1f77bcf86cd799439099", identifier: "someone-else" },
			{ ...existing, _id: "507f1f77bcf86cd799439099", identifier: "someone-else" }
		);

		expect(plan.action).toBe("create");
		expect(plan.document.identifier).toBe("device-1");
		expect(plan.document.verifiedTagName).toBeNull();
	});

	test("killSession without a token is rejected and does not select the stored session", async () => {
		await expect(
			SessionModule.insert({
				identifier: "device-1",
				clientIP: "203.0.113.8",
				killSession: 1,
			})
		).rejects.toMatchObject({
			status: 401,
			code: "SESSION_TOKEN_REQUIRED",
			clientCode: "SESSION_TOKEN_REQUIRED",
		});

		const plan = SessionModule.prepareSessionInsert(
			{ identifier: "device-1", clientIP: "203.0.113.8", killSession: true },
			null,
			verifiedSession()
		);

		expect(plan.action).toBe("reject");
		expect(plan.code).toBe("SESSION_TOKEN_REQUIRED");
		expect(plan.session).toBeUndefined();
	});

	test("killSession with a token for another session is rejected", () => {
		const existing = verifiedSession();
		const plan = SessionModule.prepareSessionInsert(
			{ identifier: existing.identifier, clientIP: existing.clientIP, killSession: 1 },
			{ session: "507f1f77bcf86cd799439099" },
			{ ...existing, _id: "507f1f77bcf86cd799439099", identifier: "someone-else" }
		);

		expect(plan.action).toBe("reject");
		expect(plan.code).toBe("SESSION_TOKEN_REQUIRED");
	});

	test("killSession with a valid token for that session replaces only that session", () => {
		const existing = verifiedSession();
		const claims = SessionModule.claimsFromAuthorization(
			`JWT ${SessionModule.sessionTokenResponse(existing, existing.ethAddress).token}`
		);
		const plan = SessionModule.prepareSessionInsert(
			{ identifier: "device-1", clientIP: "203.0.113.8", killSession: "1" },
			claims,
			existing
		);

		expect(plan.action).toBe("replace");
		expect(String(plan.session._id)).toBe(String(existing._id));
		expect(plan.document.identifier).toBe("device-1");
		expect(plan.document.verifiedTagName).toBeNull();
		expect(plan.document.verifiedAt).toBeNull();
	});

	test("a first session keeps the client identifier and starts unverified", () => {
		const plan = SessionModule.prepareSessionInsert(
			{
				identifier: "device-first",
				clientIP: "203.0.113.9",
				type: "general",
				tagName: "bob.zelf",
				verifiedTagName: "bob.zelf",
				zelfName: "bob.zelf",
			},
			null,
			null
		);

		expect(plan.action).toBe("create");
		expect(plan.document.identifier).toBe("device-first");
		expect(plan.document.verifiedTagName).toBeNull();
		expect(plan.document.tagName).toBeNull();
		expect(plan.document.type).toBe("general");

		const created = {
			...plan.document,
			_id: "507f1f77bcf86cd799439013",
			activatedAt: new Date(),
		};
		const decoded = jwt.verify(SessionModule.sessionTokenResponse(created, null).token, config.JWT_SECRET);

		expect(decoded.session).toBe("507f1f77bcf86cd799439013");
		expect(decoded.identifier).toBe("device-first");
		expect(decoded.tagName).toBeUndefined();
		expect(decoded.verifiedTagName).toBeUndefined();
	});

	test("an invalid or expired Authorization header is not a session token", () => {
		const existing = verifiedSession();
		const expired = jwt.sign(
			{ session: existing._id, identifier: existing.identifier, exp: Math.floor(Date.now() / 1000) - 30 },
			config.JWT_SECRET
		);

		expect(SessionModule.claimsFromAuthorization("Bearer not-a-jwt")).toBeNull();
		expect(SessionModule.claimsFromAuthorization(`Bearer ${expired}`)).toBeNull();
		expect(
			SessionModule.presentedSessionClaims("Bearer not-a-jwt", { session: existing._id, identifier: existing.identifier })
		).toBeNull();

		const plan = SessionModule.prepareSessionInsert(
			{ identifier: existing.identifier, clientIP: existing.clientIP },
			SessionModule.claimsFromAuthorization(`Bearer ${expired}`),
			existing
		);

		expect(plan.action).toBe("create");
		expect(plan.document.verifiedTagName).toBeNull();
	});
});
