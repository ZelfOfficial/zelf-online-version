const crypto = require("crypto");
const axios = require("axios");
const config = require("../../../Core/config");

const buildNotification = (doc) => ({
	id: String(doc._id),
	receivedAt: doc.receivedAt,
	recipient: doc.recipient,
	from: doc.from,
	subject: doc.subject,
	snippet: String(doc.strippedText || doc.textPlain || "").replace(/\s+/g, " ").slice(0, 280),
	classification: doc.classification,
	senderAllowed: doc.senderAllowed,
	attachmentCount: (doc.attachments || []).length,
	invite: doc.invite
		? {
				valid: doc.invite.valid,
				reason: doc.invite.reason,
				company: doc.invite.company,
				role: doc.invite.role,
				staffEmail: doc.invite.staffEmail,
				expiresAt: doc.invite.expiresAt,
				token: doc.invite.tokenMasked,
		  }
		: null,
});

const discordText = (n) => {
	const lines = [`📧 **Jim inbound** — ${n.subject || "(no subject)"}`, `From: ${n.from} → ${n.recipient}`];
	if (n.invite) lines.push(`Staff invite: ${n.invite.company || "?"} as ${n.invite.role || "?"} (${n.invite.valid ? "valid" : n.invite.reason}) — accept manually`);
	if (!n.senderAllowed) lines.push("Sender not on allowlist (stored only).");
	if (n.snippet) lines.push(`> ${n.snippet.slice(0, 200)}`);
	lines.push(`id: \`${n.id}\``);
	return lines.join("\n").slice(0, 1900);
};

/** Send a short notification (never the full body or invite token). */
const forward = async (doc, { http = axios, cfg = config.jimInbound } = {}) => {
	const n = buildNotification(doc);

	if (cfg.forwardUrl) {
		const body = JSON.stringify(n);
		const ts = Math.floor(Date.now() / 1000).toString();
		const headers = { "Content-Type": "application/json", "X-Jim-Timestamp": ts };
		if (cfg.forwardSecret) headers["X-Jim-Signature"] = crypto.createHmac("sha256", cfg.forwardSecret).update(`${ts}.${body}`).digest("hex");
		await http.post(cfg.forwardUrl, body, { headers, timeout: 10000 });
		return { channel: "forward_url" };
	}

	if (cfg.discordWebhookUrl) {
		await http.post(cfg.discordWebhookUrl, { content: discordText(n), allowed_mentions: { parse: [] } }, { timeout: 10000 });
		return { channel: "discord" };
	}

	return { channel: "none" };
};

module.exports = { forward, buildNotification, discordText };
