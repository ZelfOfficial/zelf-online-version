const crypto = require("crypto");
const fs = require("fs");
const axios = require("axios");
const config = require("../../../Core/config");
const InboundEmail = require("../models/inbound-email.model");
const { extractInvite } = require("./invite-extractor.module");
const Forwarder = require("./jim-forwarder.module");

const INLINE_TYPES = ["application/pdf", "text/calendar", "text/plain", "text/csv", "image/png", "image/jpeg", "image/gif", "image/webp"];
const INLINE_MAX = 2 * 1024 * 1024;
const FETCH_MAX = 8 * 1024 * 1024;
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

const mailgunAuth = (apiKey) => ({ Authorization: `Basic ${Buffer.from(`api:${apiKey}`).toString("base64")}` });

const baseType = (contentType) => String(contentType || "").split(";")[0].trim().toLowerCase();

const canInline = (contentType, size) => size <= INLINE_MAX && INLINE_TYPES.includes(baseType(contentType));

const attachmentFromRemote = (remote, buf) => {
	const contentType = remote["content-type"] || remote.contentType || "application/octet-stream";
	const size = buf ? buf.length : Number(remote.size) || 0;
	const out = {
		filename: remote.name || remote.filename || "attachment",
		contentType,
		size,
		sha256: buf ? crypto.createHash("sha256").update(buf).digest("hex") : undefined,
		mailgunUrl: remote.url,
	};
	if (buf && canInline(contentType, size)) {
		out.contentBase64 = buf.toString("base64");
		out.storedInline = true;
	}
	return out;
};

/**
 * Fill attachments that the route forward did not include, using the Mailgun store() URL.
 * Allowlisted types ≤ 2 MB are inlined. Anything else keeps the hash and the storage URL.
 */
const fetchStoredAttachments = async (storageUrl, { http, apiKey } = {}) => {
	if (!storageUrl || !apiKey || !http) return [];
	const message = await http.get(storageUrl, { headers: mailgunAuth(apiKey), timeout: 15000 });
	const list = message.data?.attachments || [];
	const out = [];
	for (const remote of list) {
		if (!remote?.url) continue;
		const declared = Number(remote.size) || 0;
		if (declared > FETCH_MAX) {
			out.push(attachmentFromRemote(remote, null));
			continue;
		}
		const file = await http.get(remote.url, { headers: mailgunAuth(apiKey), timeout: 20000, responseType: "arraybuffer" });
		out.push(attachmentFromRemote(remote, Buffer.from(file.data)));
	}
	return out;
};

const mergeAttachments = (local = [], remote = []) => {
	const byName = new Map(remote.map((item) => [item.filename, item]));
	const used = new Set();
	const merged = local.map((item) => {
		const fetched = byName.get(item.filename);
		if (!fetched) return item;
		used.add(item.filename);
		if (item.sha256) return { ...item, mailgunUrl: item.mailgunUrl || fetched.mailgunUrl };
		return { ...fetched, filename: item.filename || fetched.filename };
	});
	for (const item of remote) if (!used.has(item.filename)) merged.push(item);
	return merged;
};

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

const receive = async (body, files, { Model = InboundEmail, forwarder = Forwarder, cfg = config.jimInbound, storageHttp = axios, apiKey = config.email_providers?.mailgun?.apiKey } = {}) => {
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
		.then(async () => {
			const $set = {};
			if (doc.storageUrl) {
				try {
					const remote = await fetchStoredAttachments(doc.storageUrl, { http: storageHttp, apiKey });
					if (remote.length) $set.attachments = mergeAttachments(doc.attachments, remote);
				} catch (error) {
					$set.attachmentError = String(error?.message || error).slice(0, 300);
				}
			}
			const forwarded = await forwarder.forward(saved, { cfg });
			$set.status = forwarded.channel === "none" ? "received" : "forwarded";
			$set.forwardedAt = new Date();
			await Model.updateOne({ _id: saved._id }, { $set });
		})
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

module.exports = { receive, list, get, markAction, buildDocument, isSenderAllowed, isRecipientAllowed, parseHeaders, bareAddress, fetchStoredAttachments, mergeAttachments };
