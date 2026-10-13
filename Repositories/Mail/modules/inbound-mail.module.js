const crypto = require("crypto");
const fs = require("fs");
const config = require("../../../Core/config");
const InboundEmail = require("../models/inbound-email.model");
const { extractInvite } = require("./invite-extractor.module");
const Forwarder = require("./jim-forwarder.module");

const INLINE_TYPES = ["application/pdf", "text/calendar", "text/plain", "text/csv", "image/png", "image/jpeg", "image/gif", "image/webp"];
const INLINE_MAX = 2 * 1024 * 1024;
const HTML_MAX = 200 * 1024;
const TEXT_MAX = 200 * 1024;

const parseList = (s) => String(s || "").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);

const bareAddress = (s) => {
	const m = String(s || "").match(/<([^>]+)>/);
	return (m ? m[1] : String(s || "")).trim().toLowerCase();
};

const isRecipientAllowed = (recipientField, recipients) => {
	const allowed = parseList(recipients);
	return parseList(recipientField).map(bareAddress).filter((r) => allowed.includes(r));
};

const isSenderAllowed = (sender, allowlist) => {
	const addr = bareAddress(sender);
	if (!addr) return false;
	return parseList(allowlist).some((entry) => (entry.startsWith("@") ? addr.endsWith(entry) : addr === entry));
};

const parseHeaders = (raw) => {
	let pairs = [];
	try {
		pairs = typeof raw === "string" ? JSON.parse(raw) : Array.isArray(raw) ? raw : [];
	} catch (_) {
		pairs = [];
	}
	const map = {};
	for (const p of pairs) if (Array.isArray(p) && p.length >= 2) map[String(p[0]).toLowerCase()] = String(p[1]);
	return map;
};

const fileList = (files = {}) => Object.entries(files).filter(([k]) => /^attachment-\d+$/.test(k)).flatMap(([, v]) => (Array.isArray(v) ? v : [v]));

const readAttachments = (files) =>
	fileList(files).map((f) => {
		const contentType = f.mimetype || f.type || "application/octet-stream";
		const size = f.size || 0;
		let buf = null;
		try {
			buf = fs.readFileSync(f.filepath || f.path);
		} catch (_) {
			buf = null;
		}
		const out = { filename: f.originalFilename || f.name || "attachment", contentType, size, sha256: buf ? crypto.createHash("sha256").update(buf).digest("hex") : undefined };
		if (buf && size <= INLINE_MAX && INLINE_TYPES.includes(contentType.split(";")[0].trim().toLowerCase())) {
			out.contentBase64 = buf.toString("base64");
			out.storedInline = true;
		}
		return out;
	});

/**
 * Build the stored document from a Mailgun route POST (signature already verified).
 * Every signed message to an allowed recipient is stored; the sender allowlist only gates actions.
 */
const buildDocument = (body, files, cfg = config.jimInbound) => {
	const headers = parseHeaders(body["message-headers"]);
	const recipients = isRecipientAllowed(body.recipient, cfg.recipients);
	const textPlain = String(body["body-plain"] || "").slice(0, TEXT_MAX);
	const html = String(body["body-html"] || "").slice(0, HTML_MAX);
	const sender = body.sender || bareAddress(body.from);
	const invite = extractInvite({ textPlain, html }, { recipients: parseList(cfg.recipients) });

	return {
		recipientsMatched: recipients,
		doc: {
			messageId: body["Message-Id"] || headers["message-id"],
			mailgunToken: String(body.token || body.signature?.token || ""),
			recipient: recipients[0] || bareAddress(body.recipient),
			from: body.from,
			sender,
			subject: String(body.subject || "").slice(0, 998),
			textPlain,
			strippedText: String(body["stripped-text"] || "").slice(0, TEXT_MAX),
			html,
			headers: { date: headers.date, "reply-to": headers["reply-to"], to: headers.to, cc: headers.cc, "in-reply-to": headers["in-reply-to"] },
			storageUrl: body["message-url"] || undefined,
			spf: body["X-Mailgun-Spf"] || headers["x-mailgun-spf"],
			dkim: body["X-Mailgun-Dkim-Check-Result"] || headers["x-mailgun-dkim-check-result"],
			senderAllowed: isSenderAllowed(sender, cfg.allowedSenders),
			classification: invite ? "staff_invite" : "generic",
			invite: invite || undefined,
			attachments: readAttachments(files),
		},
	};
};

const receive = async (body, files, { Model = InboundEmail, forwarder = Forwarder, cfg = config.jimInbound } = {}) => {
	const { recipientsMatched, doc } = buildDocument(body, files, cfg);
	if (!recipientsMatched.length) throw new Error("406:recipient_not_allowed");
	if (!doc.mailgunToken) throw new Error("406:missing_token");

	let saved;
	try {
		saved = await Model.create(doc);
	} catch (error) {
		if (error?.code === 11000) throw new Error("406:replayed_token");
		throw error;
	}

	// Notify in the background; Mailgun only needs a fast 200.
	Promise.resolve()
		.then(() => forwarder.forward(saved, { cfg }))
		.then((r) => Model.updateOne({ _id: saved._id }, { $set: { status: r.channel === "none" ? "received" : "forwarded", forwardedAt: new Date() } }))
		.catch((e) => Model.updateOne({ _id: saved._id }, { $set: { status: "error", forwardError: String(e?.message || e).slice(0, 300) } }).catch(() => {}));

	return { id: String(saved._id), classification: saved.classification };
};

const list = async ({ status, since, classification, limit = 50 } = {}, { Model = InboundEmail } = {}) => {
	const q = {};
	if (status) q.status = status;
	if (classification) q.classification = classification;
	if (since) {
		const d = new Date(since);
		if (isNaN(d)) throw new Error("409:invalid_since");
		q.receivedAt = { $gte: d };
	}
	const n = Math.min(Math.max(Number(limit) || 50, 1), 200);
	return Model.find(q, { textPlain: 0, html: 0, headers: 0 }).sort({ receivedAt: -1 }).limit(n).lean();
};

const get = async (id, { Model = InboundEmail } = {}) => {
	const doc = await Model.findById(id).select("+attachments.contentBase64 +invite.token").lean();
	if (!doc) throw new Error("404:not_found");
	return doc;
};

const markAction = async (id, { status, action, note }, actor, { Model = InboundEmail } = {}) => {
	const update = { $push: { actionLog: { at: new Date(), by: actor, action: action || status || "note", note } } };
	if (status) update.$set = { status };
	const doc = await Model.findByIdAndUpdate(id, update, { new: true }).lean();
	if (!doc) throw new Error("404:not_found");
	return doc;
};

module.exports = { receive, list, get, markAction, buildDocument, isSenderAllowed, isRecipientAllowed, parseHeaders, bareAddress };
