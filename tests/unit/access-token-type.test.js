const jwt = require("jsonwebtoken");
const moment = require("moment");
const Koa = require("koa");
const Router = require("@koa/router");
const request = require("supertest");
const koaJwt = require("koa-jwt");

const config = require("../../Core/config");
const SessionModule = require("../../Repositories/Session/modules/session.module");
const { signToken, acceptAccessToken, TOKEN_TYPES, isAcceptedAccessToken } = require("../../Core/jwt-claims");

if (!config.JWT_SECRET) config.JWT_SECRET = "test-jwt-secret-key-for-testing-only";

const buildApp = () => {
	const app = new Koa();
	app.use(async (ctx, next) => {
		try {
			await next();
		} catch (err) {
			if (err.status === 401) {
				ctx.status = 401;
				ctx.body = { error: "Protected resource, use Authorization header to get access" };
				return;
			}
			throw err;
		}
	});
	app.use(koaJwt({ secret: config.JWT_SECRET }));
	app.use(acceptAccessToken);

	const router = new Router();
	const ok = (ctx) => {
		ctx.body = { ok: true };
	};
	router.post("/api/zelf-keys/store/password", ok);
	router.get("/api/my-tags/payment-options", ok);
	router.post("/api/my-tags/payment-confirmation", ok);
	router.post("/api/my-zelf-name/renew", ok);
	app.use(router.routes());
	return app;
};

const sessionRecord = (overrides = {}) => ({
	_id: "507f1f77bcf86cd799439011",
	domain: "zelf",
	identifier: "device-extension",
	clientIP: "203.0.113.8",
	activatedAt: new Date(),
	isWebExtension: true,
	...overrides,
});

const sessionToken = (record = sessionRecord()) =>
	jwt.sign(SessionModule.sessionJwtClaims(record, null), config.JWT_SECRET, {
		expiresIn: SessionModule.sessionJwtExpiresInSeconds(record.activatedAt),
	});

const dashboardToken = () =>
	jwt.sign(
		{
			email: "owner@zelf.world",
			accountType: "client_account",
			exp: moment().add(30, "day").unix(),
		},
		config.JWT_SECRET
	);

const quoteToken = () =>
	signToken(
		{
			tagName: "other.zelf",
			ttl: moment().add(2, "hours").unix(),
			prices: { ETH: { amountToSend: 0.01 } },
			paymentAddress: { ethAddress: "0x0000000000000000000000000000000000000001" },
		},
		config.JWT_SECRET,
		{ typ: TOKEN_TYPES.quote, expiresIn: "2h" }
	);

describe("access token type gate", () => {
	const app = buildApp();

	const call = (method, path, token) => {
		const req = request(app.callback())[method](path);
		if (token) req.set("Authorization", `Bearer ${token}`);
		return req;
	};

	test("a missing or unsigned token keeps the existing protected-route response", async () => {
		const missing = await call("post", "/api/zelf-keys/store/password");
		expect(missing.status).toBe(401);
		expect(missing.body.error).toBe("Protected resource, use Authorization header to get access");
		expect(missing.body.code).toBeUndefined();

		const forged = jwt.sign({ typ: TOKEN_TYPES.quote, exp: moment().add(1, "hour").unix() }, "other-secret");
		const rejected = await call("post", "/api/my-zelf-name/renew", forged);
		expect(rejected.status).toBe(401);
		expect(rejected.body.code).toBeUndefined();
		expect(rejected.body.error).toBe("Protected resource, use Authorization header to get access");
	});

	test("a payment quote is rejected on store-password and on payment routes", async () => {
		const token = quoteToken();
		const store = await call("post", "/api/zelf-keys/store/password", token);
		const options = await call("get", "/api/my-tags/payment-options", token);
		const confirm = await call("post", "/api/my-tags/payment-confirmation", token);

		for (const response of [store, options, confirm]) {
			expect(response.status).toBe(401);
			expect(response.body.code).toBe("INVALID_TOKEN_TYPE");
			expect(response.body.error).toBe("INVALID_TOKEN_TYPE");
		}
	});

	test("a payment quote is accepted as Authorization only on my-zelf-name renew", async () => {
		const response = await call("post", "/api/my-zelf-name/renew", quoteToken());
		expect(response.status).toBe(200);
		expect(response.body.ok).toBe(true);
	});

	test("a record token is confined to renew and a price lock is rejected everywhere", async () => {
		const record = signToken({ tagName: "name.zelf" }, config.JWT_SECRET, { typ: TOKEN_TYPES.record, expiresIn: "2h" });
		const lock = signToken({ tagName: "name.zelf" }, config.JWT_SECRET, { typ: TOKEN_TYPES.priceLock, expiresIn: "30m" });

		expect((await call("post", "/api/my-zelf-name/renew", record)).status).toBe(200);
		expect((await call("post", "/api/zelf-keys/store/password", record)).body.code).toBe("INVALID_TOKEN_TYPE");
		expect((await call("post", "/api/my-zelf-name/renew", lock)).body.code).toBe("INVALID_TOKEN_TYPE");
		expect((await call("post", "/api/zelf-keys/store/password", lock)).body.code).toBe("INVALID_TOKEN_TYPE");
	});

	test("session tokens without typ keep working, including extension-shaped sessions", async () => {
		const extension = sessionToken();
		const dashboard = sessionToken(sessionRecord({ identifier: "dashboard", isWebExtension: false }));

		expect((await call("post", "/api/zelf-keys/store/password", extension)).status).toBe(200);
		expect((await call("get", "/api/my-tags/payment-options", extension)).status).toBe(200);
		expect((await call("post", "/api/my-tags/payment-confirmation", dashboard)).status).toBe(200);
		expect((await call("post", "/api/my-zelf-name/renew", dashboard)).status).toBe(200);
	});

	test("dashboard account tokens keep an exp claim and no typ", async () => {
		const token = dashboardToken();
		const decoded = jwt.verify(token, config.JWT_SECRET);
		expect(decoded.typ).toBeUndefined();
		expect(Number.isFinite(decoded.exp)).toBe(true);
		expect((await call("post", "/api/zelf-keys/store/password", token)).status).toBe(200);
		expect((await call("get", "/api/my-tags/payment-options", token)).status).toBe(200);
	});

	test("a typed session token is accepted and a token with neither typ nor exp is rejected", async () => {
		const typed = signToken({ identifier: "device", session: "s1" }, config.JWT_SECRET, {
			typ: TOKEN_TYPES.session,
			expiresIn: "10m",
		});
		const open = jwt.sign({ identifier: "device" }, config.JWT_SECRET);

		expect((await call("post", "/api/zelf-keys/store/password", typed)).status).toBe(200);
		const rejected = await call("post", "/api/zelf-keys/store/password", open);
		expect(rejected.status).toBe(401);
		expect(rejected.body.code).toBe("INVALID_TOKEN_TYPE");
		expect(isAcceptedAccessToken(jwt.verify(open, config.JWT_SECRET), { path: "/api/zelf-keys/store/password" })).toBe(false);
	});

	test("signToken forces typ quote even when the payload tries to set another type", () => {
		const token = signToken({ typ: "session", tagName: "name.zelf", superAdminId: "forged" }, config.JWT_SECRET, {
			typ: TOKEN_TYPES.quote,
			expiresIn: "2h",
		});
		const decoded = jwt.verify(token, config.JWT_SECRET);
		expect(decoded.typ).toBe("quote");
		expect(decoded.superAdminId).toBeUndefined();
		expect(decoded.tagName).toBe("name.zelf");
	});
});
