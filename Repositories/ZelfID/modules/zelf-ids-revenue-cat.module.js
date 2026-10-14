/**
 * RevenueCat webhook for in-app Zelf ID subscriptions and one-time upgrades.
 *
 * Store products: see `zelf-ids-revenue-cat-products.module.js`.
 * Legacy char-bucket products (zns_char_* / zelf_name_service_char_*) remain supported.
 */
const moment = require("moment");
const { getDomainConfig } = require("../../Tags/config/supported-domains");
const { getBareName, getBareNameLength, resolvePaidPlan } = require("./zelf-id-plan.module");
const { parseSubscriptionProductId } = require("./zelf-ids-revenue-cat-products.module");

const PURCHASE_EVENT_TYPES = new Set(["INITIAL_PURCHASE", "RENEWAL", "NON_RENEWING_PURCHASE"]);
const EXPIRATION_EVENT_TYPES = new Set(["EXPIRATION"]);
const PRODUCT_CHANGE_EVENT_TYPES = new Set(["PRODUCT_CHANGE"]);
/** Events that continue an existing transaction: the name comes from original_transaction_id first. */
const LOOKUP_BY_TRANSACTION_EVENT_TYPES = new Set(["RENEWAL", "EXPIRATION", "PRODUCT_CHANGE"]);
/** EXPIRATION is ignored when the name is paid this much past the subscription period end. */
const EXPIRATION_EXTENSION_TOLERANCE_MS = 7 * 24 * 60 * 60 * 1000;
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
    "superseded_by_later_purchase",
    "extended_beyond_subscription",
    "already_free",
    "deferred_downgrade",
    "plan_unchanged",
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
 * Plan for a purchase. v4 products carry the plan and it is never rewritten:
 * premium on a 1–5 character name is rejected later (`plan_not_allowed_for_name`).
 * Legacy char-bucket products have no plan: use the attribute when the name allows it.
 * @param {Object} product
 * @param {string} tagName
 * @param {Object<string, string>} attributes
 * @returns {"premium"|"unlimited"}
 */
const resolvePlanForPurchase = (product, tagName, attributes = {}) => {
    if (product.plan) return product.plan;

    const attrPlan = String(attributes.plan || "").toLowerCase();
    if (attrPlan === "unlimited") return "unlimited";
    if (attrPlan === "premium") return "premium";
    return resolvePaidPlan({ tagName, requestedPlan: attrPlan });
};

/**
 * Valid plan/duration for a name comes only from the license `planPricing`:
 * e.g. premium on 1–5 chars is invalid because the license has no premium cell for that length.
 * @param {string} domain
 * @param {string} tagName
 * @param {string} plan
 * @param {string} [duration]
 * @returns {boolean}
 */
const licenseAllowsPlan = (domain, tagName, plan, duration) => {
    const domainConfig = getDomainConfig(domain);
    if (typeof domainConfig?.licenseOffersPlan !== "function") return false;
    return domainConfig.licenseOffersPlan(plan, getBareNameLength(tagName), duration);
};

const isSandbox = (event) => String(event.environment || "").toUpperCase() === "SANDBOX";

