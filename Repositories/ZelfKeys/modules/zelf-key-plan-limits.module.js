const crypto = require("crypto");
const moment = require("moment");
const mongoose = require("mongoose");

const config = require("../../../Core/config");
const { effectivePlan } = require("../../ZelfID/modules/zelf-id-plan.module");
const TagsPartsModule = require("../../Tags/modules/tags-parts.module");
const SlotAccount = require("../models/zelf-key-slot-account.model");

const PLAN_RANK = { free: 0, premium: 1, unlimited: 2 };
const KINDS = new Set(["password", "zotp"]);
const SUBSCRIPTION_CACHE_MS = 30 * 1000;
const subscriptionPlanCache = new Map();

const planError = (status, code, message, details) => {
    const error = new Error(`${status}:${code}`);
    error.clientCode = code;
    error.clientMessage = message;
    error.details = details;
    return error;
};

const roundTokens = (value) => {
    const n = Number(value);
    if (!Number.isFinite(n)) return 0;
    return Math.round(n * 1e8) / 1e8;
};

const spendableBalance = (onChain, spent) => Math.max(0, roundTokens(Number(onChain) - Number(spent || 0)));

/**
 * Whole ZNS for a USD amount at the configured token price.
 * Values that land on an integer (0.50 / 0.05 = 10) stay on that integer; everything else ceils.
 * @param {number} usd
 * @param {number} priceUsd
 * @returns {number}
 */
const tokensForUsd = (usd, priceUsd) => {
    const price = Number(priceUsd);
    const amount = Number(usd);
    if (!Number.isFinite(price) || price <= 0) {
        throw planError(500, "ERR_TOKEN_PRICE_INVALID", "Token price is not configured");
    }
    if (!Number.isFinite(amount) || amount < 0) {
        throw planError(500, "ERR_SLOT_PRICE_INVALID", "Slot price is not configured");
    }
    if (amount === 0) return 0;

    const raw = amount / price;
    const nearest = Math.round(raw);
    if (Math.abs(raw - nearest) < 1e-8) return nearest;
    return Math.ceil(raw - 1e-12);
};

const tokenPrice = (priceUsd) => {
    const price = priceUsd == null ? config.getTokenPriceUsd() : Number(priceUsd);
    return price;
};

const slotUsd = (kind) => {
    const table = config.zelfKeysVault?.slotPriceUsd || {};
    return Number(table[kind]);
};

const slotTokenCost = (kind, priceUsd) => tokensForUsd(slotUsd(normalizeKind(kind)), tokenPrice(priceUsd));

const knownPlan = (value) => {
    const plan = String(value || "")
        .trim()
        .toLowerCase();
    return Object.prototype.hasOwnProperty.call(PLAN_RANK, plan) ? plan : null;
};

const normalizePlan = (value) => knownPlan(value) || "free";

const normalizeKind = (value) => {
    const kind = String(value || "")
        .trim()
        .toLowerCase();
    const canonical = kind === "2fa" ? "zotp" : kind;
    if (!KINDS.has(canonical)) {
        throw planError(409, "ERR_SLOT_KIND_INVALID", "Slot kind must be password or zotp", { kind: value });
    }
    return canonical;
};

/**
 * Active Zelf Keys subscription plan, when it is one of free / premium / unlimited.
 * Legacy basic / pro / enterprise entitlements are ignored so their Stripe prices stay unrelated.
 * @param {string} currentPlan
 * @param {Object|string|null} subscription
 * @returns {string}
 */
const applySubscriptionPlan = (currentPlan, subscription) => {
    const raw = typeof subscription === "string" ? subscription : subscription?.plan || subscription?.revenueCatData?.plan;
    const extra = knownPlan(raw);
    if (!extra) return normalizePlan(currentPlan);
    const current = normalizePlan(currentPlan);
    return PLAN_RANK[extra] > PLAN_RANK[current] ? extra : current;
};

const emptyAccount = (zelfName) => ({
    zelfName,
    spent: 0,
    slots: [],
    purchases: [],
});

const trimmed = (value) => (typeof value === "string" ? value.trim() : "");

/**
 * Owner key used by Zelf Keys list/save: JWT `tagName`, or `identifier` when the session has no tagName.
 * `/limits` and `/slots` pass `requireTagName` and reject identifier-only sessions.
 * @param {Object} authUser
 * @param {{ requireTagName?: boolean }} [options]
 * @returns {{ tagName: string, domain: string, zelfName: string }|null}
 */
