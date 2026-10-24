const mongoose = require("mongoose");

const Schema = mongoose.Schema;

const { ObjectId, String } = mongoose.Schema.Types;

const { requiredEnumField, requiredField, refField, defaultField, addBasicPlugins } = require("../../../Core/mongoose-utils");

//####################################################//

const SessionSchema = new Schema({
	// Not unique: each issued token has its own session, even when the client repeats an identifier.
	identifier: {
		type: String,
		required: true,
		index: true,
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

let identifierIndexPromise = null;

/**
 * Existing databases may still have a unique `identifier_1` index.
 * Drop it so a second token for the same client identifier can be stored.
 * Fresh databases never create that unique index.
 */
const ensureNonUniqueIdentifierIndex = () => {
	if (!identifierIndexPromise) {
		identifierIndexPromise = applyNonUniqueIdentifierIndex().catch((error) => {
			identifierIndexPromise = null;
			throw error;
		});
	}

	return identifierIndexPromise;
};

ensureNonUniqueIdentifierIndex.reset = () => {
	identifierIndexPromise = null;
};

const applyNonUniqueIdentifierIndex = async () => {
	let indexes = [];

	try {
		indexes = await Session.collection.indexes();
	} catch (error) {
		if (error && (error.code === 26 || error.codeName === "NamespaceNotFound")) {
			identifierIndexPromise = null;
			return;
		}
		throw error;
	}

	const legacy = indexes.find((index) => index.unique && index.key && Object.keys(index.key).length === 1 && index.key.identifier === 1);

	if (legacy) await Session.collection.dropIndex(legacy.name);
};

const originalInit = Session.init;

Session.init = function init() {
	if (this.$init != null) return this.$init;

	const pending = (async () => {
		try {
			await ensureNonUniqueIdentifierIndex();
		} catch (error) {
			console.error({ error, message: "session identifier index" });
		}

		if (this.$init === pending) this.$init = null;

		return originalInit.call(this);
	})();

	this.$init = pending;

	return pending;
};

module.exports = Session;
module.exports.ensureNonUniqueIdentifierIndex = ensureNonUniqueIdentifierIndex;
