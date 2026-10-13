/**
 * Jim inbound mail (Mailgun route → /api/mail/inbound/jim). No network, no Mongo: model and HTTP are fakes.
 */
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const jwt = require("jsonwebtoken");

jest.mock("../../Repositories/Mail/models/inbound-email.model", () => ({}));

const config = require("../../Core/config");
const { verifySignature, extractSignatureFields, mailgunSignatureValidator } = require("../../Repositories/Mail/middlewares/mailgun-signature.middleware");
const { superAdminKeyValidator } = require("../../Repositories/Mail/middlewares/super-admin-key.middleware");
const { extractInvite } = require("../../Repositories/Mail/modules/invite-extractor.module");
const Forwarder = require("../../Repositories/Mail/modules/jim-forwarder.module");
const Inbound = require("../../Repositories/Mail/modules/inbound-mail.module");
const { webhookHandler } = require("../../Repositories/Mail/controllers/mail.controller");

const KEY = "test-signing-key";
const JWT_SECRET = "test-jwt-secret";
const sign = (ts, token, key = KEY) => crypto.createHmac("sha256", key).update(`${ts}${token}`).digest("hex");
const now = () => Math.floor(Date.now() / 1000);
const cfg = { recipients: "jim@mg.zelf.world", allowedSenders: "@zelf.world,partner@acme.com", forwardUrl: "", discordWebhookUrl: "https://discord.test/hook", maxTimestampSkewSec: 300 };

const fakeModel = () => {
	const tokens = new Set();
	const docs = [];
	return {
		docs,
		create: jest.fn(async (doc) => {
			if (tokens.has(doc.mailgunToken)) throw Object.assign(new Error("dup"), { code: 11000 });
			tokens.add(doc.mailgunToken);
			const saved = { _id: `id${docs.length + 1}`, receivedAt: new Date(), ...doc };
			docs.push(saved);
			return saved;
		}),
		updateOne: jest.fn(async () => ({})),
	};
};

const flush = () => new Promise((r) => setImmediate(r));

const inviteToken = (over = {}, secret = JWT_SECRET, opts = { expiresIn: "7d" }) =>
	jwt.sign({ type: "staff_invitation", staffEmail: "jim@mg.zelf.world", ownerEmail: "owner@zelf.world", ownerCompany: "Zelf", role: "write", apiKey: "SECRET_API_KEY", zkProof: "SECRET_ZK", ...over }, secret, opts);

describe("legacy webhook acknowledgement", () => {
	test("acknowledges the old URL and does not echo or store the body", async () => {
		const ctx = { request: { body: { subject: "secret-subject", recipient: "jim@mg.zelf.world" } } };
		await webhookHandler(ctx);
		expect(ctx.status).toBe(200);
		expect(ctx.body).toEqual({ data: { received: true, stored: false } });
		expect(JSON.stringify(ctx.body)).not.toContain("secret-subject");
	});
});

describe("Mailgun signature", () => {
	test("valid signature passes", () => {
		const ts = now();
		expect(verifySignature({ timestamp: ts, token: "t1", signature: sign(ts, "t1") }, KEY)).toEqual({ ok: true });
	});
	test("bad signature, wrong key, missing fields and missing key fail", () => {
		const ts = now();
		expect(verifySignature({ timestamp: ts, token: "t1", signature: "00" }, KEY).reason).toBe("bad_signature");
		expect(verifySignature({ timestamp: ts, token: "t1", signature: sign(ts, "t1", "other") }, KEY).reason).toBe("bad_signature");
		expect(verifySignature({ timestamp: ts, token: "t1" }, KEY).reason).toBe("missing_signature_fields");
		expect(verifySignature({ timestamp: ts, token: "t1", signature: sign(ts, "t1") }, undefined).reason).toBe("signing_key_not_configured");
	});
	test("stale timestamp is rejected", () => {
		const ts = now() - 3600;
		expect(verifySignature({ timestamp: ts, token: "t1", signature: sign(ts, "t1") }, KEY).reason).toBe("stale_timestamp");
	});
	test("nested signature object (event webhooks) is supported", () => {
		expect(extractSignatureFields({ signature: { timestamp: 1, token: "a", signature: "b" } })).toEqual({ timestamp: 1, token: "a", signature: "b" });
	});
	test("middleware returns 406 and does not call next on failure", async () => {
		const old = config.email_providers.mailgun.webhookSigningKey;
		config.email_providers.mailgun.webhookSigningKey = KEY;
		const next = jest.fn();
		const ctx = { request: { body: { timestamp: now(), token: "x", signature: "nope" } } };
		await mailgunSignatureValidator(ctx, next);
		expect(ctx.status).toBe(406);
		expect(next).not.toHaveBeenCalled();
		const ts = now();
		const ok = { request: { body: { timestamp: ts, token: "y", signature: sign(ts, "y") } } };
		await mailgunSignatureValidator(ok, next);
		expect(next).toHaveBeenCalled();
		config.email_providers.mailgun.webhookSigningKey = old;
	});
});