const resolveOwner = (authUser, { requireTagName = false } = {}) => {
    const tagNameClaim = trimmed(authUser?.tagName);
    const identifier = trimmed(authUser?.identifier);
    const raw = tagNameClaim || (requireTagName ? "" : identifier);

    if (!raw) {
        if (requireTagName) {
            throw planError(401, "ERR_ZELF_IDENTITY_REQUIRED", "Authenticated Zelf identity is required");
        }
        return null;
    }

    const domain = trimmed(authUser?.domain) || "zelf";
    let zelfName;
    try {
        zelfName = TagsPartsModule.getFullTagName(raw, domain);
    } catch (_error) {
        if (requireTagName) {
            throw planError(401, "ERR_ZELF_IDENTITY_REQUIRED", "Authenticated Zelf identity is required");
        }
        return null;
    }

    const bare = zelfName.endsWith(`.${domain}`) ? zelfName.slice(0, -(domain.length + 1)) : zelfName.split(".")[0];

    return {
        tagName: bare,
        domain,
        zelfName,
    };
};

/** Zelf `tagName` is required. Device `identifier` is not an owner for limits or slot purchase. */
const requireZelfIdentity = (authUser) => resolveOwner(authUser, { requireTagName: true });

const limitField = (override, key, fallback) => {
    if (!override || typeof override !== "object" || !Object.prototype.hasOwnProperty.call(override, key)) return fallback;
    const value = override[key];
    if (value === null) return null;
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) return fallback;
    return Math.floor(n);
};

const planEntry = (plans, plan) => {
    if (!Array.isArray(plans)) return null;
    return (
        plans.find((entry) => {
            if (!entry || typeof entry !== "object") return false;
            const name = entry.plan || entry.code || entry.id || entry.name;
            return knownPlan(name) === plan;
        }) || null
    );
};

/**
 * Password and 2FA caps for a plan. Domain `zelfkeys.planLimits` (or a matching `zelfkeys.plans` row)
 * replaces only the fields it sets. `limits.zelfkeys` on the license is an org seat count and is not used here.
 * @param {string} plan
 * @param {Object} [domainConfig]
 * @returns {{ passwords: number|null, zotp: number|null }}
 */
const limitsForPlan = (plan, domainConfig) => {
    const normalized = normalizePlan(plan);
    const base = config.zelfKeysVault?.plans?.[normalized] || config.zelfKeysVault?.plans?.free || { passwords: 5, zotp: 3 };
    const fromPlans = planEntry(domainConfig?.zelfkeys?.plans, normalized);
    const nested = fromPlans?.limits && typeof fromPlans.limits === "object" ? fromPlans.limits : fromPlans;
    const fromTable = domainConfig?.zelfkeys?.planLimits?.[normalized];
    const override = { ...(nested || {}), ...(fromTable || {}) };

    return {
        passwords: limitField(override, "passwords", base.passwords),
        zotp: limitField(override, "zotp", base.zotp),
    };
};

const planLimitForKind = (plan, kind, domainConfig) => {
    const limits = limitsForPlan(plan, domainConfig);
    return kind === "password" ? limits.passwords : limits.zotp;
};

const toDate = (value) => {
    if (value instanceof Date) return value;
    const parsed = new Date(value || Date.now());
    return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
};

const addSlotMonths = (from, months) => moment.utc(from).add(months || 12, "months").toDate();

const activeSlots = (slots, kind, now) => {
    const at = toDate(now).getTime();
    return (Array.isArray(slots) ? slots : []).filter((slot) => slot && slot.kind === kind && toDate(slot.expiresAt).getTime() > at);
};

const presentSlot = (slot) => ({
    slotId: slot.slotId,
    kind: slot.kind,
    purchasedAt: toDate(slot.purchasedAt).toISOString(),
    expiresAt: toDate(slot.expiresAt).toISOString(),
    tokenCost: slot.tokenCost,
});

/**
 * A real Zelf ID record uses effectivePlan (expired paid years read as free, including the
 * license default for planless legacy mainnet). An empty object is not a record and stays free,
 * so a missing lookup cannot inherit a paid plan.
 * @param {Object} [publicData]
 * @param {Object} [domainConfig]
 * @returns {string}
 */