/**
 * Pure parse of a RevenueCat event. The name may still be unresolved for
 * RENEWAL / EXPIRATION / PRODUCT_CHANGE: `webhookHandler` resolves it by original_transaction_id.
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

    const isExpiration = EXPIRATION_EVENT_TYPES.has(eventType);
    const isProductChange = PRODUCT_CHANGE_EVENT_TYPES.has(eventType);

    if (!isExpiration && !isProductChange && !PURCHASE_EVENT_TYPES.has(eventType)) {
        return { ok: false, reason: "ignored_event_type" };
    }

    const productId = isProductChange ? event.new_product_id || event.product_id : event.product_id;
    const product = parseRevenueCatProduct(productId);
    if (!product) return { ok: false, reason: "not_zelf_id_product" };
    if (isExpiration && !product.subscription) return { ok: false, reason: "not_subscription_product" };

    if (isSandbox(event) && !allowSandbox) {
        return { ok: false, reason: "sandbox_event" };
    }

    const attributes = readSubscriberAttributes(event);
    const { tagName, domain } = resolveNameFromAttributes(attributes);
    const originalTransactionId = String(event.original_transaction_id || event.transaction_id || "");
    const base = {
        ok: true,
        eventType,
        tagName,
        domain,
        attributes,
        product,
        eventId: String(event.id || ""),
        transactionId: String(event.transaction_id || ""),
        originalTransactionId,
        productId: String(productId),
        appUserId: String(event.app_user_id || event.original_app_user_id || ""),
        environment: String(event.environment || ""),
        lookupByTransaction: LOOKUP_BY_TRANSACTION_EVENT_TYPES.has(eventType),
    };

    if (isExpiration) {
        return {
            ...base,
            action: "expire",
            plan: product.plan,
            expirationAtMs: Number(event.expiration_at_ms) || null,
        };
    }

    if (isProductChange) {
        const previous = parseRevenueCatProduct(event.product_id);
        return {
            ...base,
            action: "change_plan",
            plan: product.plan,
            previousPlan: previous?.plan || null,
        };
    }

    const price = Number(event.price);

    return {
        ...base,
        action: "purchase",
        plan: product.plan || resolvePlanForPurchase(product, tagName, attributes),
        ethAddress: String(attributes.ethAddress || "").trim(),
        duration: product.duration,
        subscription: Boolean(product.subscription),
        price: Number.isFinite(price) && price > 0 ? price : 0,
        purchasedAtMs: Number(event.purchased_at_ms || event.event_timestamp_ms) || null,
    };
};

/**
 * Validate a purchase once its name is known.
 * @param {Object} inspected
 * @returns {{ ok: boolean, reason?: string, [key: string]: any }}
 */
const validatePurchase = (inspected) => {
    const { tagName, domain, product, attributes, ethAddress } = inspected;

    if (!tagName) return { ok: false, reason: "zelf_name_missing" };

    const nameLength = getBareNameLength(tagName);
    if (product.legacy && !productCoversNameLength(product, nameLength)) {
        return { ok: false, reason: "product_does_not_cover_name", tagName, domain, product };
    }

    const plan = resolvePlanForPurchase(product, tagName, attributes);
    if (!licenseAllowsPlan(domain, tagName, plan, inspected.duration)) {
        return { ok: false, reason: "plan_not_allowed_for_name", tagName, domain, plan };
    }

    if (!ethAddress) return { ok: false, reason: "eth_address_missing", tagName, domain };

    return { ...inspected, ok: true, plan };
};

/**
 * RENEWAL / EXPIRATION / PRODUCT_CHANGE: the name stored for original_transaction_id wins over attributes.
 * @param {Object} inspected
 * @returns {Promise<Object>}
 */
const resolveNameByTransaction = async (inspected) => {
    if (!inspected.lookupByTransaction || !inspected.originalTransactionId) return inspected;

    const { findByOriginalTransactionId } = require("./zelf-ids-revenue-cat-transactions.module");
    const mapped = await findByOriginalTransactionId(inspected.originalTransactionId);
    if (!mapped?.tagName) return inspected;

    return {
        ...inspected,
        tagName: getBareName(mapped.tagName),
        domain: mapped.domain || inspected.domain || "zelf",
        ethAddress: mapped.ethAddress || inspected.ethAddress,
        resolvedBy: "original_transaction_id",
    };
};

