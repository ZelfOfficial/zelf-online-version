const moment = require("moment");
const mongoose = require("mongoose");
const Koa = require("koa");
const Router = require("@koa/router");
const request = require("supertest");
const koaJwt = require("koa-jwt");

const config = require("../../Core/config");
const { createBodyParser } = require("../../Core/request-body");
const { signToken, acceptAccessToken, TOKEN_TYPES } = require("../../Core/jwt-claims");

const secret = config.JWT_SECRET || "test-jwt-secret-key-for-testing-only";
if (!config.JWT_SECRET) config.JWT_SECRET = secret;

const ANONYMOUS_BODY = { error: "Protected resource, use Authorization header to get access" };
const FORBIDDEN_BODY = { error: "CLIENT_LOOKUP_FORBIDDEN", code: "CLIENT_LOOKUP_FORBIDDEN" };

const buildApp = () => {
	const app = new Koa();
	app.use(createBodyParser());
	app.use(async (ctx, next) => {
		try {
			await next();
		} catch (err) {
			if (err.status === 401) {
				ctx.status = 401;
				ctx.body = ANONYMOUS_BODY;
				return;
			}
			throw err;
		}
	});

	const unprotectedRouter = new Router();
	require("../../Repositories/Client/routes/unprotected-client.route")(unprotectedRouter);
	require("../../Repositories/Staff/routes/unprotected-staff.route")(unprotectedRouter);
	app.use(unprotectedRouter.routes());

	app.use(koaJwt({ secret: config.JWT_SECRET }));
	app.use(acceptAccessToken);

	const protectedRouter = new Router();
	require("../../Repositories/Client/routes/client.route")(protectedRouter);
	app.use(protectedRouter.routes());

	return app;
};

const clientToken = (claims = {}) =>
	signToken({ exp: moment().add(1, "hour").unix(), ...claims }, config.JWT_SECRET, { typ: TOKEN_TYPES.client });

const staffToken = (claims = {}) =>
	signToken({ exp: moment().add(1, "hour").unix(), ...claims }, config.JWT_SECRET, { typ: TOKEN_TYPES.staff });

const adminToken = () =>
	signToken({ exp: moment().add(1, "hour").unix(), role: "super_admin" }, config.JWT_SECRET, {
		typ: TOKEN_TYPES.superAdmin,
		role: "super_admin",
		superAdminId: new mongoose.Types.ObjectId().toString(),
	});

const sessionToken = (claims = {}) =>
	signToken(
		{
			identifier: "wallet-device-1",
			session: new mongoose.Types.ObjectId().toString(),
			exp: moment().add(30, "minutes").unix(),
			...claims,
		},
		config.JWT_SECRET,
		{ typ: TOKEN_TYPES.session }
	);