const vaultPlanFromTag = (publicData, domainConfig) => {
    if (!publicData || typeof publicData !== "object") return "free";
    const hasRecord = Boolean(publicData.plan || publicData.type || publicData.zelfName || publicData.tagName || publicData.expiresAt);
    if (!hasRecord) return "free";
    return normalizePlan(effectivePlan(publicData, domainConfig || undefined));
};

const readKeysSubscriptionPlan = async (authUser) => {
    if (process.env.NODE_ENV === "test") return null;

    let identity;
    try {
        identity = requireZelfIdentity(authUser);
    } catch (_error) {
        return null;
    }

    const cached = subscriptionPlanCache.get(identity.zelfName);
    if (cached && cached.expires > Date.now()) return cached.plan;

    let plan = null;
    try {
        const { getActiveSubscription } = require("../../ZelfKeysSubscription/modules/zelf-keys-subscription.module");
        const subscription = await getActiveSubscription({ tagName: identity.tagName });
        plan = knownPlan(subscription?.plan || subscription?.revenueCatData?.plan);
    } catch (error) {
        console.error("Zelf Keys subscription plan lookup failed:", error?.message || error);
        plan = null;
    }

    subscriptionPlanCache.set(identity.zelfName, { plan, expires: Date.now() + SUBSCRIPTION_CACHE_MS });
    return plan;
};

const loadTagPublicData = async (identity, authUser) => {
    const { getDomainConfig } = require("../../Tags/config/supported-domains");
    const domainConfig = getDomainConfig(identity.domain);
    const TagsSearch = require("../../Tags/modules/tags-search.module");
    const result = await TagsSearch.searchTag(
        {
            tagName: identity.tagName,
            domain: identity.domain,
            domainConfig,
            environment: "all",
            type: "both",
        },
        authUser,
    );

    return {
        publicData: result?.tagObject?.publicData || {},
        domainConfig,
    };
};

/**
 * @param {Object} authUser
 * @param {Object} [options]
 * @param {string} [options.plan] explicit plan (tests)
 * @param {Object} [options.tagPublicData]
 * @param {Object} [options.domainConfig]
 * @param {string} [options.subscriptionPlan]
 * @param {boolean} [options.skipTagLookup]
 * @returns {Promise<{ identity: Object, plan: string, publicData: Object, domainConfig: Object|null }>}
 */
const resolveEntitlement = async (authUser, options = {}) => {
    const identity = options.allowIdentifierOwner
        ? resolveOwner(authUser, { requireTagName: false })
        : requireZelfIdentity(authUser);
    if (!identity) return null;
    let domainConfig = options.domainConfig;
    if (domainConfig === undefined) {
        try {
            const { getDomainConfig } = require("../../Tags/config/supported-domains");
            domainConfig = getDomainConfig(identity.domain);
        } catch (_error) {
            domainConfig = null;
        }
    }

    let publicData = options.tagPublicData;
    const shouldLoadTag = publicData == null && options.plan == null && !options.skipTagLookup;
    if (shouldLoadTag) {
        const loaded = await loadTagPublicData(identity, authUser);
        publicData = loaded.publicData;
        if (!domainConfig && loaded.domainConfig) domainConfig = loaded.domainConfig;
    }

    let plan = options.plan != null ? normalizePlan(options.plan) : vaultPlanFromTag(publicData, domainConfig);

    if (options.subscriptionPlan != null) {
        plan = applySubscriptionPlan(plan, options.subscriptionPlan);
    } else if (!options.skipSubscriptionLookup) {
        const keysPlan = await readKeysSubscriptionPlan(authUser);
        if (keysPlan) plan = applySubscriptionPlan(plan, keysPlan);
    }

    return {
        identity,
        plan,
        publicData: publicData || {},
        domainConfig: domainConfig || null,
    };
};

const loadAccount = async (zelfName) => {
    if (mongoose.connection.readyState !== 1) {
        if (process.env.NODE_ENV === "test") return emptyAccount(zelfName);
        throw planError(503, "ERR_SLOT_STORE_UNAVAILABLE", "Slot store is unavailable");
    }

    const doc = await SlotAccount.findOne({ zelfName }).lean();
    return doc || emptyAccount(zelfName);
};

/**
 * Which client field names the record being replaced.
 * Precedence is `id`, then `cid`, then `recordId`. The first non-empty field wins
 * even when it does not match; later fields are not a fallback.
 * @param {Object} item
 * @returns {{ field: "id"|"cid"|"recordId", value: string }|null}
 */
