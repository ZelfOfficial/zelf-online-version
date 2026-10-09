/**
 * RevenueCat webhook for in-app Zelf ID subscriptions and one-time upgrades.
 *
 * Store products: see `zelf-ids-revenue-cat-products.module.js`.
 * Legacy char-bucket products (zns_char_* / zelf_name_service_char_*) remain supported.
 */
const moment = require("moment");
const { getDomainConfig } = require("../../Tags/config/supported-domains");
const {
    getBareName,
    getBareNameLength,
    resolvePaidPlan,
    isShortZelfIdName,
    allowedPlansForName,
} = require("./zelf-id-plan.module");
const { parseSubscriptionProductId } = require("./zelf-ids-revenue-cat-products.module");

const PURCHASE_EVENT_TYPES = new Set(["INITIAL_PURCHASE", "RENEWAL", "NON_RENEWING_PURCHASE"]);
const EXPIRATION_EVENT_TYPES = new Set(["EXPIRATION"]);
const HANDLED_EVENT_TYPE = "NON_RENEWING_PURCHASE";

const LEGACY_PRODUCT_ID_PATTERNS = [
    /(?:^|_)char_(\d{1,2}(?:_to_\d{1,2})?)_years?_(\d+|lifetime)$/,
    /^zns_(\d{1,2}(?:_to_\d{1,2})?)_char_(\d+|lifetime)_years?$/,
];

/** Reasons RevenueCat should not retry: the event is simply not ours. */
const SKIP_REASONS = new Set([
    "ignored_event_type",
    "ignored_cancellation",
    "not_zelf_id_product",
    "sandbox_event",
    "not_subscription_product",
]);

/**
 * @param {string|number} raw
 * @returns {"1"|"2"|"3"|"4"|"5"|"lifetime"|null}
 */
const productDuration = (raw) => {
    const value = String(raw || "").toLowerCase();
    if (value === "lifetime") return "lifetime";
    const years = Number(value);
    return Number.isInteger(years) && years >= 1 && years <= 5 ? `${years}` : null;
};

/**
 * Length bucket and years encoded in a legacy store product id.
 * @param {string} productId
 * @returns {{ minLength: number, maxLength: number, duration: string, legacy: true }|null}
 */
const parseLegacyZelfIdProductId = (productId) => {
    const id = String(productId || "")
        .trim()
        .toLowerCase()
        .split(":")[0];

    for (const pattern of LEGACY_PRODUCT_ID_PATTERNS) {
        const match = id.match(pattern);
        if (!match) continue;

        const [minRaw, maxRaw] = match[1].split("_to_");
        const minLength = Number(minRaw);
        const maxLength = maxRaw ? Number(maxRaw) : minLength;
        const duration = productDuration(match[2]);

        if (!duration || !(minLength >= 1) || !(maxLength >= minLength) || maxLength > 27) return null;

        return { minLength, maxLength, duration, legacy: true };
    }

    return null;
};

/** @deprecated Use `parseLegacyZelfIdProductId` */
const parseZelfIdProductId = parseLegacyZelfIdProductId;

/**
 * @param {{ minLength: number }} product
 * @param {number} nameLength
 * @returns {boolean}
 */
const productCoversNameLength = (product, nameLength) => Boolean(product) && nameLength >= product.minLength && nameLength <= 27;

/**
 * @param {string} productId
 * @returns {{ plan?: "premium"|"unlimited", duration: string, subscription?: boolean, legacy?: boolean, minLength?: number, maxLength?: number }|null}
 */
const parseRevenueCatProduct = (productId) => {
    const subscription = parseSubscriptionProductId(productId);
    if (subscription) return subscription;

    const legacy = parseLegacyZelfIdProductId(productId);
    if (legacy) return legacy;

    return null;
};

/**
 * @param {Object} event
 * @returns {Object<string, string>}
 */