describe("super-admin guard", () => {
	const old = config.SUPERADMIN_JWT_SECRET;
	beforeAll(() => (config.SUPERADMIN_JWT_SECRET = "sa-secret"));
	afterAll(() => (config.SUPERADMIN_JWT_SECRET = old));
	test("x-api-key, bearer JWT, and rejection", async () => {
		const next = jest.fn();
		await superAdminKeyValidator({ headers: { "x-api-key": "sa-secret" }, state: {} }, next);
		await superAdminKeyValidator({ headers: { authorization: `Bearer ${jwt.sign({ email: "jim" }, "sa-secret")}` }, state: {} }, next);
		expect(next).toHaveBeenCalledTimes(2);
		const bad = { headers: { "x-api-key": "wrong" }, state: {} };
		await superAdminKeyValidator(bad, next);
		expect(bad.status).toBe(403);
	});
});

describe("allowlists", () => {
	test("sender allowlist supports @domain and exact address", () => {
		expect(Inbound.isSenderAllowed("Miguel <miguel@zelf.world>", cfg.allowedSenders)).toBe(true);
		expect(Inbound.isSenderAllowed("partner@acme.com", cfg.allowedSenders)).toBe(true);
		expect(Inbound.isSenderAllowed("evil@zelf.world.attacker.io", cfg.allowedSenders)).toBe(false);
		expect(Inbound.isSenderAllowed("x@acme.com", cfg.allowedSenders)).toBe(false);
	});
	test("recipient allowlist", () => {
		expect(Inbound.isRecipientAllowed("Jim <JIM@mg.zelf.world>, other@x.com", cfg.recipients)).toEqual(["jim@mg.zelf.world"]);
		expect(Inbound.isRecipientAllowed("nobody@mg.zelf.world", cfg.recipients)).toEqual([]);
	});
});

describe("invite extraction (notify-only)", () => {
	const recipients = ["jim@mg.zelf.world"];
	test("valid invite link", () => {
		const t = inviteToken();
		const r = extractInvite({ textPlain: `Join: https://app.zelf.world/auth/accept-invite?token=${t} thanks` }, { recipients, secret: JWT_SECRET });
		expect(r).toMatchObject({ valid: true, company: "Zelf", role: "write", staffEmail: "jim@mg.zelf.world" });
		expect(r.tokenMasked).toBe(`…${t.slice(-6)}`);
		expect(JSON.stringify(r)).not.toContain("SECRET_API_KEY");
		expect(JSON.stringify(r)).not.toContain("SECRET_ZK");
	});
	test("link inside HTML with &amp;", () => {
		const t = inviteToken();
		const r = extractInvite({ html: `<a href="https://x.zelf.world/auth/accept-invite?token=${t}&amp;x=1">Accept</a>` }, { recipients, secret: JWT_SECRET });
		expect(r.valid).toBe(true);
	});
	test("expired, forged, wrong type, wrong staff email", () => {
		const expired = inviteToken({}, JWT_SECRET, { expiresIn: -10 });
		expect(extractInvite({ textPlain: `https://a/auth/accept-invite?token=${expired}` }, { recipients, secret: JWT_SECRET }).reason).toBe("expired");
		const forged = inviteToken({}, "other");
		expect(extractInvite({ textPlain: `https://a/auth/accept-invite?token=${forged}` }, { recipients, secret: JWT_SECRET }).reason).toBe("invalid_signature");
		const wrong = inviteToken({ type: "login" });
		expect(extractInvite({ textPlain: `https://a/auth/accept-invite?token=${wrong}` }, { recipients, secret: JWT_SECRET }).reason).toBe("wrong_type");
		const other = inviteToken({ staffEmail: "someone@else.com" });
		expect(extractInvite({ textPlain: `https://a/auth/accept-invite?token=${other}` }, { recipients, secret: JWT_SECRET }).reason).toBe("staff_email_mismatch");
	});
	test("no link → null", () => {
		expect(extractInvite({ textPlain: "hello" }, { recipients })).toBeNull();
	});
});

