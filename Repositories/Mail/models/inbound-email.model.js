const mongoose = require("mongoose");
const { Schema } = mongoose;

const AttachmentSchema = new Schema(
	{
		filename: String,
		contentType: String,
		size: Number,
		sha256: String,
		contentBase64: { type: String, select: false },
		storedInline: { type: Boolean, default: false },
	},
	{ _id: false }
);

const InviteSchema = new Schema(
	{
		link: String,
		tokenMasked: String,
		token: { type: String, select: false },
		valid: Boolean,
		reason: String,
		staffEmail: String,
		ownerEmail: String,
		company: String,
		role: String,
		expiresAt: Date,
	},
	{ _id: false }
);

const ActionLogSchema = new Schema(
	{
		at: { type: Date, default: Date.now },
		by: String,
		action: String,
		note: String,
	},
	{ _id: false }
);

const InboundEmailSchema = new Schema(
	{
		messageId: { type: String, index: true },
		mailgunToken: { type: String, required: true, unique: true },
		recipient: { type: String, index: true },
		from: String,
		sender: String,
		subject: String,
		textPlain: String,
		strippedText: String,
		html: String,
		headers: { type: Schema.Types.Mixed },
		storageUrl: String,
		spf: String,
		dkim: String,
		senderAllowed: { type: Boolean, default: false },
		classification: { type: String, enum: ["staff_invite", "generic"], default: "generic", index: true },
		invite: InviteSchema,
		attachments: [AttachmentSchema],
		status: { type: String, enum: ["received", "forwarded", "actioned", "error"], default: "received", index: true },
		forwardedAt: Date,
		forwardError: String,
		actionLog: [ActionLogSchema],
		receivedAt: { type: Date, default: Date.now, index: true },
	},
	{ timestamps: true }
);

module.exports = mongoose.models.InboundEmail || mongoose.model("InboundEmail", InboundEmailSchema);