const readSubscriberAttributes = (event = {}) => {
    const attributes = {};
    const raw = event.subscriber_attributes || {};

    for (const key of Object.keys(raw)) {
        const entry = raw[key];
        attributes[key] = entry && typeof entry === "object" ? entry.value : entry;
    }

    return attributes;
};

/**
 * `zelfName` is "alice.zelf" (both apps). Older builds may send `tagName` + `domain`.
 * @param {Object<string, string>} attributes
 * @returns {{ tagName: string, domain: string }}
 */
const resolveNameFromAttributes = (attributes = {}) => {
    const full = String(attributes.zelfName || attributes.tagName || "")
        .trim()
        .toLowerCase();
    const parts = full.split(".");
    const tagName = getBareName(full);
    const domain = String(attributes.domain || parts[1] || "zelf")
        .trim()
        .toLowerCase()
        .replace(/^\./, "");

    return { tagName, domain };
};

/**
 * @param {Object} product
 * @param {string} tagName
 * @param {Object<string, string>} attributes
 * @returns {"premium"|"unlimited"}
 */
const resolvePlanForPurchase = (product, tagName, attributes = {}) => {
    const attrPlan = String(attributes.plan || "").toLowerCase();
    let plan = product.plan;

    if (!plan) {
        plan = resolvePaidPlan({ tagName, requestedPlan: attrPlan });
        if (attrPlan === "premium" || attrPlan === "unlimited") {
            plan = attrPlan;
        }
    }

    if (isShortZelfIdName(tagName) && plan === "premium") {
        return "unlimited";
    }

    return plan;
};

/**
 * @param {Object} product
 * @param {Object<string, string>} attributes
 * @returns {string}
 */
const resolveDurationForPurchase = (product, attributes = {}) => {
    const fromProduct = product.duration;
    const attrDuration = String(attributes.duration || "").trim().toLowerCase();
    if (!attrDuration) return fromProduct;
    if (attrDuration === "lifetime" || attrDuration === "999") return fromProduct;
    if (productDuration(attrDuration) === fromProduct) return fromProduct;
    return fromProduct;
};

/**
 * @param {Object} event
 * @param {Object} [options]
 * @param {boolean} [options.allowSandbox]
 * @returns {{ ok: boolean, action?: string, reason?: string, [key: string]: any }}
 */
const inspectRevenueCatEvent = (event = {}, { allowSandbox = false } = {}) => {
    const eventType = String(event.type || "");

    if (eventType === "CANCELLATION") {
        return { ok: false, reason: "ignored_cancellation" };
    }

    if (EXPIRATION_EVENT_TYPES.has(eventType)) {
        const product = parseRevenueCatProduct(event.product_id);
        if (!product) return { ok: false, reason: "not_zelf_id_product" };
        if (!product.subscription) return { ok: false, reason: "not_subscription_product" };

        if (String(event.environment || "").toUpperCase() === "SANDBOX" && !allowSandbox) {
            return { ok: false, reason: "sandbox_event" };
        }

        const attributes = readSubscriberAttributes(event);
        const { tagName, domain } = resolveNameFromAttributes(attributes);

        return {
            ok: true,
            action: "expire",
            tagName,
            domain,
            plan: product.plan,
            eventId: String(event.id || ""),
            originalTransactionId: String(event.original_transaction_id || ""),
            productId: String(event.product_id),
        };
    }

    if (!PURCHASE_EVENT_TYPES.has(eventType)) {
        return { ok: false, reason: "ignored_event_type" };
    }

    const product = parseRevenueCatProduct(event.product_id);
    if (!product) return { ok: false, reason: "not_zelf_id_product" };

    if (String(event.environment || "").toUpperCase() === "SANDBOX" && !allowSandbox) {
        return { ok: false, reason: "sandbox_event" };
    }

    const attributes = readSubscriberAttributes(event);
    const { tagName, domain } = resolveNameFromAttributes(attributes);

    if (!tagName) return { ok: false, reason: "zelf_name_missing" };

    const nameLength = getBareNameLength(tagName);

    if (product.legacy && !productCoversNameLength(product, nameLength)) {
        return { ok: false, reason: "product_does_not_cover_name", tagName, domain, product };
    }

    const plan = resolvePlanForPurchase(product, tagName, attributes);
    const allowed = allowedPlansForName(`${tagName}.${domain}`);
    if (!allowed.includes(plan)) {
        return { ok: false, reason: "plan_not_allowed_for_name", tagName, domain, plan };
    }

    const ethAddress = String(attributes.ethAddress || "").trim();
    if (!ethAddress) return { ok: false, reason: "eth_address_missing", tagName, domain };

    const duration = resolveDurationForPurchase(product, attributes);
    const price = Number(event.price);
    const originalTransactionId = String(event.original_transaction_id || event.transaction_id || "");

    return {
        ok: true,
        action: "purchase",
        tagName,
        domain,
        ethAddress,
        duration,
        plan,
        subscription: Boolean(product.subscription),
        eventId: String(event.id || ""),
        transactionId: String(event.transaction_id || ""),
        originalTransactionId,
        price: Number.isFinite(price) && price > 0 ? price : 0,
        purchasedAtMs: Number(event.purchased_at_ms || event.event_timestamp_ms) || null,
        productId: String(event.product_id),
        eventType,
    };
};