const editReference = (item) => {
    for (const field of ["id", "cid", "recordId"]) {
        const value = trimmed(item?.[field]);
        if (value) return { field, value };
    }
    return null;
};

const rowMatchesReference = (row, value) => Boolean(row) && (row.id === value || row.cid === value);

/**
 * Owned row a save should replace, or null when the winning reference is absent or not owned.
 * @param {string} kind
 * @param {Object} item
 * @param {Array} existingItems
 * @returns {Object|null}
 */
const findEditTarget = (kind, item, existingItems) => {
    normalizeKind(kind);
    const reference = editReference(item);
    if (!reference || !Array.isArray(existingItems)) return null;
    return existingItems.find((row) => rowMatchesReference(row, reference.value)) || null;
};

const isItemUpdate = (kind, item, existingItems) => Boolean(findEditTarget(kind, item, existingItems));

/**
 * @returns {Object} decision including allowed, kind, count, limit, plan, tokenCost
 */
const evaluateLimit = ({ plan, kind, used, slots, isUpdate = false, now, domainConfig, priceUsd } = {}) => {
    const normalizedKind = normalizeKind(kind);
    const normalizedPlan = normalizePlan(plan);
    const planLimit = planLimitForKind(normalizedPlan, normalizedKind, domainConfig);
    const extras = activeSlots(slots, normalizedKind, now);
    const limit = planLimit === null ? null : planLimit + extras.length;
    const count = Number(used) || 0;
    const tokenCost = slotTokenCost(normalizedKind, priceUsd);
    const allowed = Boolean(isUpdate) || limit === null || count < limit;

    return {
        allowed,
        isUpdate: Boolean(isUpdate),
        kind: normalizedKind,
        plan: normalizedPlan,
        count,
        limit,
        planLimit,
        extraSlots: extras.length,
        tokenCost,
        slotUsd: slotUsd(normalizedKind),
        activeExtraSlots: extras.map(presentSlot),
    };
};

const limitReachedError = (decision) =>
    planError(409, "ERR_PLAN_LIMIT_REACHED", "Plan limit reached", {
        kind: decision.kind,
        count: decision.count,
        limit: decision.limit,
        plan: decision.plan,
        tokenCost: decision.tokenCost,
        extraSlots: decision.extraSlots,
    });

const assertCanAdd = async ({ authUser, kind, used, items, item, tagPublicData, domainConfig, now, subscriptionPlan }) => {
    const entitlement = await resolveEntitlement(authUser, {
        tagPublicData: tagPublicData ?? null,
        domainConfig,
        subscriptionPlan,
        skipTagLookup: true,
        allowIdentifierOwner: true,
    });
    if (!entitlement) {
        return { allowed: true, isUpdate: false, replacedId: null };
    }

    const account = await loadAccount(entitlement.identity.zelfName);
    const target = findEditTarget(kind, item, items);
    const decision = evaluateLimit({
        plan: entitlement.plan,
        kind,
        used,
        slots: account.slots,
        isUpdate: Boolean(target),
        now,
        domainConfig: entitlement.domainConfig,
    });

    if (!decision.allowed) throw limitReachedError(decision);
    return {
        ...decision,
        replacedId: target ? target.id || target.cid : null,
    };
};

const buildUsage = ({
    plan,
    counts = {},
    slots,
    balance,
    onChainBalance,
    spent,
    domainConfig,
    priceUsd,
    now,
    zelfName,
    balanceAvailable = true,
}) => {
    const normalizedPlan = normalizePlan(plan);
    const price = tokenPrice(priceUsd);
    const kinds = {};

    for (const kind of ["password", "zotp"]) {
        const decision = evaluateLimit({
            plan: normalizedPlan,
            kind,
            used: counts[kind] || 0,
            slots,
            isUpdate: false,
            now,
            domainConfig,
            priceUsd: price,
        });

        kinds[kind] = {
            used: decision.count,
            limit: decision.limit,
            planLimit: decision.planLimit,
            extraSlots: decision.extraSlots,
            activeExtraSlots: decision.activeExtraSlots,
            tokenCost: decision.tokenCost,
            slotUsd: decision.slotUsd,
            canAdd: decision.allowed,
        };
    }

    const available = balanceAvailable ? spendableBalance(balance, 0) : null;

    return {
        zelfName,
        plan: normalizedPlan,
        tokenBalance: available,
        onChainBalance: balanceAvailable && onChainBalance != null ? roundTokens(onChainBalance) : null,
        tokensSpent: roundTokens(spent || 0),
        tokenPriceUsd: price,
        balanceAvailable: Boolean(balanceAvailable),
        kinds,
    };
};

