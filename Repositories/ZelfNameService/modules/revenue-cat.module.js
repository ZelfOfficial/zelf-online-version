const pinata = require("../../../Core/ipfs");
const TagsModule = require("../../Tags/modules/tags.module");
const moment = require("moment");
const myTagsModule = require("../../Tags/modules/my-tags.module");

/**
 * Acknowledge an event this webhook does not act on.
 *
 * RevenueCat retries anything that is not 2xx (6 attempts), so answering 4xx/5xx
 * for events we never handle only produced retries and noise: EXPIRATION,
 * BILLING_ISSUE, SUBSCRIPTION_EXTENDED, TEST... and Zelf Keys subscription events
 * sent without `zelfName` (the apps check the plan with RevenueCat entitlements and
 * do not send attributes when subscribing).
 */
const _ignoreEvent = (event, reason) => {
	console.info({ revenueCatWebhookIgnored: reason, type: event.type, id: event.id });

	return { ignored: true, reason, type: event.type };
};

const _hasZelfName = (event) => Boolean(event.subscriber_attributes?.zelfName?.value);

const webhookHandler = async (payload) => {
	// we going to check for the event and confirm the information
	const event = payload.event;

	switch (event.type) {
		case "NON_RENEWING_PURCHASE":
			// if (event.environment === "SANDBOX" && config.env === "development") {
			return await _handleWebhook(event);

		case "RENEWAL":
		case "INITIAL_PURCHASE":
			if (!_hasZelfName(event)) return _ignoreEvent(event, "zelf_name_missing");

			return await _handleZelfKeysSubscriptionWebhook(event);

		case "CANCELLATION":
			if (!_hasZelfName(event)) return _ignoreEvent(event, "zelf_name_missing");

			return await _handleZelfKeysSubscriptionCancellationWebhook(event);

		default:
			return _ignoreEvent(event, "unhandled_event_type");
	}
};

/**
 * Format date to YYYY-MM-DD HH:mm:ss
 * @param {Date} date
 * @returns {string} formatted date string
 */
