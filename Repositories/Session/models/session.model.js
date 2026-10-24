const mongoose = require("mongoose");

const Schema = mongoose.Schema;

const { ObjectId, String } = mongoose.Schema.Types;

const { requiredEnumField, requiredField, refField, defaultField, addBasicPlugins } = require("../../../Core/mongoose-utils");

//####################################################//

const SessionSchema = new Schema({
	identifier: {
		type: String,
		required: true,
		unique: true,
	},
	clientIP: requiredField(String),
	domain: requiredField(String),
	ethAddress: defaultField(String, ""),
	isWebExtension: requiredField(Boolean, false),
	status: requiredEnumField(String, ["active", "used"], "active"),
	tagName: defaultField(String, null),
	/** Server-stamped after a successful face check. Client input never sets this. */
	verifiedTagName: defaultField(String, null),
	verifiedAt: { type: Date },
	verifiedUntil: { type: Date },
	type: requiredEnumField(String, ["createWallet", "decryptWallet", "importWallet", "general"], "createWallet"),
	activatedAt: {
		type: Date,
		expires: 600,
		default: Date.now,
	},
	globalCount: defaultField(Number, 0),
	searchCount: defaultField(Number, 0),
	leaseCount: defaultField(Number, 0),
	decryptCount: defaultField(Number, 0),
	previewCount: defaultField(Number, 0),
	completedAt: {},
});

SessionSchema.pre("save", async (next) => {
	const _this = this;
});

SessionSchema.post("save", async (next) => {
	const _this = this;
});

/**
 * #model methods
 */
SessionSchema.methods = {};

addBasicPlugins(SessionSchema);

const Session = mongoose.model("Session", SessionSchema);

module.exports = Session;