/**
 * @param {Object} publicData
 * @param {{ eventId: string, purchasedAtMs: number|null }} inspected
 * @returns {boolean}
 */
const alreadyAppliedToRecord = (publicData = {}, { eventId, purchasedAtMs }) => {
    if (publicData.eventID) return Boolean(eventId) && publicData.eventID === eventId;
    if (!purchasedAtMs) return false;

    const purchasedAt = moment(purchasedAtMs);
    const after = (value) => Boolean(value) && moment(value).isAfter(purchasedAt);

    return after(publicData.renewedAt) || after(publicData.registeredAt);
};

const assertOriginalTransactionMatches = (publicData, originalTransactionId) => {
    const stored = String(publicData.revenueCatOriginalTransactionId || "").trim();
    const incoming = String(originalTransactionId || "").trim();
    if (!stored || !incoming) return;
    if (stored !== incoming) {
        throw new Error("409:original_transaction_mismatch");
    }
};

/**
 * @param {Object} inspected
 * @returns {Promise<Object>}
 */
const applyRevenueCatPurchase = async (inspected, { allowSandbox = false } = {}) => {
    const { tagName, domain, ethAddress, duration, plan, eventId, price, originalTransactionId } = inspected;
    const domainConfig = getDomainConfig(domain);
    const { throwPaymentConfirmationTagNotFound } = require("../../Tags/modules/tag-smart-contract-payment.module");
    const ZelfIdModule = require("./zelf-id.module");
    const { addDurationToTag } = require("./my-zelf-id.module");
    const tagData = await ZelfIdModule.searchTag({ tagName, domain, domainConfig, environment: "all" }, {});

    if (tagData.available || !tagData.tagObject?.publicData) {
        throwPaymentConfirmationTagNotFound(tagName, domain);
    }

    const tagObject = tagData.tagObject;
    const owner = String(tagObject.publicData.ethAddress || "").toLowerCase();

    if (!owner || owner !== ethAddress.toLowerCase()) {
        throw new Error("409:zelfProof_does_not_match");
    }

    assertOriginalTransactionMatches(tagObject.publicData, originalTransactionId);

    if (alreadyAppliedToRecord(tagObject.publicData, inspected)) {
        return {
            status: "success",
            action: "already_extended",
            confirmed: true,
            cache: true,
            tagName,
            domain,
            duration,
            plan,
            expiresAt: tagObject.publicData.expiresAt || null,
        };
    }

    const storedName = String(tagObject.publicData[domainConfig.getTagKey()] || tagName);
    const result = await addDurationToTag(
        {
            tagName: storedName.split(".")[0],
            price,
            domain,
            duration: duration === "lifetime" ? "lifetime" : parseInt(duration, 10),
            plan,
            domainConfig,
            eventID: eventId,
            eventPrice: price,
            revenueCatOriginalTransactionId: originalTransactionId || tagObject.publicData.revenueCatOriginalTransactionId,
        },
        tagObject
    );

    return {
        status: "success",
        action: "zelf_id_lease_extended",
        confirmed: true,
        tagName,
        domain,
        duration,
        plan,
        expiresAt: result.expiresAt,
    };
};

