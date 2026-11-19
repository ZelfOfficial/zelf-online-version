const crypto = require("crypto");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const { errorHandler } = require("../../Core/http-handler");
const PasswordShare = require("../../Repositories/PasswordShare/models/password-share.model");
const {
	MAX_CIPHERTEXT_BYTES,
	SHARE_ID_BYTES,
	createShare,
	getMetadata,
	listShares,
	revealShare,
	revokeShare,
} = require("../../Repositories/PasswordShare/modules/password-share.module");

const user = (identifier) => ({ identifier, tagName: "Alice.zelf", session: "session-1" });

const payload = (overrides = {}) => ({
	ciphertext: crypto.randomBytes(32).toString("base64"),
	iv: crypto.randomBytes(12).toString("base64"),
	version: 1,
	expiresIn: 3600,
	maxViews: 1,
	...overrides,
});

const expectCode = async (promise, status, code) => {
	try {
		await promise;
	} catch (error) {
		const handled = errorHandler(error);
		expect(handled.status).toBe(status);
		expect(handled.code).toBe(code);
		expect(handled.message).toBe(code);
		expect(JSON.stringify(handled)).not.toMatch(/ciphertext|BEGIN/);
		return;
	}
	throw new Error(`expected ${status} ${code}`);
};

describe("password share module", () => {
	let memory;

	beforeAll(async () => {
		memory = await MongoMemoryServer.create();
		await mongoose.connect(memory.getUri());
		await PasswordShare.init();
	}, 180000);

	afterAll(async () => {
		await mongoose.disconnect();
		if (memory) await memory.stop();
	});

	beforeEach(async () => {
		await PasswordShare.deleteMany({});
	});

	test("schema expires shares with a TTL index on expiresAt", () => {
		const indexes = PasswordShare.schema.indexes();
		expect(indexes).toEqual(
			expect.arrayContaining([[{ expiresAt: 1 }, expect.objectContaining({ expireAfterSeconds: 0 })]])
		);
	});

	test("creates an unguessable id and stores ciphertext without key material", async () => {
		const body = payload({ label: "  Bank  ", maxViews: 3 });
		const created = await createShare(body, user("owner-a"));

		expect(Buffer.from(created.id, "base64url")).toHaveLength(SHARE_ID_BYTES);
		expect(created.maxViews).toBe(3);
		expect(new Date(created.expiresAt).getTime()).toBeGreaterThan(Date.now() + 3500 * 1000);
		expect(Object.keys(created).sort()).toEqual(["expiresAt", "id", "maxViews"]);

		const doc = await PasswordShare.findOne({ shareId: created.id }).lean();
		expect(doc.ciphertext).toBe(body.ciphertext);
		expect(doc.iv).toBe(body.iv);
		expect(doc.version).toBe(1);
		expect(doc.label).toBe("Bank");
		expect(doc.remainingViews).toBe(3);
		expect(doc.ownerIdentifier).toBe("owner-a");
		expect(doc.ownerTagName).toBe("alice.zelf");
		expect(doc.key).toBeUndefined();
		expect(doc.password).toBeUndefined();
		expect(doc.plaintext).toBeUndefined();
	});

	test("metadata does not consume a view and does not return ciphertext", async () => {
		const body = payload({ maxViews: 2, label: "Mail" });
		const created = await createShare(body, user("owner-a"));

		const first = await getMetadata(created.id);
		const second = await getMetadata(created.id);

		expect(first).toEqual({
			id: created.id,
			expiresAt: created.expiresAt,
			remainingViews: 2,
			label: "Mail",
		});
		expect(second.remainingViews).toBe(2);
		expect(first.ciphertext).toBeUndefined();
		expect(JSON.stringify(first)).not.toContain(body.ciphertext);

		const doc = await PasswordShare.findOne({ shareId: created.id }).lean();
		expect(doc.remainingViews).toBe(2);
		expect(doc.ciphertext).toBe(body.ciphertext);
	});

	test("reveal consumes a view and purges ciphertext when none remain", async () => {
		const body = payload({ maxViews: 1 });
		const created = await createShare(body, user("owner-a"));

		const revealed = await revealShare(created.id);

		expect(revealed).toEqual({
			ciphertext: body.ciphertext,
			iv: body.iv,
			version: 1,
			expiresAt: created.expiresAt,
			remainingViews: 0,
		});

		const doc = await PasswordShare.findOne({ shareId: created.id }).lean();
		expect(doc.remainingViews).toBe(0);
		expect(doc.ciphertext).toBeNull();
		expect(doc.iv).toBeNull();
		expect(doc.consumedAt).toBeInstanceOf(Date);

		await expectCode(getMetadata(created.id), 404, "SHARE_NOT_FOUND");
		await expectCode(revealShare(created.id), 404, "SHARE_NOT_FOUND");
	});

	test("only one of several concurrent reveals of a 1-view share succeeds", async () => {
		const body = payload({ maxViews: 1 });
		const created = await createShare(body, user("owner-race"));

		const results = await Promise.all(
			Array.from({ length: 8 }, () =>
				revealShare(created.id).then(
					(value) => ({ ok: true, value }),
					(error) => ({ ok: false, error })
				)
			)
		);

		const wins = results.filter((result) => result.ok);
		const losses = results.filter((result) => !result.ok);

		expect(wins).toHaveLength(1);
		expect(wins[0].value.ciphertext).toBe(body.ciphertext);
		expect(wins[0].value.remainingViews).toBe(0);
		expect(losses).toHaveLength(7);
		for (const loss of losses) {
			const handled = errorHandler(loss.error);
			expect(handled.status).toBe(404);
			expect(handled.code).toBe("SHARE_NOT_FOUND");
		}

		const doc = await PasswordShare.findOne({ shareId: created.id }).lean();
		expect(doc.ciphertext).toBeNull();
		expect(doc.iv).toBeNull();
		expect(doc.remainingViews).toBe(0);
	});

	test("a multi-view share decrements until the last reveal purges it", async () => {
		const body = payload({ maxViews: 2 });
		const created = await createShare(body, user("owner-a"));

		const first = await revealShare(created.id);
		expect(first.remainingViews).toBe(1);
		let doc = await PasswordShare.findOne({ shareId: created.id }).lean();
		expect(doc.ciphertext).toBe(body.ciphertext);

		const meta = await getMetadata(created.id);
		expect(meta.remainingViews).toBe(1);

		const second = await revealShare(created.id);
		expect(second.remainingViews).toBe(0);
		doc = await PasswordShare.findOne({ shareId: created.id }).lean();
		expect(doc.ciphertext).toBeNull();
	});

	test("expired shares are refused before the TTL reaps them", async () => {
		const created = await createShare(payload(), user("owner-a"));
		await PasswordShare.updateOne({ shareId: created.id }, { $set: { expiresAt: new Date(Date.now() - 1000) } });

		await expectCode(getMetadata(created.id), 410, "SHARE_EXPIRED");
		await expectCode(revealShare(created.id), 410, "SHARE_EXPIRED");

		const doc = await PasswordShare.findOne({ shareId: created.id }).lean();
		expect(doc.ciphertext).toBeTruthy();
		expect(doc.remainingViews).toBe(1);
	});

	test("revoke is owner-only and then indistinguishable from a missing share", async () => {
		const body = payload({ label: "Wifi" });
		const created = await createShare(body, user("owner-a"));

		await expectCode(revokeShare(created.id, user("owner-b")), 403, "SHARE_FORBIDDEN");
		let doc = await PasswordShare.findOne({ shareId: created.id }).lean();
		expect(doc.ciphertext).toBe(body.ciphertext);

		const revoked = await revokeShare(created.id, user("owner-a"));
		expect(revoked).toEqual({ id: created.id, revoked: true });

		doc = await PasswordShare.findOne({ shareId: created.id }).lean();
		expect(doc.revokedAt).toBeInstanceOf(Date);
		expect(doc.ciphertext).toBeNull();
		expect(doc.iv).toBeNull();

		await expectCode(getMetadata(created.id), 404, "SHARE_NOT_FOUND");
		await expectCode(revealShare(created.id), 404, "SHARE_NOT_FOUND");
		await expectCode(revokeShare("not-a-valid-id", user("owner-a")), 404, "SHARE_NOT_FOUND");

		const again = await revokeShare(created.id, user("owner-a"));
		expect(again.revoked).toBe(true);
	});

	test("the owner list returns active shares only and never ciphertext", async () => {
		const kept = await createShare(payload({ label: "Keep", maxViews: 2 }), user("owner-a"));
		const consumed = await createShare(payload({ label: "Gone" }), user("owner-a"));
		const other = await createShare(payload({ label: "Other" }), user("owner-b"));
		await revealShare(consumed.id);

		const listed = await listShares(user("owner-a"));

		expect(listed.shares).toHaveLength(1);
		expect(listed.shares[0]).toMatchObject({
			id: kept.id,
			label: "Keep",
			remainingViews: 2,
			maxViews: 2,
		});
		expect(listed.shares[0].createdAt).toEqual(expect.any(String));
		expect(JSON.stringify(listed)).not.toContain("ciphertext");
		expect(listed.shares.some((share) => share.id === other.id)).toBe(false);
		expect(listed.shares.some((share) => share.id === consumed.id)).toBe(false);
	});

	test("rejects oversized ciphertext, bad inputs, and any key field", async () => {
		const owner = user("owner-a");
		const exact = Buffer.alloc(MAX_CIPHERTEXT_BYTES).toString("base64");
		const created = await createShare(payload({ ciphertext: exact }), owner);
		expect(created.id).toBeTruthy();

		const tooBig = Buffer.alloc(MAX_CIPHERTEXT_BYTES + 1).toString("base64");
		await expectCode(createShare(payload({ ciphertext: tooBig }), owner), 413, "SHARE_TOO_LARGE");
		await expectCode(createShare(payload({ ciphertext: "%%%not-base64%%%" }), owner), 400, "INVALID_CIPHERTEXT");
		await expectCode(createShare(payload({ ciphertext: "" }), owner), 400, "INVALID_CIPHERTEXT");
		await expectCode(createShare(payload({ iv: crypto.randomBytes(16).toString("base64") }), owner), 400, "INVALID_IV");
		await expectCode(createShare(payload({ iv: "" }), owner), 400, "INVALID_IV");
		await expectCode(createShare(payload({ version: 2 }), owner), 400, "INVALID_VERSION");
		await expectCode(createShare(payload({ version: "1" }), owner), 400, "INVALID_VERSION");
		await expectCode(createShare(payload({ expiresIn: 3599 }), owner), 400, "INVALID_EXPIRATION");
		await expectCode(createShare(payload({ expiresIn: "3600" }), owner), 400, "INVALID_EXPIRATION");
		await expectCode(createShare(payload({ maxViews: 0 }), owner), 400, "INVALID_MAX_VIEWS");
		await expectCode(createShare(payload({ maxViews: 11 }), owner), 400, "INVALID_MAX_VIEWS");
		await expectCode(createShare(payload({ maxViews: 1.5 }), owner), 400, "INVALID_MAX_VIEWS");
		await expectCode(createShare(payload({ label: "x".repeat(61) }), owner), 400, "INVALID_LABEL");
		await expectCode(createShare(payload({ label: "line\nbreak" }), owner), 400, "INVALID_LABEL");
		await expectCode(createShare(payload({ key: crypto.randomBytes(32).toString("base64url") }), owner), 400, "SHARE_KEY_NOT_ACCEPTED");
		await expectCode(createShare(payload({ plaintext: "hunter2" }), owner), 400, "SHARE_KEY_NOT_ACCEPTED");
		await expectCode(createShare(payload(), {}), 401, "SHARE_SESSION_REQUIRED");

		const stored = await PasswordShare.find({ ownerIdentifier: "owner-a" }).lean();
		expect(stored).toHaveLength(1);
		expect(JSON.stringify(stored)).not.toContain("hunter2");
	});

	test("omitted maxViews defaults to 1 and an empty label is dropped", async () => {
		const body = payload();
		delete body.maxViews;
		body.label = "   ";
		const created = await createShare(body, user("owner-a"));
		expect(created.maxViews).toBe(1);

		const doc = await PasswordShare.findOne({ shareId: created.id }).lean();
		expect(doc.maxViews).toBe(1);
		expect(doc.label).toBeNull();

		const meta = await getMetadata(created.id);
		expect(meta.label).toBeUndefined();
		expect(meta.remainingViews).toBe(1);
	});
});
