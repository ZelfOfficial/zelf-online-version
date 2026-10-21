/**
 * Stripe Checkout for a Zelf ID N-year lease.
 * Metadata on the session and PaymentIntent is the confirm contract.
 */
const Stripe = require("stripe");
const jwt = require("jsonwebtoken");
const moment = require("moment");
const config = require("../../../Core/config");
const { getDomainConfig } = require("../../Tags/config/supported-domains");
const { normalizePaymentDuration } = require("./zelf-id-plan.module");

const SOURCE = "zelf-id-lease";
const TYPE = "zelf_id_lease";
// Plan names are whatever the license planPricing defines (checked at checkout); metadata only needs a slug.
const isPlanSlug = (plan) => /^[a-z0-9_-]+$/i.test(String(plan || ""));
const isDurationStamp = (duration) => duration === "lifetime" || /^\d+$/.test(String(duration || ""));

const getStripeClient = () => Stripe(config.stripe.secretKey);

const durationStamp = (duration) => {
    const normalized = normalizePaymentDuration(duration);
    return normalized === "lifetime" ? "lifetime" : normalized;
};

const landingDurationParam = (duration) => (durationStamp(duration) === "lifetime" ? "999" : durationStamp(duration));

const buildLeaseStripeMetadata = ({ tagName, domain, duration, plan, amountUsd }) => ({
    source: SOURCE,
    type: TYPE,
    tagName: String(tagName || "").trim(),
    domain: String(domain || "").trim(),
    duration: durationStamp(duration),
    plan: String(plan || "").trim(),
    amountUsd: String(amountUsd),
});

const parseLeaseStripeMetadata = (metadata = {}) => {
    const tagName = String(metadata.tagName || "").trim();
    const domain = String(metadata.domain || "").trim();
    const duration = durationStamp(metadata.duration);
    const plan = String(metadata.plan || "").trim();
    const amountUsd = String(metadata.amountUsd || "").trim();

    if (metadata.source !== SOURCE || metadata.type !== TYPE) {
        return null;
    }

    if (!tagName || !domain || !isDurationStamp(duration) || !isPlanSlug(plan)) {
        return null;
    }

    return { tagName, domain, duration, plan, amountUsd };
};

const inspectStripeLeaseSession = (session = {}) => {
    const metadata = parseLeaseStripeMetadata(session.metadata || {});

    if (!metadata) {
        return { ok: false, reason: "not_zelf_id_lease" };
    }

    if (session.payment_status !== "paid") {
        return { ok: false, reason: "unpaid", metadata };
    }

    return {
        ok: true,
        metadata,
        created: session.created,
        amountTotal: session.amount_total,
        sessionId: session.id,
    };
};

const resolveQuotedUsd = (tokenDecoded) => {
    const discounted = Number(tokenDecoded?.devPaymentAmountDiscount?.billableUsdPrice);
    if (Number.isFinite(discounted) && discounted > 0) {
        return discounted;
    }

    const prices = tokenDecoded?.prices || {};
    for (const key of ["ETH", "SOL", "BTC", "AVAX", "BNB", "POL", "BASE", "BDAG"]) {
        const n = Number(prices[key]?.price);
        if (Number.isFinite(n) && n > 0) {
            return n;
        }
    }

    return 0;
};

const tokenDurationStamp = (tokenDecoded) => durationStamp(tokenDecoded?.duration);

const pricingPathPrefix = (locale) => {
    const normalized = String(locale || "en").trim().toLowerCase();
    return !normalized || normalized === "en" ? "" : `/${normalized}`;
};

const createStripeCheckout = async ({ tagName, domain, duration, plan, token, locale, email }) => {
    if (!config.stripe?.secretKey) {
        throw new Error("500:stripe_not_configured");
    }

    const tokenDecoded = jwt.verify(token, config.JWT_SECRET);

    if (!tokenDecoded || !tokenDecoded.tagName) {
        throw new Error("409:invalid_token");
    }

    if (tokenDecoded.ttl < moment().unix()) {
        throw new Error("409:token_expired");
    }

    const localName = String(tagName || "")
        .trim()
        .toLowerCase()
        .replace(/^\./, "");
    const domainName = String(domain || "")
        .trim()
        .toLowerCase()
        .replace(/^\./, "");
    const expectedFull = `${localName}.${domainName}`;

    if (tokenDecoded.tagName !== expectedFull) {
        throw new Error("403:tag_not_owned");
    }

    const expectedDuration = durationStamp(duration);

    if (tokenDurationStamp(tokenDecoded) !== expectedDuration) {
        throw new Error("409:duration_mismatch");
    }

    const { assertLicenseOffersPlan, resolvePaidPlan } = require("./zelf-id-plan.module");
    const licenseConfig = getDomainConfig(domainName);
    const resolvedPlan = plan || tokenDecoded.plan || resolvePaidPlan({ tagName: expectedFull, domainConfig: licenseConfig });

    if (plan && tokenDecoded.plan && tokenDecoded.plan !== plan) {
        throw new Error("409:plan_mismatch");
    }

    if (!resolvedPlan) {
        throw new Error("409:invalid_plan");
    }

    // The license decides which plan/durations exist for this name length.
    const checkedPlan = resolvedPlan === "free" ? resolvePaidPlan({ tagName: expectedFull, domainConfig: licenseConfig }) : resolvedPlan;
    assertLicenseOffersPlan({ domainConfig: licenseConfig, tagName: expectedFull, plan: checkedPlan, duration: expectedDuration });

    const ZelfIdModule = require("./zelf-id.module");
    const tagData = await ZelfIdModule.searchTag({ tagName: localName, domain: domainName, domainConfig: licenseConfig, environment: "all" }, {});
    if (!tagData.available && tagData.tagObject) {
        const { assertPurchaseKeepsPaidValue } = require("./zelf-id-plan.module");
        assertPurchaseKeepsPaidValue({
            publicData: tagData.tagObject.publicData,
            requestedPlan: resolvedPlan,
            tagName: localName,
            domainConfig: licenseConfig,
        });
    }

    const amountUsd = resolveQuotedUsd(tokenDecoded);

    if (!(amountUsd > 0)) {
        throw new Error("409:invalid_quote_amount");
    }

    const unitAmount = Math.max(Math.round(amountUsd * 100), 50);
    const metadata = buildLeaseStripeMetadata({
        tagName: localName,
        domain: domainName,
        duration: expectedDuration,
        plan: resolvedPlan,
        amountUsd,
    });
    const query = new URLSearchParams({
        tagname: localName,
        domain: domainName,
        duration: landingDurationParam(expectedDuration),
        plan: resolvedPlan,
    }).toString();
    const prefix = pricingPathPrefix(locale);
    const origin = String(config.landingUrl || "https://zelf.world").replace(/\/$/, "");
    const termLabel = expectedDuration === "lifetime" ? "Lifetime" : `${expectedDuration}-year`;

    const session = await getStripeClient().checkout.sessions.create({
        payment_method_types: ["card"],
        mode: "payment",
        client_reference_id: expectedFull.slice(0, 200),
        customer_email: email || undefined,
        line_items: [
            {
                price_data: {
                    currency: "usd",
                    unit_amount: unitAmount,
                    product_data: {
                        name: `Zelf ID — ${expectedFull}`,
                        description: `${termLabel} ${resolvedPlan} lease`,
                    },
                },
                quantity: 1,
            },
        ],
        success_url: `${origin}${prefix}/pricing?${query}&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${origin}${prefix}/pricing?${query}`,
        metadata,
        payment_intent_data: {
            metadata,
        },
    });

    return {
        url: session.url,
        sessionId: session.id,
        amountUsd,
        tagName: localName,
        domain: domainName,
        duration: expectedDuration,
        plan: resolvedPlan,
    };
};