describe("receive", () => {
	const body = (over = {}) => ({
		recipient: "jim@mg.zelf.world",
		sender: "stranger@gmail.com",
		from: "Stranger <stranger@gmail.com>",
		subject: "Hi Jim",
		"body-plain": "Hello there",
		"stripped-text": "Hello there",
		"message-headers": JSON.stringify([["Message-Id", "<m1@x>"], ["X-Mailgun-Spf", "Pass"]]),
		timestamp: String(now()),
		token: `tok-${Math.random()}`,
		signature: "verified-upstream",
		...over,
	});

	test("stores mail from any sender, flags allowlist, forwards notification", async () => {
		const Model = fakeModel();
		const forwarder = { forward: jest.fn(async () => ({ channel: "discord" })) };
		const r = await Inbound.receive(body(), {}, { Model, forwarder, cfg });
		await flush();
		expect(r.classification).toBe("generic");
		expect(Model.docs[0]).toMatchObject({ recipient: "jim@mg.zelf.world", senderAllowed: false, messageId: "<m1@x>", spf: "Pass" });
		expect(forwarder.forward).toHaveBeenCalled();
		expect(Model.updateOne).toHaveBeenCalledWith({ _id: "id1" }, { $set: expect.objectContaining({ status: "forwarded" }) });
	});
	test("replayed token → 406", async () => {
		const Model = fakeModel();
		const forwarder = { forward: jest.fn(async () => ({ channel: "none" })) };
		const b = body({ token: "same" });
		await Inbound.receive(b, {}, { Model, forwarder, cfg });
		await expect(Inbound.receive(b, {}, { Model, forwarder, cfg })).rejects.toThrow("406:replayed_token");
	});
	test("recipient not allowed → 406, nothing stored", async () => {
		const Model = fakeModel();
		await expect(Inbound.receive(body({ recipient: "other@mg.zelf.world" }), {}, { Model, forwarder: { forward: jest.fn() }, cfg })).rejects.toThrow("406:recipient_not_allowed");
		expect(Model.docs).toHaveLength(0);
	});
	test("forward failure marks status error", async () => {
		const Model = fakeModel();
		await Inbound.receive(body(), {}, { Model, forwarder: { forward: jest.fn(async () => { throw new Error("boom"); }) }, cfg });
		await flush();
		await flush();
		expect(Model.updateOne).toHaveBeenCalledWith({ _id: "id1" }, { $set: { status: "error", forwardError: "boom" } });
	});
	test("staff invite classified, allowlisted sender", async () => {
		const old = config.JWT_SECRET;
		config.JWT_SECRET = JWT_SECRET;
		const Model = fakeModel();
		const t = inviteToken();
		const r = await Inbound.receive(body({ sender: "owner@zelf.world", "body-plain": `Accept https://app.zelf.world/auth/accept-invite?token=${t}` }), {}, { Model, forwarder: { forward: jest.fn(async () => ({ channel: "none" })) }, cfg });
		config.JWT_SECRET = old;
		expect(r.classification).toBe("staff_invite");
		expect(Model.docs[0].senderAllowed).toBe(true);
		expect(Model.docs[0].invite).toMatchObject({ valid: true, role: "write" });
	});
	test("attachments: hash always, inline only small allowlisted types", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mg-"));
		const pdf = path.join(dir, "a.pdf");
		const exe = path.join(dir, "b.exe");
		fs.writeFileSync(pdf, "%PDF-1.4 hi");
		fs.writeFileSync(exe, "MZ");
		const files = {
			"attachment-1": { filepath: pdf, originalFilename: "a.pdf", mimetype: "application/pdf", size: 11 },
			"attachment-2": { filepath: exe, originalFilename: "b.exe", mimetype: "application/x-msdownload", size: 2 },
			other: { filepath: exe },
		};
		const Model = fakeModel();
		await Inbound.receive(body(), files, { Model, forwarder: { forward: jest.fn(async () => ({ channel: "none" })) }, cfg });
		const [a, b] = Model.docs[0].attachments;
		expect(Model.docs[0].attachments).toHaveLength(2);
		expect(a).toMatchObject({ filename: "a.pdf", storedInline: true });
		expect(a.sha256).toHaveLength(64);
		expect(b.storedInline).toBeUndefined();
		expect(b.contentBase64).toBeUndefined();
	});
	test("route forward stores a small pdf and allows @zelf.world and @mg.zelf.world", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mg-route-"));
		const pdf = path.join(dir, "note.pdf");
		fs.writeFileSync(pdf, "%PDF-1.4 hi");
		const files = { "attachment-1": { filepath: pdf, originalFilename: "note.pdf", mimetype: "application/pdf", size: 11 } };
		const allow = { ...cfg, allowedSenders: "@zelf.world,@mg.zelf.world" };
		const forwarder = { forward: jest.fn(async () => ({ channel: "none" })) };
		for (const sender of ["miguel@zelf.world", "bot@mg.zelf.world"]) {
			const Model = fakeModel();
			const headers = JSON.stringify([
				["Date", "Tue, 13 Oct 2026 13:00:00 +0000"],
				["Message-Id", `<${sender}>`],
				["To", "Jim <jim@mg.zelf.world>"],
			]);
			await Inbound.receive(
				body({
					sender,
					from: `Person <${sender}>`,
					subject: "Route forward",
					"body-plain": "Hello from the route",
					"stripped-text": "Hello from the route",
					"message-headers": headers,
					token: `route-${sender}`,
				}),
				files,
				{ Model, forwarder, cfg: allow }
			);
			expect(Model.docs[0]).toMatchObject({
				recipient: "jim@mg.zelf.world",
				sender,
				senderAllowed: true,
				subject: "Route forward",
				classification: "generic",
				messageId: `<${sender}>`,
			});
			expect(Model.docs[0].attachments[0]).toMatchObject({ filename: "note.pdf", storedInline: true, contentType: "application/pdf" });
			expect(Model.docs[0].attachments[0].contentBase64).toBe(Buffer.from("%PDF-1.4 hi").toString("base64"));
		}
		expect(Inbound.isSenderAllowed("bot@mg.zelf.world", "@zelf.world")).toBe(false);
	});
	test("store() fills an attachment the forward did not include", async () => {
		const pdf = Buffer.from("%PDF-1.4 stored");
		const http = {
			get: jest.fn(async (url) => {
				if (String(url).endsWith("/messages/abc")) {
					return { data: { attachments: [{ name: "stored.pdf", "content-type": "application/pdf", size: pdf.length, url: "https://storage.test/stored.pdf" }] } };
				}
				return { data: pdf };
			}),
		};
		const Model = fakeModel();
		await Inbound.receive(
			body({ token: "stored-1", "message-url": "https://storage.test/messages/abc" }),
			{},
			{ Model, forwarder: { forward: jest.fn(async () => ({ channel: "none" })) }, cfg, storageHttp: http, apiKey: "mg-key" }
		);
		await flush();
		const update = Model.updateOne.mock.calls[0][1].$set;
		expect(update.status).toBe("received");
		expect(update.attachments).toHaveLength(1);
		expect(update.attachments[0]).toMatchObject({ filename: "stored.pdf", storedInline: true, mailgunUrl: "https://storage.test/stored.pdf" });
		expect(update.attachments[0].sha256).toHaveLength(64);
		expect(http.get).toHaveBeenCalledWith("https://storage.test/messages/abc", expect.objectContaining({ headers: expect.any(Object) }));
	});
});