const rememberTransaction = async (inspected, extra = {}) => {
    const { recordTransaction } = require("./zelf-ids-revenue-cat-transactions.module");
    try {
        await recordTransaction({
            originalTransactionId: inspected.originalTransactionId,
            tagName: inspected.tagName,
            domain: inspected.domain,
            ethAddress: inspected.ethAddress,
            appUserId: inspected.appUserId,
            productId: inspected.productId,
            plan: inspected.plan,
            subscription: inspected.product?.subscription,
            environment: inspected.environment,
            lastEventId: inspected.eventId,
            lastEventType: inspected.eventType,
            ...extra,
        });
    } catch (error) {
        // The name itself is already updated; a lost mapping only affects later lookups.
        console.error("RevenueCat transaction mapping save failed:", error?.message || error);
    }
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

const loadTag = async ({ tagName, domain }) => {
    const domainConfig = getDomainConfig(domain);
    const { throwPaymentConfirmationTagNotFound } = require("../../Tags/modules/tag-smart-contract-payment.module");
    const ZelfIdModule = require("./zelf-id.module");
    const tagData = await ZelfIdModule.searchTag({ tagName, domain, domainConfig, environment: "all" }, {});

    if (tagData.available || !tagData.tagObject?.publicData) {
        throwPaymentConfirmationTagNotFound(tagName, domain);
    }

    return { domainConfig, tagObject: tagData.tagObject };
};

const storedBareName = (tagObject, domainConfig, tagName) => String(tagObject.publicData[domainConfig.getTagKey()] || tagName).split(".")[0];

/**
 * Purchases (INITIAL_PURCHASE / RENEWAL / NON_RENEWING_PURCHASE) add time.
 * A purchase with a different original_transaction_id (annual → 2y / lifetime upgrade)
 * is applied and becomes the name's current transaction.
 * @param {Object} inspected
 * @returns {Promise<Object>}
 */
const applyRevenueCatPurchase = async (inspected) => {
    const { tagName, domain, ethAddress, duration, plan, eventId, price, originalTransactionId } = inspected;
    const { addDurationToTag } = require("./my-zelf-id.module");
    const { domainConfig, tagObject } = await loadTag({ tagName, domain });
    const owner = String(tagObject.publicData.ethAddress || "").toLowerCase();

    if (!owner || owner !== ethAddress.toLowerCase()) {
        throw new Error("409:zelfProof_does_not_match");
    }

    if (alreadyAppliedToRecord(tagObject.publicData, inspected)) {
        await rememberTransaction(inspected);
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

    const result = await addDurationToTag(
        {
            tagName: storedBareName(tagObject, domainConfig, tagName),
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

    await rememberTransaction(inspected);

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
 * Why an EXPIRATION must not revert this name, or null when it should.
 * @param {Object} publicData
 * @param {Object} inspected
 * @returns {string|null}
 */
const expirationSkipReason = (publicData = {}, { originalTransactionId, expirationAtMs }) => {
    if (publicData.plan === "free") return "already_free";

    const current = String(publicData.revenueCatOriginalTransactionId || "").trim();
    if (current && originalTransactionId && current !== String(originalTransactionId).trim()) {
        return "superseded_by_later_purchase";
    }

    if (String(publicData.duration || "").toLowerCase() === "lifetime") return "extended_beyond_subscription";

    const expiresAt = publicData.expiresAt ? moment(publicData.expiresAt) : null;
    const periodEnd = expirationAtMs ? moment(expirationAtMs) : moment();
    if (expiresAt?.isValid() && expiresAt.valueOf() > periodEnd.valueOf() + EXPIRATION_EXTENSION_TOLERANCE_MS) {
        return "extended_beyond_subscription";
    }

    return null;
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

    const { revertZelfIdToFreePlan } = require("./my-zelf-id.module");
    const { domainConfig, tagObject } = await loadTag({ tagName, domain });

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

    const skip = expirationSkipReason(tagObject.publicData, inspected);
    if (skip) {
        await rememberTransaction(inspected, { status: "expired" });
        return { status: "skipped", reason: skip, confirmed: false, tagName, domain, expiresAt: tagObject.publicData.expiresAt || null };
    }

    const result = await revertZelfIdToFreePlan(
        {
            tagName: storedBareName(tagObject, domainConfig, tagName),
            domain,
            domainConfig,
            eventID: eventId,
            revenueCatOriginalTransactionId: originalTransactionId || tagObject.publicData.revenueCatOriginalTransactionId,
        },
        tagObject
    );

    await rememberTransaction(inspected, { status: "expired", plan: "free" });

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
 * PRODUCT_CHANGE premium → unlimited: switch the plan now, keep the paid-through date.
 * Downgrades are deferred by the stores and arrive as a RENEWAL of the new product.
 * @param {Object} inspected
 * @returns {Promise<Object>}
 */
const applyRevenueCatProductChange = async (inspected) => {
    const { tagName, domain, eventId, plan, originalTransactionId } = inspected;

    if (!tagName) throw new Error("409:zelf_name_missing");
    if (plan !== "unlimited") {
        return { status: "skipped", reason: "deferred_downgrade", confirmed: false, tagName, domain };
    }

    if (!licenseAllowsPlan(domain, tagName, plan)) throw new Error("409:plan_not_allowed_for_name");

    const { changeZelfIdPlan } = require("./my-zelf-id.module");
    const { domainConfig, tagObject } = await loadTag({ tagName, domain });
    const publicData = tagObject.publicData;

    if (inspected.ethAddress && String(publicData.ethAddress || "").toLowerCase() !== inspected.ethAddress.toLowerCase()) {
        throw new Error("409:zelfProof_does_not_match");
    }

    const current = String(publicData.revenueCatOriginalTransactionId || "").trim();
    if (current && originalTransactionId && current !== originalTransactionId) {
        return { status: "skipped", reason: "superseded_by_later_purchase", confirmed: false, tagName, domain };
    }

    if (publicData.eventID === eventId || publicData.plan === "unlimited") {
        return { status: "skipped", reason: "plan_unchanged", confirmed: false, tagName, domain, plan: publicData.plan };
    }

    if (publicData.plan !== "premium") {
        // A free (expired) name has nothing to upgrade; the purchase event will credit it.
        return { status: "skipped", reason: "plan_unchanged", confirmed: false, tagName, domain, plan: publicData.plan };
    }

    const result = await changeZelfIdPlan(
        {
            tagName: storedBareName(tagObject, domainConfig, tagName),
            domain,
            domainConfig,
            plan,
            eventID: eventId,
            revenueCatOriginalTransactionId: originalTransactionId || current,
        },
        tagObject
    );

    await rememberTransaction(inspected);

    return {
        status: "success",
        action: "zelf_id_plan_changed",
        confirmed: true,
        tagName,
        domain,
        plan,
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
    let inspected = inspectRevenueCatEvent(event, { allowSandbox });

    if (!inspected.ok) {
        if (SKIP_REASONS.has(inspected.reason)) {
            return { status: "skipped", reason: inspected.reason, confirmed: false };
        }

        throw new Error(`409:${inspected.reason}`);
    }

    // Validate purchases before claiming, so a permanent 409 never holds a claim.
    if (inspected.action === "purchase" && !inspected.lookupByTransaction) {
        const early = validatePurchase(inspected);
        if (!early.ok) throw new Error(`409:${early.reason}`);
    }

    const { claimEvent, releaseEvent, markEventProcessed } = require("./zelf-ids-revenue-cat-events.module");
    const eventId = inspected.eventId;

    if (eventId && !(await claimEvent(inspected))) {
        return { status: "skipped", ignored: "duplicate_event", reason: "duplicate_event", confirmed: false };
    }

    let result;
    try {
        result = await applyInspectedEvent(inspected);
    } catch (error) {
        if (eventId) {
            await releaseEvent(eventId).catch((releaseError) =>
                console.error("RevenueCat event claim release failed:", releaseError?.message || releaseError)
            );
        }
        throw error;
    }

    if (eventId) {
        await markEventProcessed(eventId, { status: result?.status, action: result?.action || result?.reason || null }).catch((markError) =>
            console.error("RevenueCat event mark processed failed:", markError?.message || markError)
        );
    }

    return result;
};

const applyInspectedEvent = async (claimed) => {
    const inspected = await resolveNameByTransaction(claimed);

    if (inspected.action === "expire") return applyRevenueCatExpiration(inspected);
    if (inspected.action === "change_plan") return applyRevenueCatProductChange(inspected);

    const validated = validatePurchase(inspected);
    if (!validated.ok) throw new Error(`409:${validated.reason}`);

    return applyRevenueCatPurchase(validated);
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
    validatePurchase,
    licenseAllowsPlan,
    expirationSkipReason,
    alreadyAppliedToRecord,
    webhookHandler,
    confirmRevenueCatPurchase,
};