describe("GET /api/clients lookup authorization", () => {
	const app = buildApp();
	const server = () => request(app.callback());

	const lookup = (query, token) => {
		const req = server().get("/api/clients");
		if (token) req.set("Authorization", `Bearer ${token}`);
		if (query) req.query(query);
		return req;
	};

	test("anonymous callers get one response for registered-looking and unknown identifiers", async () => {
		const registeredEmail = await lookup({ email: "owner@example.com" });
		const unknownEmail = await lookup({ email: "nobody@example.com" });
		const registeredPhone = await lookup({ phone: "5550102030" });
		const unknownPhone = await lookup({ phone: "5559990000" });
		const noParams = await lookup();

		for (const response of [registeredEmail, unknownEmail, registeredPhone, unknownPhone, noParams]) {
			expect(response.status).toBe(401);
			expect(response.body).toEqual(ANONYMOUS_BODY);
			expect(response.body).not.toHaveProperty("data");
			expect(JSON.stringify(response.body)).not.toMatch(/publicData|accountEmail|accountPhone|cid|CLIENT_NOT_FOUND|client_not_found/i);
		}

		expect(JSON.stringify(registeredEmail.body)).toBe(JSON.stringify(unknownEmail.body));
		expect(JSON.stringify(registeredEmail.body)).toBe(JSON.stringify(registeredPhone.body));
		expect(JSON.stringify(registeredEmail.body)).toBe(JSON.stringify(unknownPhone.body));
		expect(JSON.stringify(registeredEmail.body)).toBe(JSON.stringify(noParams.body));
	});

	test("an owner can look up only the email and phone on the verified token", async () => {
		const token = clientToken({ email: "owner@example.com", phone: "5550102030" });

		const otherEmail = await lookup({ email: "other@example.com" }, token);
		const unknownEmail = await lookup({ email: "nobody@example.com" }, token);
		expect(otherEmail.status).toBe(403);
		expect(otherEmail.body).toEqual(FORBIDDEN_BODY);
		expect(unknownEmail.status).toBe(403);
		expect(JSON.stringify(otherEmail.body)).toBe(JSON.stringify(unknownEmail.body));
		expect(JSON.stringify(otherEmail.body)).not.toMatch(/other@example.com|nobody@example.com|publicData/);

		const otherPhone = await lookup({ phone: "5551112222" }, token);
		expect(otherPhone.status).toBe(403);
		expect(otherPhone.body).toEqual(FORBIDDEN_BODY);

		const ownEmail = await lookup({ email: "Owner@Example.com" }, token);
		expect(ownEmail.status).toBe(404);
		expect(ownEmail.body).toEqual({ code: "CLIENT_NOT_FOUND", message: "CLIENT_NOT_FOUND" });
		expect(ownEmail.body).not.toHaveProperty("data");

		const ownPhone = await lookup({ phone: "5550102030" }, token);
		expect(ownPhone.status).toBe(404);
		expect(ownPhone.body).toEqual({ code: "CLIENT_NOT_FOUND", message: "CLIENT_NOT_FOUND" });
	});

	test("an admin lookup of an unknown email returns CLIENT_NOT_FOUND and no client fields", async () => {
		const response = await lookup({ email: `missing-admin-${Date.now()}@example.com` }, adminToken());

		expect(response.status).toBe(404);
		expect(response.body).toEqual({ code: "CLIENT_NOT_FOUND", message: "CLIENT_NOT_FOUND" });
		expect(response.body).not.toHaveProperty("data");
		expect(response.body).not.toHaveProperty("publicData");
	});

	test("a staff token may look up a client identifier", async () => {
		const response = await lookup({ email: `missing-staff-${Date.now()}@example.com` }, staffToken({ email: "staff@example.com" }));

		expect(response.status).toBe(404);
		expect(response.body.code).toBe("CLIENT_NOT_FOUND");
		expect(response.body).not.toHaveProperty("data");
	});

	test("a wallet session cannot tell whether an email is registered", async () => {
		const token = sessionToken({ email: "owner@example.com" });
		const first = await lookup({ email: "owner@example.com" }, token);
		const second = await lookup({ email: "nobody@example.com" }, token);

		expect(first.status).toBe(403);
		expect(second.status).toBe(403);
		expect(first.body).toEqual(FORBIDDEN_BODY);
		expect(JSON.stringify(first.body)).toBe(JSON.stringify(second.body));
	});

	test("an authenticated caller still must provide an email or phone", async () => {
		const response = await lookup(null, clientToken({ email: "owner@example.com" }));

		expect(response.status).toBe(400);
		expect(response.body.code).toBe("CLIENT_IDENTIFIER_REQUIRED");
	});

	test("client and staff sign-in stay reachable without a session", async () => {
		const clientAuth = await server().post("/api/clients/auth").send({});
		expect(clientAuth.status).not.toBe(401);
		expect(clientAuth.status).toBe(409);
		expect(clientAuth.body).toHaveProperty("validationError");

		const staffAuth = await server().post("/api/staff/auth").send({});
		expect(staffAuth.status).not.toBe(401);
		expect(staffAuth.status).toBe(409);
		expect(staffAuth.body).toHaveProperty("validationError");
	});
});