const formatDateTime = (date) => {
	const pad = (n) => String(n).padStart(2, "0");

	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(
		date.getSeconds()
	)}`;
};

/**
 * Convert tagName to zelfKeys format
 * @param {string} tagName
 * @param {string} extension
 * @returns {string} converted zelfKeys format
 */
const convertToZelfKeysFormat = (tagName, extension = ".zelfkeys") => {
	if (!tagName) return tagName;

	tagName = tagName.split(".")[0];

	return `${tagName}${extension}`;
};

/**
 * Search for subscription in IPFS
 * @param {string} zelfKeysTag
 * @returns {Object|null} subscription data
 */
async function searchSubscriptionInIPFS(zelfKeysTag) {
	try {
		const files = await pinata.filter("tagName", zelfKeysTag);

		let activeSubscription = null;

		for (const element of files) {
			const keyValues = element.publicData;
			const isActiveOrCancelledActive = !keyValues.status || keyValues.status === "active" || keyValues.status === "cancelled_active";

			if (isActiveOrCancelledActive) {
				// For cancelled_active, ensure we haven't passed the end date
				if (keyValues.status === "cancelled_active" && keyValues.endDate) {
					const endDate = moment(keyValues.endDate, "YYYY-MM-DD HH:mm:ss");

					if (endDate && endDate.isBefore(moment())) {
						// Subscription has expired
						continue;
					}
				}

				activeSubscription = {
					id: element.id,
					url: element.url,
					ipfs_pin_hash: element.ipfs_pin_hash,
					name: element.name,
					...keyValues,
					revenueCatData: keyValues.revenueCatData ? JSON.parse(keyValues.revenueCatData) : null,
				};

				break;
			}
		}

		return activeSubscription;
	} catch (error) {
		console.error("Error searching subscription in IPFS:", error);
	}

	return null;
}

/**
 * Search for subscription in IPFS by transactionId
 * @param {string} transactionId - RevenueCat transaction ID
 * @returns {Object|null} subscription data if found
 */
async function searchSubscriptionByTransactionId(transactionId) {
	try {
		const files = await pinata.filter("transactionId", transactionId);

		if (!files || !files.length) {
			return null;
		}

		// Return the first matching subscription (should be unique per transaction)
		const element = files[0];
		const keyValues = element.publicData;

		return {
			id: element.id,
			url: element.url,
			ipfs_pin_hash: element.ipfs_pin_hash,
			name: element.name,
			...keyValues,
			revenueCatData: keyValues.revenueCatData ? JSON.parse(keyValues.revenueCatData) : null,
			publicData: keyValues,
		};
	} catch (error) {
		console.error("Error searching subscription by transactionId in IPFS:", error);
	}

	return null;
}

/**
 * Validate metadata for Pinata IPFS upload
 * Pinata requires all keyvalues keys and values to be less than 250 characters
 * @param {Object} metadata - Metadata object to validate
 * @returns {Object} Validation result with isValid flag and violations array
 */
function validateMetadataForIPFS(metadata) {
	const MAX_LENGTH = 250;
	const violations = [];

	if (!metadata || typeof metadata !== "object") {
		return {
			isValid: false,
			violations: ["Metadata is not a valid object"],
		};
	}

	// Check all keys and values in the metadata object
	Object.entries(metadata).forEach(([key, value]) => {
		const keyStr = String(key);
		const valueStr = String(value);

		// Check key length
		if (keyStr.length >= MAX_LENGTH) {
			violations.push({
				type: "key",
				field: keyStr,
				length: keyStr.length,
				preview: keyStr.substring(0, 100) + (keyStr.length > 100 ? "..." : ""),
			});
		}

		// Check value length
		if (valueStr.length >= MAX_LENGTH) {
			violations.push({
				type: "value",
				field: keyStr,
				length: valueStr.length,
				preview: valueStr.substring(0, 100) + (valueStr.length > 100 ? "..." : ""),
			});
		}
	});

	return {
		isValid: violations.length === 0,
		violations,
	};
}

/**
 * Store subscription in IPFS
 * @param {Object} subscriptionData
 * @returns {Object} IPFS result
 */
async function storeSubscriptionInIPFS(subscriptionData) {
	// Validate metadata before uploading to IPFS
	const validation = validateMetadataForIPFS(subscriptionData);

	if (!validation.isValid) {
		console.error("❌ IPFS Metadata Validation Failed:");
		console.error(`   Found ${validation.violations.length} violation(s):`);
		validation.violations.forEach((violation, index) => {
			console.error(`   ${index + 1}. ${violation.type.toUpperCase()} violation in field "${violation.field}":`);
			console.error(`      Length: ${violation.length} characters (max: 250)`);
			console.error(`      Preview: ${violation.preview}`);
		});
		console.error("   Full metadata object:", JSON.stringify(subscriptionData, null, 2));

		const error = new Error("metadata_validation_failed");
		error.status = 400;
		error.details = {
			violations: validation.violations,
			metadata: subscriptionData,
		};
		throw error;
	}

	const ipfsResult = await pinata.pinFile(
		Buffer.from(JSON.stringify(subscriptionData)).toString("base64"),
		`${subscriptionData.tagName}.json`,
		"application/json",
		subscriptionData
	);

	if (!ipfsResult) throw new Error("failed_to_store_subscription_in_ipfs");

	return ipfsResult;
}

/**
 * Update subscription in IPFS
 * @param {string} zelfKeysTag
 * @param {Object} subscriptionData
 * @returns {Object} IPFS result
 */
async function updateSubscriptionInIPFS(zelfKeysTag, subscriptionData) {
	// Validate metadata before uploading to IPFS
	const validation = validateMetadataForIPFS(subscriptionData);

	if (!validation.isValid) {
		console.error("❌ IPFS Metadata Validation Failed:");

		console.error(`   Found ${validation.violations.length} violation(s):`);

		validation.violations.forEach((violation, index) => {
			console.error(`   ${index + 1}. ${violation.type.toUpperCase()} violation in field "${violation.field}":`);
			console.error(`      Length: ${violation.length} characters (max: 250)`);
			console.error(`      Preview: ${violation.preview}`);
		});

		console.error("   Full metadata object:", JSON.stringify(subscriptionData, null, 2));

		const error = new Error("metadata_validation_failed");

		error.status = 400;

		error.details = {
			violations: validation.violations,
			metadata: subscriptionData,
		};

		throw error;
	}

	const ipfsResult = await pinata.pinFile(
		Buffer.from(JSON.stringify(subscriptionData)).toString("base64"),
		`${zelfKeysTag}.json`,
		"application/json",
		subscriptionData
	);

	if (!ipfsResult) throw new Error("failed_to_store_subscription_in_ipfs");

	return ipfsResult;
}

/**
 * Extract attributes from RevenueCat subscriber_attributes
 * @param {Object} event - RevenueCat webhook event
 * @returns {Object} Extracted attributes
 */
const _extractSubscriberAttributes = (event) => {
	const attributes = {};
	const attributeKeys = Object.keys(event.subscriber_attributes || {});

	for (let index = 0; index < attributeKeys.length; index++) {
		const attributeKey = attributeKeys[index];
		attributes[attributeKey] = event.subscriber_attributes[attributeKey].value;
	}

	return attributes;
};

/**
 * Validate and extract tagName and domain from zelfName
 * @param {Object} attributes - Subscriber attributes
 * @returns {Object} Object with tagName and domain
 * @throws {Error} If zelfName is invalid or missing
 */
const _validateAndExtractZelfName = (attributes) => {
	const zelfName = attributes.zelfName;

	if (!zelfName) {
		const error = new Error("zelfName_not_found_in_subscriber_attributes");
		error.status = 400;
		throw error;
	}

	const extractedTagName = zelfName.split(".")[0];
	const extractedDomain = attributes.domain || zelfName.split(".")[1] || "zelf";

	if (!extractedTagName || !extractedDomain) {
		const error = new Error("invalid_zelfName_format");
		error.status = 400;
		throw error;
	}

	return {
		tagName: extractedTagName,
		domain: extractedDomain,
	};
};

/**
 * Verify that the tag exists in the system
 * @param {string} tagName - Tag name to search for
 * @param {string} domain - Domain of the tag
 * @returns {Object} Tag object if found
 * @throws {Error} If tag is not found
 */
const _verifyTagExists = async (tagName, domain) => {
	const searchParams = {
		tagName,
		domain,
		environment: "all",
		type: "both",
	};

	const searchResult = await TagsModule.searchTag(searchParams, {});

	if (searchResult.available || !searchResult.tagObject) {
		const error = new Error("tag_not_found");
		error.status = 404;
		throw error;
	}

	return searchResult.tagObject;
};

/**
 * Verify that ethAddress matches if provided
 * @param {Object} tagObject - Tag object from search
 * @param {string} ethAddress - Ethereum address from attributes
 * @throws {Error} If ethAddress doesn't match
 */
const _verifyEthAddressMatch = (tagObject, ethAddress) => {
	if (ethAddress && tagObject.publicData?.ethAddress !== ethAddress) {
		const error = new Error("zelfProof_does_not_match");
		error.status = 409;
		throw error;
	}
};

/**
 * Get existing subscription from IPFS
 * @param {string} zelfKeysTag - ZelfKeys tag name
 * @returns {Object|null} Existing subscription if found, null otherwise
 */
const _getExistingSubscription = async (zelfKeysTag) => {
	return await searchSubscriptionInIPFS(zelfKeysTag);
};

/**
 * Check if the event was already processed
 * @param {Object|null} existingSubscription - Existing subscription object
 * @param {string} eventId - RevenueCat event ID
 * @returns {boolean} True if already processed, false otherwise
 */
const _isEventAlreadyProcessed = (existingSubscription, eventId) => {
	return existingSubscription?.revenueCatData?.lastProcessedEventId === eventId;
};

/**
 * Calculate subscription dates from RevenueCat event
 * @param {Object} event - RevenueCat webhook event
 * @param {string} duration - Duration in months
 * @returns {Object} Object with purchasedAt and expirationAt moment objects
 */
const _calculateSubscriptionDates = (event, duration) => {
	const purchasedAt = moment(event.purchased_at_ms);
	const expirationAt = moment(event.purchased_at_ms).add(duration, "months");

	return {
		purchasedAt,
		expirationAt,
	};
};

/**
 * Prepare RevenueCat data object
 * @param {Object} event - RevenueCat webhook event
 * @param {Object} purchasedAt - Moment object for purchase date
 * @param {Object} expirationAt - Moment object for expiration date
 * @returns {Object} RevenueCat data object
 */
const _prepareRevenueCatData = (event, purchasedAt, expirationAt) => {
	// Extract plan from entitlement_ids (usually the first one, e.g., "pro", "basic", "enterprise")
	const entitlementIds = event.entitlement_ids || [];

	const plan = entitlementIds.length > 0 ? entitlementIds[0] : null;

	return {
		id: `${event.id}`,
		transactionId: `${event.transaction_id}`,
		// originalTransactionId: event.original_transaction_id,
		// productId: `${event.product_id}`,
		// appUserId: event.app_user_id,
		// originalAppUserId: event.original_app_user_id,
		// environment: event.environment,
		// store: `${event.store}`,
		price: `${event.price}`,
		// priceInPurchasedCurrency: `${event.price_in_purchased_currency}`,
		// currency: `${event.currency}`,
		type: `${event.type}`,
		// renewalNumber: `${event.renewal_number}`,
		purchasedAt: `${purchasedAt.format("YYYY-MM-DD HH:mm:ss")}`,
		expirationAt: `${expirationAt.format("YYYY-MM-DD HH:mm:ss")}`,
		plan: plan,
		// lastProcessedEventId: event.id,
	};
};

/**
 * Create subscription data object for IPFS storage
 * @param {Object} event - RevenueCat webhook event
 * @param {string} zelfKeysTag - ZelfKeys tag name
 * @param {Object} purchasedAt - Moment object for purchase date
 * @param {Object} expirationAt - Moment object for expiration date
 * @param {Object} revenueCatData - RevenueCat data object
 * @returns {Object} Subscription data object
 */
const _createSubscriptionData = (event, zelfKeysTag, purchasedAt, expirationAt, revenueCatData) => {
	return {
		revenueCatData: JSON.stringify(revenueCatData),
		transactionId: `${event.transaction_id}`,
		tagName: `${zelfKeysTag}`,
		startDate: `${purchasedAt.format("YYYY-MM-DD HH:mm:ss")}`,
		endDate: `${expirationAt.format("YYYY-MM-DD HH:mm:ss")}`,
		paymentMethod: "revenuecat",
		type: "subscription",
		status: "active",
	};
};

/**
 * Process subscription update or creation in IPFS
 * @param {string} zelfKeysTag - ZelfKeys tag name
 * @param {Object} subscriptionData - Subscription data to store
 * @param {Object|null} existingSubscription - Existing subscription if any
 * @returns {Object} IPFS result
 */
const _processSubscriptionUpdateOrCreate = async (zelfKeysTag, subscriptionData, existingSubscription) => {
	let ipfsResult;

	if (existingSubscription && existingSubscription.id) {
		// Update existing subscription
		ipfsResult = await updateSubscriptionInIPFS(zelfKeysTag, subscriptionData);

		// Delete old record if new one was created successfully
		if (ipfsResult && ipfsResult.id && existingSubscription.id) {
			try {
				await pinata.deleteFiles([existingSubscription.id]);
			} catch (deleteError) {
				console.error("Error deleting old subscription record:", deleteError);
			}
		}
	} else {
		// Create new subscription
		ipfsResult = await storeSubscriptionInIPFS(subscriptionData);
	}

	return ipfsResult;
};

/**
 * Handle ZelfKeys subscription webhook (RENEWAL and INITIAL_PURCHASE)
 * @param {Object} event - RevenueCat webhook event
 * @returns {Object} webhook handler result
 */
const _handleZelfKeysSubscriptionWebhook = async (event) => {
	try {
		// First, check if subscription already exists for this transactionId
		// This prevents duplicate subscriptions from the same transaction
		if (event.transaction_id) {
			const existingByTransaction = await searchSubscriptionByTransactionId(`${event.transaction_id}`);

			if (existingByTransaction) {
				return {
					success: true,
					message: "subscription_already_exists_for_transaction",
					ipfs: {
						id: existingByTransaction.id,
						ipfs_pin_hash: existingByTransaction.ipfs_pin_hash,
						url: existingByTransaction.url,
						publicData: existingByTransaction.publicData,
					},
					subscription: existingByTransaction,
				};
			}
		}

		// Extract and validate subscriber attributes
		const attributes = _extractSubscriberAttributes(event);

		const { tagName, domain } = _validateAndExtractZelfName(attributes);

		// Verify tag exists and ethAddress matches
		const tagObject = await _verifyTagExists(tagName, domain);
		_verifyEthAddressMatch(tagObject, attributes.ethAddress);

		// Convert to zelfKeys format and check if already processed by event ID
		const zelfKeysTag = convertToZelfKeysFormat(tagName);
		const existingSubscription = await _getExistingSubscription(zelfKeysTag);

		// If already processed by event ID, return early
		if (_isEventAlreadyProcessed(existingSubscription, event.id)) {
			return {
				success: true,
				message: "webhook_already_processed",
				subscription: existingSubscription,
			};
		}

		// Calculate dates and prepare data
		const { purchasedAt, expirationAt } = _calculateSubscriptionDates(event, attributes.duration);
		const revenueCatData = _prepareRevenueCatData(event, purchasedAt, expirationAt);
		const subscriptionData = _createSubscriptionData(event, zelfKeysTag, purchasedAt, expirationAt, revenueCatData);

		// Process subscription update or creation
		const ipfsResult = await _processSubscriptionUpdateOrCreate(zelfKeysTag, subscriptionData, existingSubscription);

		return {
			success: true,
			message: event.type === "INITIAL_PURCHASE" ? "subscription_created" : "subscription_renewed",
			ipfs: ipfsResult,
			subscription: subscriptionData,
		};
	} catch (error) {
		console.error("Error handling zelfKeys subscription webhook:", error);
		throw error;
	}
};

/**
 * Handle ZelfKeys subscription cancellation webhook
 * @param {Object} event - RevenueCat webhook event
 * @returns {Object} webhook handler result
 */
const _handleZelfKeysSubscriptionCancellationWebhook = async (event) => {
	try {
		// Extract attributes from subscriber_attributes
		const attributes = {};
		const attributeKeys = Object.keys(event.subscriber_attributes || {});

		for (let index = 0; index < attributeKeys.length; index++) {
			const attributeKey = attributeKeys[index];
			attributes[attributeKey] = event.subscriber_attributes[attributeKey].value;
		}

		// Get zelfName from subscriber_attributes
		const zelfName = attributes.zelfName;

		if (!zelfName) {
			const error = new Error("zelfName_not_found_in_subscriber_attributes");
			error.status = 400;
			throw error;
		}

		// Split tagName and domain
		const extractedTagName = zelfName.split(".")[0];
		const extractedDomain = attributes.domain || zelfName.split(".")[1] || "zelf";

		if (!extractedTagName || !extractedDomain) {
			const error = new Error("invalid_zelfName_format");
			error.status = 400;
			throw error;
		}

		// Convert to zelfKeys format
		const zelfKeysTag = convertToZelfKeysFormat(extractedTagName);

		// Find existing subscription
		const existingSubscription = await searchSubscriptionInIPFS(zelfKeysTag);

		if (!existingSubscription) {
			return {
				success: true,
				message: "no_active_subscription_found_to_cancel",
			};
		}

		// Parse existing RevenueCat data
		const revenueCatData =
			typeof existingSubscription.revenueCatData === "string"
				? JSON.parse(existingSubscription.revenueCatData)
				: existingSubscription.revenueCatData || {};

		// Update RevenueCat data with cancellation info
		revenueCatData.status = "cancelled";
		revenueCatData.cancelledAt = moment().format("YYYY-MM-DD HH:mm:ss");
		revenueCatData.cancellationEventId = event.id;
		revenueCatData.lastProcessedEventId = event.id;

		// Check if we're still within the paid period
		const expirationAt = existingSubscription.endDate ? moment(existingSubscription.endDate, "YYYY-MM-DD HH:mm:ss") : null;
		const now = moment();

		// If expiration is in the future, mark as cancelled_active (they keep access until expiration)
		// Otherwise, mark as cancelled
		const status = expirationAt && expirationAt.isAfter(now) ? "cancelled_active" : "cancelled";

		// Create updated subscription data
		const subscriptionData = {
			revenueCatData: JSON.stringify(revenueCatData),
			tagName: zelfKeysTag,
			startDate: existingSubscription.startDate || moment().format("YYYY-MM-DD HH:mm:ss"),
			endDate: existingSubscription.endDate || moment().format("YYYY-MM-DD HH:mm:ss"),
			paymentMethod: "revenuecat",
			type: "subscription",
			status: status,
			cancelledAt: moment().format("YYYY-MM-DD HH:mm:ss"),
			cancelAtPeriodEnd: expirationAt && expirationAt.isAfter(now),
		};

		// Update subscription in IPFS
		const ipfsResult = await updateSubscriptionInIPFS(zelfKeysTag, subscriptionData);

		// Delete old record if new one was created successfully
		if (ipfsResult && ipfsResult.id && existingSubscription.id) {
			try {
				await pinata.deleteFiles([existingSubscription.id]);
			} catch (deleteError) {
				console.error("Error deleting old subscription record:", deleteError);
			}
		}

		return {
			success: true,
			message: status === "cancelled_active" ? "subscription_cancelled_will_expire_at_period_end" : "subscription_cancelled",
			ipfs: ipfsResult,
			subscription: subscriptionData,
		};
	} catch (error) {
		console.error("Error handling zelfKeys subscription cancellation webhook:", error);
		throw error;
	}
};

const _handleWebhook = async (event) => {
	const attributes = {};

	const attributeKeys = Object.keys(event.subscriber_attributes || {});

	for (let index = 0; index < attributeKeys.length; index++) {
		const attributeKey = attributeKeys[index];

		attributes[attributeKey] = event.subscriber_attributes[attributeKey]?.value;
	}

	if (typeof attributes.zelfName !== "string" || !attributes.zelfName.trim()) {
		return _ignoreEvent(event, "zelf_name_missing");
	}

	const extractedTagName = attributes.zelfName.split(".")[0];

	const extractedDomain = attributes.domain || attributes.zelfName.split(".")[1] || "zelf";

	const previewQuery = {
		key: "zelfName",
		tagName: extractedTagName,
		environment: "both",
		domain: extractedDomain,
	};

	if (!previewQuery.tagName || !previewQuery.domain) {
		const error = new Error("zelfName_not_found");
		error.status = 404;
		throw error;
	}

	const previewResult = await TagsModule.previewTag(previewQuery, {});

	const zelfNameObject = previewResult.tagObject;

	if (zelfNameObject.publicData.eventID === event.id) {
		const error = new Error("webhook_already_processed");
		error.status = 409;
		throw error;
	}

	const preview = zelfNameObject.preview;

	zelfNameObject.publicData.duration = attributes.duration || zelfNameObject.publicData.duration || "1";

	if (zelfNameObject.publicData.ethAddress !== attributes.ethAddress) {
		const error = new Error("zelfProof_does_not_match");

		error.status = 409;
		throw error;
	}

	return myTagsModule.addDurationToTag(
		{
			tagName: extractedTagName,
			domain: extractedDomain,
			duration: attributes.duration ? Number(attributes.duration) : 1,
			eventID: event.id,
			eventPrice: event.price,
		},
		zelfNameObject
	);
};

// const _addDurationToZelfName = async (preview, zelfNameObject) => {
// 	const base64 = await ZNSPartsModule.urlToBase64(zelfNameObject.url);

// const ethAddress = preview.publicData.ethAddress || zelfNameObject.publicData.ethAddress;
// const solanaAddress = preview.publicData.solanaAddress || zelfNameObject.publicData.solanaAddress;
// const btcAddress = preview.publicData.btcAddress || zelfNameObject.publicData.btcAddress;
// const suiAddress = preview.publicData.suiAddress || zelfNameObject.publicData.suiAddress || "";
// const origin = preview.publicData.origin || zelfNameObject.publicData.origin || "offline";
// const duration = zelfNameObject.publicData.duration;
// const zelfName = zelfNameObject.publicData.zelfName || zelfNameObject.publicData.zelfName.replace(".hold", "");

// 	const payload = {
// 		base64,
// 		name: zelfName.replace(".hold", ""),
// 		metadata: {
// 			hasPassword: zelfNameObject.publicData.hasPassword,
// 			zelfProof: zelfNameObject.publicData.zelfProof,
// 			zelfName,
// 			ethAddress,
// 			solanaAddress,
// 			btcAddress,
// 			extraParams: JSON.stringify({
// 				suiAddress,
// 				origin,
// 				registeredAt:
// 					zelfNameObject.publicData.type === "mainnet" ? zelfNameObject.publicData.registeredAt : moment().format("YYYY-MM-DD HH:mm:ss"),
// 				renewedAt: zelfNameObject.publicData.type === "mainnet" ? moment().format("YYYY-MM-DD HH:mm:ss") : undefined,
// 				expiresAt: moment(zelfNameObject.publicData.expiresAt).add(duration, "year").format("YYYY-MM-DD HH:mm:ss"),
// 				count: parseInt(zelfNameObject.publicData.count) + 1,
// 			}),
// 			type: "mainnet",
// 		},
// 		pinIt: true,
// 	};

// 	const masterArweaveRecord = await ArweaveModule.zelfNameRegistration(base64, {
// 		hasPassword: payload.metadata.hasPassword,
// 		zelfProof: payload.metadata.zelfProof,
// 		publicData: payload.metadata,
// 	});
// };

module.exports = {
	webhookHandler,
};