const readOnChainBalance = async (publicData) => {
    const address = publicData?.solanaAddress;
    if (!address || typeof address !== "string") return 0;

    let result;
    try {
        const detector = require("../../ZelfNameService/modules/zns-transaction-detector.module");
        result = await detector.getZNSBalance(address);
    } catch (_error) {
        throw planError(503, "ERR_TOKEN_BALANCE_UNAVAILABLE", "Token balance is unavailable");
    }

    if (result?.error) {
        const missing = /could not find|does not exist|invalid param|account not found/i.test(String(result.error));
        if (!missing) {
            throw planError(503, "ERR_TOKEN_BALANCE_UNAVAILABLE", "Token balance is unavailable");
        }
        return 0;
    }

    const balance = Number(result?.balance);
    if (!Number.isFinite(balance) || balance < 0) {
        throw planError(503, "ERR_TOKEN_BALANCE_UNAVAILABLE", "Token balance is unavailable");
    }
    return balance;
};

const readBalanceForUsage = async (publicData, options) => {
    if (options.balance != null) {
        return { onChain: Number(options.balance), balanceAvailable: true };
    }

    try {
        return { onChain: await readOnChainBalance(publicData), balanceAvailable: true };
    } catch (error) {
        if (error?.clientCode === "ERR_TOKEN_BALANCE_UNAVAILABLE") {
            return { onChain: null, balanceAvailable: false };
        }
        throw error;
    }
};

const duplicateKey = (error) => {
    const code = error?.code ?? error?.cause?.code;
    if (code === 11000) return true;
    const message = `${error?.message || ""} ${error?.cause?.message || ""}`;
    return message.includes("E11000") || message.includes("duplicate key") || /must be unique/i.test(message);
};

const findPurchase = (account, idempotencyKey) =>
    (account?.purchases || []).find((row) => row && row.idempotencyKey === idempotencyKey) || null;

const findSlot = (account, slotId) => (account?.slots || []).find((row) => row && row.slotId === slotId) || null;

const insufficientTokens = (kind, onChain, spent, cost) =>
    planError(409, "ERR_INSUFFICIENT_TOKENS", "Insufficient tokens", {
        kind,
        balance: spendableBalance(onChain, spent),
        cost,
    });

const purchaseResult = ({ idempotent, kind, tokenCost, onChain, spent, slot }) => ({
    idempotent,
    kind,
    tokenCost,
    balance: spendableBalance(onChain, spent),
    slot: slot ? presentSlot(slot) : null,
    spent,
});

/**
 * Reserve `cost` tokens and append one slot, or return the earlier purchase for the same key.
 * The account document is created only when the debit succeeds.
 */
const debitAndGrant = async ({ identity, kind, cost, idempotencyKey, balance, now }) => {
    if (mongoose.connection.readyState !== 1) {
        throw planError(503, "ERR_SLOT_STORE_UNAVAILABLE", "Slot store is unavailable");
    }

    const onChain = roundTokens(balance);
    if (!Number.isFinite(onChain) || onChain < 0) {
        throw planError(503, "ERR_TOKEN_BALANCE_UNAVAILABLE", "Token balance is unavailable");
    }

    const purchasedAt = toDate(now);
    const expiresAt = addSlotMonths(purchasedAt, config.zelfKeysVault?.slotDurationMonths);
    const slotId = crypto.randomUUID();
    const slot = { slotId, kind, purchasedAt, expiresAt, tokenCost: cost, idempotencyKey };
    const purchase = { idempotencyKey, kind, tokenCost: cost, slotId, purchasedAt };

    const debitExisting = () =>
        SlotAccount.findOneAndUpdate(
            {
                zelfName: identity.zelfName,
                purchases: { $not: { $elemMatch: { idempotencyKey } } },
                $expr: { $lte: [{ $add: ["$spent", cost] }, onChain] },
            },
            {
                $inc: { spent: cost },
                $push: { purchases: purchase, slots: slot },
            },
            { new: true },
        ).lean();

    const fromDocument = (doc, idempotent, tokenCost, slotRow) =>
        purchaseResult({
            idempotent,
            kind,
            tokenCost,
            onChain,
            spent: doc.spent,
            slot: slotRow,
        });

    let updated = await debitExisting();
    if (updated) return fromDocument(updated, false, cost, findSlot(updated, slotId));

    let current = await SlotAccount.findOne({ zelfName: identity.zelfName }).lean();
    if (!current) {
        if (onChain < cost) throw insufficientTokens(kind, onChain, 0, cost);

        try {
            const created = await SlotAccount.create({
                zelfName: identity.zelfName,
                domain: identity.domain,
                tagName: identity.tagName,
                spent: cost,
                slots: [slot],
                purchases: [purchase],
            });
            return fromDocument(created, false, cost, slot);
        } catch (error) {
            if (!duplicateKey(error)) throw error;
            updated = await debitExisting();
            if (updated) return fromDocument(updated, false, cost, findSlot(updated, slotId));
            current = await SlotAccount.findOne({ zelfName: identity.zelfName }).lean();
        }
    }

    const prior = findPurchase(current, idempotencyKey);
    if (prior) {
        if (prior.kind !== kind) {
            throw planError(409, "ERR_IDEMPOTENCY_CONFLICT", "Idempotency key was already used for a different slot", {
                kind,
                existingKind: prior.kind,
            });
        }
        return fromDocument(current, true, prior.tokenCost, findSlot(current, prior.slotId));
    }

    throw insufficientTokens(kind, onChain, current?.spent, cost);
};