describe("forwarder", () => {
	const doc = { _id: "abc", subject: "Invite", from: "o@zelf.world", recipient: "jim@mg.zelf.world", textPlain: "x".repeat(1000), classification: "staff_invite", senderAllowed: true, attachments: [], invite: { valid: true, company: "Zelf", role: "write", tokenMasked: "…abcdef", token: "FULLTOKEN", link: "https://a/auth/accept-invite?token=FULLTOKEN" } };
	test("forward URL gets signed JSON without the full token", async () => {
		const http = { post: jest.fn(async () => ({})) };
		const r = await Forwarder.forward(doc, { http, cfg: { forwardUrl: "https://jim.test/in", forwardSecret: "fs" } });
		expect(r.channel).toBe("forward_url");
		const [, sent, opts] = http.post.mock.calls[0];
		expect(sent).not.toContain("FULLTOKEN");
		const ts = opts.headers["X-Jim-Timestamp"];
		expect(opts.headers["X-Jim-Signature"]).toBe(crypto.createHmac("sha256", "fs").update(`${ts}.${sent}`).digest("hex"));
		expect(JSON.parse(sent).snippet.length).toBeLessThanOrEqual(280);
	});
	test("discord fallback, no mentions, no token", async () => {
		const http = { post: jest.fn(async () => ({})) };
		const r = await Forwarder.forward(doc, { http, cfg: { discordWebhookUrl: "https://discord.test/h" } });
		expect(r.channel).toBe("discord");
		const payload = http.post.mock.calls[0][1];
		expect(payload.allowed_mentions).toEqual({ parse: [] });
		expect(payload.content).not.toContain("FULLTOKEN");
		expect(payload.content).toContain("accept manually");
	});
	test("no channel configured → none", async () => {
		expect((await Forwarder.forward(doc, { http: { post: jest.fn() }, cfg: {} })).channel).toBe("none");
	});
});