/**
 * @param {Object} inspected
 * @returns {Promise<Object>}
 */
const applyRevenueCatExpiration = async (inspected) => {
    const { tagName, domain, eventId, originalTransactionId } = inspected;

    if (!tagName) {
        throw new Error("409:zelf_name_missing");
    }

    const domainConfig = getDomainConfig(domain);
    const { throwPaymentConfirmationTagNotFound } = require("../../Tags/modules/tag-smart-contract-payment.module");
    const ZelfIdModule = require("./zelf-id.module");
    const { revertZelfIdToFreePlan } = require("./my-zelf-id.module");
    const tagData = await ZelfIdModule.searchTag({ tagName, domain, domainConfig, environment: "all" }, {});

    if (tagData.available || !tagData.tagObject?.publicData) {
        throwPaymentConfirmationTagNotFound(tagName, domain);
    }

    const tagObject = tagData.tagObject;

    if (tagObject.publicData.eventID === eventId) {
        return {
            status: "success",
            action: "already_reverted",
            confirmed: true,
            cache: true,
            tagName,
            domain,
            plan: "free",
            expiresAt: tagObject.publicData.expiresAt || null,
        };
    }

    assertOriginalTransactionMatches(tagObject.publicData, originalTransactionId);

    const storedName = String(tagObject.publicData[domainConfig.getTagKey()] || tagName);
    const result = await revertZelfIdToFreePlan(
        {
            tagName: storedName.split(".")[0],
            domain,
            domainConfig,
            eventID: eventId,
            revenueCatOriginalTransactionId: originalTransactionId || tagObject.publicData.revenueCatOriginalTransactionId,
        },
        tagObject
    );

    return {
        status: "success",
        action: "zelf_id_reverted_to_free",
        confirmed: true,
        tagName,
        domain,
        plan: "free",
        expiresAt: result.expiresAt,
    };
};

/**
 * @param {Object} event - `body.event` of the RevenueCat webhook
 * @param {Object} [options]
 * @param {boolean} [options.allowSandbox]
 * @returns {Promise<Object>}
 */
const webhookHandler = async (event, { allowSandbox = false } = {}) => {
    const inspected = inspectRevenueCatEvent(event, { allowSandbox });

    if (!inspected.ok) {
        if (SKIP_REASONS.has(inspected.reason)) {
            return { status: "skipped", reason: inspected.reason, confirmed: false };
        }

        throw new Error(`409:${inspected.reason}`);
    }

    if (inspected.action === "expire") {
        return applyRevenueCatExpiration(inspected);
    }

    return applyRevenueCatPurchase(inspected, { allowSandbox });
};

/** @deprecated Prefer `webhookHandler` */
const confirmRevenueCatPurchase = webhookHandler;

module.exports = {
    HANDLED_EVENT_TYPE,
    PURCHASE_EVENT_TYPES,
    parseZelfIdProductId,
    parseLegacyZelfIdProductId,
    parseRevenueCatProduct,
    productCoversNameLength,
    readSubscriberAttributes,
    resolveNameFromAttributes,
    inspectRevenueCatEvent,
    alreadyAppliedToRecord,
    webhookHandler,
    confirmRevenueCatPurchase,
};