const assertIdempotencyKey = (value) => {
    const idempotencyKey = typeof value === "string" ? value.trim() : "";
    if (!/^[A-Za-z0-9._:-]{8,128}$/.test(idempotencyKey)) {
        throw planError(409, "ERR_IDEMPOTENCY_KEY_INVALID", "Idempotency key must be 8 to 128 characters");
    }
    return idempotencyKey;
};

/**
 * Spend tokens for one extra slot of `kind`. Body `tagName` is ignored; the owner is the JWT Zelf identity.
 * @param {Object} body
 * @param {Object} authUser
 * @param {Object} [options]
 */
const purchaseExtraSlot = async (body, authUser, options = {}) => {
    const kind = normalizeKind(body?.kind);
    const idempotencyKey = assertIdempotencyKey(body?.idempotencyKey);
    const entitlement = await resolveEntitlement(authUser, options);
    const planLimit = planLimitForKind(entitlement.plan, kind, entitlement.domainConfig);

    if (planLimit === null) {
        throw planError(409, "ERR_EXTRA_SLOT_NOT_NEEDED", "This plan already includes unlimited slots", {
            kind,
            plan: entitlement.plan,
        });
    }

    const price = tokenPrice(options.priceUsd);
    const cost = slotTokenCost(kind, price);
    const onChain = options.balance != null ? Number(options.balance) : await readOnChainBalance(entitlement.publicData);
    const granted = await debitAndGrant({
        identity: entitlement.identity,
        kind,
        cost,
        idempotencyKey,
        balance: onChain,
        now: options.now,
    });

    return {
        ...granted,
        plan: entitlement.plan,
        tokenPriceUsd: price,
        zelfName: entitlement.identity.zelfName,
    };
};

const getPlanUsage = async (authUser, counts, options = {}) => {
    const entitlement = await resolveEntitlement(authUser, options);
    const account = await loadAccount(entitlement.identity.zelfName);
    const { onChain, balanceAvailable } = await readBalanceForUsage(entitlement.publicData, options);
    const spent = account.spent || 0;

    return buildUsage({
        plan: entitlement.plan,
        counts,
        slots: account.slots,
        balance: balanceAvailable ? spendableBalance(onChain, spent) : null,
        onChainBalance: balanceAvailable ? onChain : null,
        spent,
        domainConfig: entitlement.domainConfig,
        priceUsd: options.priceUsd,
        now: options.now,
        zelfName: entitlement.identity.zelfName,
        balanceAvailable,
    });
};

module.exports = {
    PLAN_RANK,
    activeSlots,
    applySubscriptionPlan,
    assertCanAdd,
    assertIdempotencyKey,
    buildUsage,
    debitAndGrant,
    editReference,
    evaluateLimit,
    findEditTarget,
    getPlanUsage,
    isItemUpdate,
    limitReachedError,
    normalizeKind,
    limitsForPlan,
    loadAccount,
    planError,
    purchaseExtraSlot,
    requireZelfIdentity,
    resolveEntitlement,
    slotTokenCost,
    tokensForUsd,
    vaultPlanFromTag,
};
