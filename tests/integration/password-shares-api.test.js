const crypto = require("crypto");
const mongoose = require("mongoose");
const request = require("supertest");
require("dotenv").config();

const PasswordShare = require("../../Repositories/PasswordShare/models/password-share.model");

const API_BASE_URL = `http://localhost:${process.env.PORT || 3003}`;
const PATH = "/api/password-shares";
const ORIGIN = "https://test.example.com";
const LANDING_ORIGIN = "https://zelf.world";

const uniqueId = () => `share_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`;

const payload = (overrides = {}) => ({
	ciphertext: crypto.randomBytes(24).toString("base64"),
	iv: crypto.randomBytes(12).toString("base64"),
	version: 1,
	expiresIn: 3600,
	maxViews: 1,
	...overrides,
});

const openSession = async (identifier) => {
	const response = await request(API_BASE_URL).post("/api/sessions").set("Origin", ORIGIN).send({
		identifier,
		type: "general",
		isWebExtension: true,
		tagName: "share-test.zelf",
	});

	expect(response.status).toBe(200);
	expect(response.body.data.token).toBeDefined();
	return response.body.data.token;
};

describe("password shares API", () => {
	let token;
	let otherToken;
	const ownerId = uniqueId();
	const otherId = uniqueId();

	beforeAll(async () => {
		token = await openSession(ownerId);
		otherToken = await openSession(otherId);
	});

	afterAll(async () => {
		if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
	});

	const auth = (req, bearer = token) => req.set("Origin", ORIGIN).set("Authorization", `Bearer ${bearer}`);

	const createShare = async (body, bearer = token) => {
		const response = await auth(request(API_BASE_URL).post(PATH), bearer).send(body);
		expect(response.status).toBe(200);
		return response.body;
	};

	it("requires a session to create, list, and revoke", async () => {
		const missing = await request(API_BASE_URL).post(PATH).set("Origin", ORIGIN).send(payload());
		expect(missing.status).toBe(401);

		const list = await request(API_BASE_URL).get(PATH).set("Origin", ORIGIN);
		expect(list.status).toBe(401);

		const remove = await request(API_BASE_URL).delete(`${PATH}/${"a".repeat(43)}`).set("Origin", ORIGIN);
		expect(remove.status).toBe(401);
	});

	it("creates a share and lists it for the same session identifier without ciphertext", async () => {
		const body = payload({ label: "Bank", maxViews: 2, expiresIn: 86400 });
		const created = await createShare(body);

		expect(Object.keys(created).sort()).toEqual(["expiresAt", "id", "maxViews"]);
		expect(Buffer.from(created.id, "base64url")).toHaveLength(32);
		expect(created.maxViews).toBe(2);
		expect(created.expiresAt).toEqual(expect.any(String));

		const listed = await auth(request(API_BASE_URL).get(PATH));
		expect(listed.status).toBe(200);
		const mine = listed.body.shares.find((share) => share.id === created.id);
		expect(mine).toMatchObject({
			id: created.id,
			label: "Bank",
			remainingViews: 2,
			maxViews: 2,
			expiresAt: created.expiresAt,
		});
		expect(mine.createdAt).toEqual(expect.any(String));
		expect(JSON.stringify(listed.body)).not.toContain(body.ciphertext);

		const foreign = await auth(request(API_BASE_URL).get(PATH), otherToken);
		expect(foreign.status).toBe(200);
		expect(foreign.body.shares.some((share) => share.id === created.id)).toBe(false);

		await auth(request(API_BASE_URL).delete(`${PATH}/${created.id}`));
	});

	it("serves public metadata without consuming a view", async () => {
		const body = payload({ maxViews: 2, label: "Mail" });
		const created = await createShare(body);

		const first = await request(API_BASE_URL).get(`${PATH}/${created.id}`).set("Origin", LANDING_ORIGIN);
		const second = await request(API_BASE_URL).get(`${PATH}/${created.id}`).set("Origin", LANDING_ORIGIN);

		expect(first.status).toBe(200);
		expect(second.status).toBe(200);
		expect(first.headers["access-control-allow-origin"]).toBe("*");
		expect(String(first.headers["access-control-expose-headers"] || "").toLowerCase()).toContain("retry-after");
		expect(first.body).toEqual({
			id: created.id,
			expiresAt: created.expiresAt,
			remainingViews: 2,
			label: "Mail",
		});
		expect(second.body.remainingViews).toBe(2);
		expect(JSON.stringify(first.body)).not.toContain(body.ciphertext);

		const preflight = await request(API_BASE_URL)
			.options(`${PATH}/${created.id}/reveal`)
			.set("Origin", LANDING_ORIGIN)
			.set("Access-Control-Request-Method", "POST");
		expect([200, 204]).toContain(preflight.status);
		expect(preflight.headers["access-control-allow-origin"]).toBe("*");

		await auth(request(API_BASE_URL).delete(`${PATH}/${created.id}`));
	});

	it("reveal consumes a view, returns ciphertext once, and purges a 1-view share", async () => {
		const body = payload({ maxViews: 1 });
		const created = await createShare(body);

		const revealed = await request(API_BASE_URL).post(`${PATH}/${created.id}/reveal`).set("Origin", LANDING_ORIGIN).send({});

		expect(revealed.status).toBe(200);
		expect(revealed.body).toEqual({
			ciphertext: body.ciphertext,
			iv: body.iv,
			version: 1,
			expiresAt: created.expiresAt,
			remainingViews: 0,
		});

		const again = await request(API_BASE_URL).post(`${PATH}/${created.id}/reveal`).set("Origin", LANDING_ORIGIN).send({});
		expect(again.status).toBe(404);
		expect(again.body).toEqual({ code: "SHARE_NOT_FOUND", message: "SHARE_NOT_FOUND" });
		expect(JSON.stringify(again.body)).not.toContain(body.ciphertext);

		const meta = await request(API_BASE_URL).get(`${PATH}/${created.id}`).set("Origin", LANDING_ORIGIN);
		expect(meta.status).toBe(404);
		expect(meta.body.code).toBe("SHARE_NOT_FOUND");

		const listed = await auth(request(API_BASE_URL).get(PATH));
		expect(listed.body.shares.some((share) => share.id === created.id)).toBe(false);
	});

	it("lets only one concurrent reveal of a 1-view share succeed", async () => {
		const body = payload({ maxViews: 1 });
		const created = await createShare(body);

		const responses = await Promise.all(
			Array.from({ length: 6 }, () =>
				request(API_BASE_URL).post(`${PATH}/${created.id}/reveal`).set("Origin", LANDING_ORIGIN).send({})
			)
		);

		const wins = responses.filter((response) => response.status === 200);
		const losses = responses.filter((response) => response.status !== 200);

		expect(wins).toHaveLength(1);
		expect(wins[0].body.ciphertext).toBe(body.ciphertext);
		expect(wins[0].body.remainingViews).toBe(0);
		expect(losses.every((response) => response.status === 404 && response.body.code === "SHARE_NOT_FOUND")).toBe(true);
		expect(losses.every((response) => !JSON.stringify(response.body).includes(body.ciphertext))).toBe(true);
	});

	it("revoke is limited to the owner and then looks like a missing share", async () => {
		const body = payload({ label: "Wifi" });
		const created = await createShare(body);

		const forbidden = await auth(request(API_BASE_URL).delete(`${PATH}/${created.id}`), otherToken);
		expect(forbidden.status).toBe(403);
		expect(forbidden.body).toEqual({ code: "SHARE_FORBIDDEN", message: "SHARE_FORBIDDEN" });

		const stillThere = await request(API_BASE_URL).get(`${PATH}/${created.id}`).set("Origin", ORIGIN);
		expect(stillThere.status).toBe(200);
		expect(stillThere.body.remainingViews).toBe(1);

		const revoked = await auth(request(API_BASE_URL).delete(`${PATH}/${created.id}`));
		expect(revoked.status).toBe(200);
		expect(revoked.body).toEqual({ id: created.id, revoked: true });

		const meta = await request(API_BASE_URL).get(`${PATH}/${created.id}`).set("Origin", ORIGIN);
		expect(meta.status).toBe(404);
		expect(meta.body.code).toBe("SHARE_NOT_FOUND");

		const reveal = await request(API_BASE_URL).post(`${PATH}/${created.id}/reveal`).set("Origin", ORIGIN).send({});
		expect(reveal.status).toBe(404);
		expect(reveal.body.code).toBe("SHARE_NOT_FOUND");

		const missing = await auth(request(API_BASE_URL).delete(`${PATH}/${"b".repeat(43)}`));
		expect(missing.status).toBe(404);
		expect(missing.body.code).toBe("SHARE_NOT_FOUND");
	});

	it("returns validation errors without echoing the ciphertext", async () => {
		const tooBig = Buffer.alloc(16 * 1024 + 1).toString("base64");
		const cases = [
			[payload({ ciphertext: tooBig }), 413, "SHARE_TOO_LARGE"],
			[payload({ ciphertext: "not base64" }), 400, "INVALID_CIPHERTEXT"],
			[payload({ iv: crypto.randomBytes(8).toString("base64") }), 400, "INVALID_IV"],
			[payload({ version: 2 }), 400, "INVALID_VERSION"],
			[payload({ expiresIn: 7200 }), 400, "INVALID_EXPIRATION"],
			[payload({ maxViews: 11 }), 400, "INVALID_MAX_VIEWS"],
			[payload({ label: "y".repeat(61) }), 400, "INVALID_LABEL"],
			[payload({ key: crypto.randomBytes(32).toString("base64url") }), 400, "SHARE_KEY_NOT_ACCEPTED"],
		];

		for (const [body, status, code] of cases) {
			const response = await auth(request(API_BASE_URL).post(PATH)).send(body);
			expect(response.status).toBe(status);
			expect(response.body).toEqual({ code, message: code });
			expect(JSON.stringify(response.body)).not.toContain(body.ciphertext);
			if (body.key) expect(JSON.stringify(response.body)).not.toContain(body.key);
		}

		const exact = Buffer.alloc(16 * 1024).toString("base64");
		const accepted = await createShare(payload({ ciphertext: exact, maxViews: 2 }));
		expect(accepted.maxViews).toBe(2);
		await auth(request(API_BASE_URL).delete(`${PATH}/${accepted.id}`));
	});

	it("refuses an expired share that the TTL index has not reaped yet", async () => {
		const body = payload();
		const created = await createShare(body);
		const uri = process.env.MONGODB_URI || process.env.MONGODB_URI_PROD || "mongodb://127.0.0.1:27017/zelf_testing";

		if (mongoose.connection.readyState !== 1) await mongoose.connect(uri);
		const updated = await PasswordShare.updateOne({ shareId: created.id }, { $set: { expiresAt: new Date(Date.now() - 5000) } });
		expect(updated.matchedCount).toBe(1);

		const meta = await request(API_BASE_URL).get(`${PATH}/${created.id}`).set("Origin", LANDING_ORIGIN);
		expect(meta.status).toBe(410);
		expect(meta.body).toEqual({ code: "SHARE_EXPIRED", message: "SHARE_EXPIRED" });
		expect(JSON.stringify(meta.body)).not.toContain(body.ciphertext);

		const revealed = await request(API_BASE_URL).post(`${PATH}/${created.id}/reveal`).set("Origin", LANDING_ORIGIN).send({});
		expect(revealed.status).toBe(410);
		expect(revealed.body.code).toBe("SHARE_EXPIRED");
		expect(JSON.stringify(revealed.body)).not.toContain(body.ciphertext);
	});

	it("exposes Retry-After on a cross-origin 429", async () => {
		const id = crypto.randomBytes(32).toString("base64url");
		let limited = null;

		// Default reveal cap is 20/minute per IP. Earlier cases in this file already spend some of it.
		for (let attempt = 0; attempt < 30 && !limited; attempt += 1) {
			const response = await request(API_BASE_URL).post(`${PATH}/${id}/reveal`).set("Origin", LANDING_ORIGIN).send({});
			if (response.status === 429) limited = response;
		}

		expect(limited).not.toBeNull();
		expect(limited.body).toEqual({ code: "PASSWORD_SHARE_RATE_LIMITED", message: "PASSWORD_SHARE_RATE_LIMITED" });
		expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
		expect(limited.headers["access-control-allow-origin"]).toBe("*");
		expect(String(limited.headers["access-control-expose-headers"] || "").toLowerCase()).toContain("retry-after");
	});

	it("unknown ids are SHARE_NOT_FOUND", async () => {
		const response = await request(API_BASE_URL)
			.get(`${PATH}/${crypto.randomBytes(32).toString("base64url")}`)
			.set("Origin", LANDING_ORIGIN);

		expect(response.status).toBe(404);
		expect(response.body.code).toBe("SHARE_NOT_FOUND");
	});
});