const confirmPaidStripeSession = async (session) => {
    const inspected = inspectStripeLeaseSession(session);

    if (!inspected.ok) {
        return {
            status: inspected.reason === "unpaid" ? "unpaid" : "skipped",
            reason: inspected.reason,
            confirmed: false,
            ...(inspected.metadata || {}),
        };
    }

    const { tagName, domain, duration, plan, amountUsd } = inspected.metadata;
    const domainConfig = getDomainConfig(domain);
    const { throwPaymentConfirmationTagNotFound } = require("../../Tags/modules/tag-smart-contract-payment.module");
    const ZelfIdModule = require("./zelf-id.module");
    const { addDurationToTag } = require("./my-zelf-id.module");
    const tagData = await ZelfIdModule.searchTag({ tagName, domain, domainConfig, environment: "all" }, {});

    if (tagData.available) {
        throwPaymentConfirmationTagNotFound(tagName, domain);
    }

    const tagObject = tagData.tagObject;
    const initiatedAt = inspected.created ? moment.unix(inspected.created) : null;
    const renewedAtCondition = Boolean(
        tagObject.publicData.renewedAt && initiatedAt && moment(tagObject.publicData.renewedAt).isAfter(initiatedAt)
    );
    const registeredAtCondition = Boolean(
        initiatedAt && tagObject.publicData.registeredAt && moment(tagObject.publicData.registeredAt).isAfter(initiatedAt)
    );

    if (renewedAtCondition || registeredAtCondition) {
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
            publicData: tagObject.publicData,
        };
    }

    const { assertPurchaseKeepsPaidValue } = require("./zelf-id-plan.module");
    assertPurchaseKeepsPaidValue({
        publicData: tagObject.publicData,
        requestedPlan: plan,
        tagName,
        domainConfig,
    });

    const durationParam = duration === "lifetime" ? "lifetime" : parseInt(duration, 10);
    const price = Number(amountUsd) || (inspected.amountTotal ? inspected.amountTotal / 100 : 0);
    const result = await addDurationToTag(
        {
            tagName: tagObject.publicData[domainConfig.getTagKey()].split(".")[0],
            price,
            domain,
            duration: durationParam,
            plan,
            domainConfig,
            paymentCaptured: true,
            paymentSource: "stripe",
            sessionId: inspected.sessionId,
        },
        tagObject
    );

    if (result.manualReview) {
        return {
            status: "success",
            action: "needs_manual_review",
            confirmed: false,
            manualReview: true,
            reason: result.reason,
            tagName,
            domain,
            duration,
            plan,
            expiresAt: tagObject.publicData.expiresAt || null,
            publicData: tagObject.publicData,
        };
    }

    return {
        status: "success",
        action: "zelf_id_lease_extended",
        confirmed: true,
        tagName,
        domain,
        duration,
        plan,
        expiresAt: result.expiresAt,
        tagObject: result.tagObject,
    };
};

const confirmFromCheckoutEvent = async (event) => confirmPaidStripeSession(event?.data?.object || {});

const confirmFromSessionId = async (sessionId) => {
    const id = String(sessionId || "").trim();

    if (!id.startsWith("cs_")) {
        throw new Error("409:invalid_session_id");
    }

    if (!config.stripe?.secretKey) {
        throw new Error("500:stripe_not_configured");
    }

    const session = await getStripeClient().checkout.sessions.retrieve(id);

    return confirmPaidStripeSession(session);
};

module.exports = {
    SOURCE,
    TYPE,
    buildLeaseStripeMetadata,
    parseLeaseStripeMetadata,
    inspectStripeLeaseSession,
    createStripeCheckout,
    confirmPaidStripeSession,
    confirmFromCheckoutEvent,
    confirmFromSessionId,
};
