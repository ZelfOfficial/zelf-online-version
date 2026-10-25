/**
 * Free-plan monthly ZNS access.
 * One charge per Zelf ID per UTC month (YYYY-MM), on the first liveness open that
 * reads stored secrets or unlocks the wallet. Premium and Unlimited are exempt.
 * The fee is off unless MONTHLY_ZNS_ACCESS_ENABLED=true.
 *
 * Price: license one-year Premium / 12, whole ZNS via the extra-slot rounding,
 * never below the configured monthly active-user floor. A signed quote locks
 * that price for 2 hours, the same ttl field payment options use.
 */
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const moment = require("moment");
const mongoose = require("mongoose");

const config = require("../../../Core/config");
const { getBareNameLength } = require("./zelf-id-plan.module");
const { normalizeZelfName } = require("../../Tags/modules/zelf-name.util");
const {
    applySubscriptionPlan,
    readOnChainBalance,
    resolveEntitlement,
    spendableBalance,
    tokensForUsd,
    vaultPlanFromTag,
} = require("../../ZelfKeys/modules/zelf-key-plan-limits.module");
const SlotAccount = require("../../ZelfKeys/models/zelf-key-slot-account.model");
const MonthlyAccess = require("../models/zelf-id-monthly-access.model");
const MonthlyAccessAudit = require("../models/zelf-id-monthly-access-audit.model");

const QUOTE_TYPE = "monthly_access";
const QUOTE_HOURS = 2;

/** Face checks that must not charge or consume the monthly grace open. */
const EXEMPT_TRIGGERS = new Set([
    "daily-reward",
    "store",
    "delete",
    "password-change",
    "preview",
    "slot-purchase",
    "payment-confirmation",
    "wallet-export",
    "lease-recovery",
    "lease",
    "wallet-create",
    "wallet-import",
    "transfer",
    "license-extend",
]);

/** Opens that charge on the first use of the UTC month. */
const TRIGGER_TRIGGERS = new Set(["retrieve", "decrypt", "tags-decrypt", "zns-decrypt", "wallet-decrypt"]);

const PAID_PLANS = new Set(["premium", "unlimited"]);

const isEnabled = () => config.monthlyZnsAccess.enabled === true;

const periodKeyFromDate = (date) => moment.utc(date || new Date()).format("YYYY-MM");

const previousPeriodKey = (date) => moment.utc(date || new Date()).subtract(1, "month").format("YYYY-MM");

const accessError = (status, code, message, details) => {
    const error = new Error(`${status}:${code}`);
    error.clientCode = code;
    error.clientMessage = message;
    error.details = details;
    error.status = status;
    return error;
};

const isDuplicateKey = (error) => {
    const code = error?.code ?? error?.cause?.code;
    if (code === 11000) return true;
    const message = `${error?.message || ""} ${error?.cause?.message || ""}`;
    return message.includes("E11000") || message.includes("duplicate key") || /must be unique/i.test(message);
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let indexesReady = null;
/** Unique (zelfName, periodKey) is built explicitly. Production may leave mongoose autoIndex off. */
const ensureIndexes = () => {
    if (mongoose.connection.readyState !== 1) return Promise.resolve();
    if (!indexesReady) {
        indexesReady = Promise.all([MonthlyAccess.createIndexes(), MonthlyAccessAudit.createIndexes()]).catch((error) => {
            indexesReady = null;
            throw error;
        });
    }
    return indexesReady;
};

/**
 * One-year Premium USD for this name. Names the license does not price for Premium
 * use the one-year Premium cell of the shortest length that can buy Premium.
 * @param {string} tagName
 * @param {Object} domainConfig
 * @returns {number|undefined}
 */
const premiumYearlyUsdFor = (tagName, domainConfig) => {
    if (!domainConfig || typeof domainConfig.licensePlanPrice !== "function") return undefined;
    const length = getBareNameLength(tagName);
    const own = domainConfig.licensePlanPrice("premium", length, "1");
    if (typeof own === "number") return own;

    const table = domainConfig.tags?.payment?.planPricing?.premium;
    if (!table || typeof table !== "object") return undefined;

    let best = null;
    for (const [key, cells] of Object.entries(table)) {
        const price = cells?.["1"];
        if (typeof price !== "number" || !Number.isFinite(price)) continue;
        const range = /^(\d+)-(\d+)$/.exec(key);
        const start = range ? Number(range[1]) : Number(key);
        if (!Number.isFinite(start)) continue;
        if (!best || start < best.start) best = { start, price };
    }
    return best ? best.price : undefined;
};

/**
 * Monthly USD string from the yearly license cell (yearly / 12), 10 decimal places.
 * @param {number} yearlyUsd
 * @returns {string}
 */
const formatAmountUsd = (yearlyUsd) => {
    const monthly = Number(yearlyUsd) / 12;
    const rounded = Math.round((monthly + Number.EPSILON) * 1e10) / 1e10;
    const text = rounded.toFixed(10);
    return text.replace(/\.?0+$/, "") || "0";
};

/**
 * Whole ZNS for the month: max(premium monthly equivalent, floor), extra-slot rounding.
 * @param {Object} params
 * @returns {Object}
 */
const describeAmount = ({ tagName, domainConfig, tokenPriceUsd, floorUsd } = {}) => {
    const premiumYearlyUsd = premiumYearlyUsdFor(tagName, domainConfig);
    if (typeof premiumYearlyUsd !== "number") {
        throw accessError(409, "monthly_access_price_unavailable", "Premium price is not in the license");
    }

    const price = tokenPriceUsd == null ? config.getTokenPriceUsd() : Number(tokenPriceUsd);
    const floor = floorUsd == null ? Number(config.monthlyZnsAccess.floorUsd) : Number(floorUsd);
    const monthlyUsd = premiumYearlyUsd / 12;
    const premiumZns = tokensForUsd(monthlyUsd, price);
    const floorZns = tokensForUsd(floor, price);

    return {
        premiumYearlyUsd,
        amountUsd: formatAmountUsd(premiumYearlyUsd),
        tokenPriceUsd: price,
        floorUsd: floor,
        floorZns,
        premiumZns,
        amountZns: Math.max(premiumZns, floorZns),
    };
};

const quotePayload = (identity, amount, now) => ({
    typ: QUOTE_TYPE,
    zelfName: identity.zelfName,
    periodKey: periodKeyFromDate(now),
    premiumYearlyUsd: amount.premiumYearlyUsd,
    amountUsd: amount.amountUsd,
    tokenPriceUsd: amount.tokenPriceUsd,
    floorUsd: amount.floorUsd,
    floorZns: amount.floorZns,
    amountZns: amount.amountZns,
    quoteId: crypto.randomUUID(),
    ttl: moment.utc(now || new Date()).add(QUOTE_HOURS, "hours").unix(),
});

const quoteSecret = () => {
    const dedicated = process.env.MONTHLY_ZNS_ACCESS_QUOTE_SECRET;
    if (dedicated != null && String(dedicated).trim() !== "") return String(dedicated);
    return config.JWT_SECRET;
};

const signQuote = (payload) => jwt.sign(payload, quoteSecret());

const paymentOptions = (quote, spendable) => {
    const balance = Number.isFinite(Number(spendable)) ? Number(spendable) : 0;
    const znsNeeded = Math.max(0, Math.round((quote.amountZns - balance) * 1e8) / 1e8);
    return {
        znsNeeded,
        options: [
            { type: "upgrade", plan: "premium" },
            { type: "card", available: false, amountUsd: quote.amountUsd },
            { type: "zns", amountZns: quote.amountZns, znsNeeded },
        ],
    };
};

const paymentRequiredBody = ({ quote, spendable, periodKey, signedDataPrice }) => {
    const balance = Number.isFinite(Number(spendable)) ? Number(spendable) : 0;
    const extra = paymentOptions(quote, balance);
    const confirmReady = balance >= Number(quote.amountZns);
    return {
        message: "Monthly access payment is required",
        code: "monthly_access_payment_required",
        periodKey: periodKey || quote.periodKey,
        amountZns: quote.amountZns,
        amountUsd: quote.amountUsd,
        tokenPriceUsd: quote.tokenPriceUsd,
        floorUsd: quote.floorUsd,
        premiumYearlyUsd: quote.premiumYearlyUsd,
        spendableBalance: balance,
        znsNeeded: extra.znsNeeded,
        openAllowed: false,
        confirmReady,
        signedDataPrice: signedDataPrice || null,
        options: extra.options,
    };
};

const signedQuoteFor = (view) => {
    const payload = quotePayload(
        view.identity,
        {
            premiumYearlyUsd: view.quote.premiumYearlyUsd,
            amountUsd: view.quote.amountUsd,
            tokenPriceUsd: view.quote.tokenPriceUsd,
            floorUsd: view.quote.floorUsd,
            floorZns: view.quote.floorZns,
            amountZns: view.quote.amountZns,
        },
        view.now,
    );
    if (view.quote.quoteId) payload.quoteId = view.quote.quoteId;
    payload.periodKey = view.periodKey || payload.periodKey;
    return signQuote(payload);
};

const presentRecord = (record, extra = {}) => {
    if (!record) return null;
    return {
        zelfName: record.zelfName,
        periodKey: record.periodKey,
        status: record.status === "reserving" ? "pending" : record.status,
        amountZns: record.amountZns,
        amountUsd: record.amountUsd,
        tokenPriceUsd: record.tokenPriceUsd,
        premiumYearlyUsd: record.premiumYearlyUsd,
        floorUsd: record.floorUsd,
        trigger: record.trigger,
        quoteId: record.quoteId,
        settlement: record.settlement || null,
        graceAt: record.graceAt ? new Date(record.graceAt).toISOString() : null,
        chargedAt: record.chargedAt ? new Date(record.chargedAt).toISOString() : null,
        ...extra,
    };
};

const writeAudit = async (entry) => {
    if (mongoose.connection.readyState !== 1) return;
    try {
        await MonthlyAccessAudit.create({
            zelfName: entry.zelfName,
            periodKey: entry.periodKey,
            event: entry.event,
            amountZns: entry.amountZns ?? null,
            amountUsd: entry.amountUsd ?? null,
            tokenPriceUsd: entry.tokenPriceUsd ?? null,
            trigger: entry.trigger || null,
            quoteId: entry.quoteId || null,
            at: entry.at || new Date(),
        });
    } catch (error) {
        console.error("monthly_access_audit_failed", error?.message || error);
    }
};

const quoteFromRecord = (record) => ({
    periodKey: record.periodKey,
    premiumYearlyUsd: record.premiumYearlyUsd,
    amountUsd: record.amountUsd,
    tokenPriceUsd: record.tokenPriceUsd,
    floorUsd: record.floorUsd,
    amountZns: record.amountZns,
    quoteId: record.quoteId,
});

const loadAccount = async (zelfName) => {
    if (mongoose.connection.readyState !== 1) return { spent: 0, monthlyCharges: [] };
    const doc = await SlotAccount.findOne({ zelfName }).lean();
    return doc || { spent: 0, monthlyCharges: [] };
};

const observedBalance = async (input, publicData) => {
    if (input.balance != null) {
        const onChain = Number(input.balance);
        if (!Number.isFinite(onChain) || onChain < 0) {
            throw accessError(503, "ERR_TOKEN_BALANCE_UNAVAILABLE", "Token balance is unavailable");
        }
        return { onChain, available: true };
    }
    try {
        const onChain = await readOnChainBalance(publicData || {});
        return { onChain: Number(onChain) || 0, available: true };
    } catch (error) {
        if (error?.clientCode === "ERR_TOKEN_BALANCE_UNAVAILABLE") return { onChain: 0, available: false };
        throw error;
    }
};

const resolveContext = async (input) => {
    const domainHint = input.domain || input.authUser?.domain || "zelf";
    const rawName = input.zelfName || input.tagName || input.authUser?.tagName;
    const normalized = normalizeZelfName(rawName, domainHint);
    if (!normalized.zelfName) return null;

    let domainConfig = input.domainConfig;
    if (!domainConfig) {
        try {
            const { getDomainConfig } = require("../../Tags/config/supported-domains");
            domainConfig = getDomainConfig(normalized.domain);
        } catch (_error) {
            domainConfig = null;
        }
    }

    if (input.authUser && input.plan == null && input.publicData == null) {
        const entitlement = await resolveEntitlement(input.authUser, {
            domainConfig,
            skipSubscriptionLookup: Boolean(input.skipSubscriptionLookup),
        });
        if (!entitlement) return null;
        let plan = entitlement.plan;
        if (input.subscriptionPlan) plan = applySubscriptionPlan(plan, input.subscriptionPlan);
        return {
            identity: entitlement.identity.zelfName === normalized.zelfName ? entitlement.identity : normalized,
            plan,
            publicData: entitlement.publicData || {},
            domainConfig: entitlement.domainConfig || domainConfig,
        };
    }

    let plan = input.plan || vaultPlanFromTag(input.publicData, domainConfig);
    if (input.subscriptionPlan) plan = applySubscriptionPlan(plan, input.subscriptionPlan);
    if (input.authUser && !input.skipSubscriptionLookup && !input.plan) {
        const entitlement = await resolveEntitlement(input.authUser, {
            plan,
            tagPublicData: input.publicData || {},
            domainConfig,
            skipTagLookup: true,
        });
        if (entitlement?.plan) plan = entitlement.plan;
    }

    return {
        identity: normalized,
        plan,
        publicData: input.publicData || {},
        domainConfig,
    };
};

const findMonth = (zelfName, periodKey) => MonthlyAccess.findOne({ zelfName, periodKey }).lean();

const graceAllowedFor = async (zelfName, now) => {
    const previous = await findMonth(zelfName, previousPeriodKey(now));
    if (!previous) return true;
    return previous.status === "paid";
};

/**
 * Wait out an in-flight claim. A stale reserving row with no debit is removed
 * so a later open can record the month.
 */
const settleReservation = async (record) => {
    let current = record;
    for (let attempt = 0; attempt < 20 && current?.status === "reserving"; attempt += 1) {
        await sleep(25);
        current = await MonthlyAccess.findById(record._id).lean();
    }
    if (!current || current.status !== "reserving") return current;

    const account = await loadAccount(current.zelfName);
    const charged = (account.monthlyCharges || []).some((row) => row && row.periodKey === current.periodKey);
    if (charged) {
        return MonthlyAccess.findOneAndUpdate(
            { _id: current._id, status: "reserving" },
            { $set: { status: "paid", settlement: "zns", chargedAt: current.chargedAt || new Date() } },
            { new: true },
        ).lean();
    }

    const updatedAt = new Date(current.updatedAt || current.createdAt || 0).getTime();
    if (Date.now() - updatedAt >= 15000) {
        await MonthlyAccess.deleteOne({ _id: current._id, status: "reserving" });
        return null;
    }
    return current;
};

/**
 * Reserve `cost` ZNS once for `periodKey` on the same spent balance extra slots use.
 * A second call for that period does not increase `spent`.
 */
const debitOnce = async ({ identity, cost, periodKey, quoteId, onChain, now }) => {
    if (mongoose.connection.readyState !== 1) {
        throw accessError(503, "ERR_SLOT_STORE_UNAVAILABLE", "Slot store is unavailable");
    }

    const amount = Number(cost);
    if (!Number.isFinite(amount) || amount < 0) {
        throw accessError(500, "monthly_access_price_unavailable", "Monthly access price is not available");
    }

    const chain = Number(onChain);
    if (!Number.isFinite(chain) || chain < 0) {
        throw accessError(503, "ERR_TOKEN_BALANCE_UNAVAILABLE", "Token balance is unavailable");
    }

    if (amount === 0) {
        const current = await loadAccount(identity.zelfName);
        return { idempotent: false, spent: current.spent || 0, zero: true };
    }

    const charge = {
        periodKey,
        amountZns: amount,
        quoteId: quoteId || crypto.randomUUID(),
        chargedAt: now ? new Date(now) : new Date(),
    };

    const debitExisting = () =>
        SlotAccount.findOneAndUpdate(
            {
                zelfName: identity.zelfName,
                monthlyCharges: { $not: { $elemMatch: { periodKey } } },
                $expr: { $lte: [{ $add: ["$spent", amount] }, chain] },
            },
            { $inc: { spent: amount }, $push: { monthlyCharges: charge } },
            { new: true },
        ).lean();

    let updated = await debitExisting();
    if (updated) return { idempotent: false, spent: updated.spent };

    let current = await SlotAccount.findOne({ zelfName: identity.zelfName }).lean();
    if (!current) {
        if (chain < amount) {
            throw accessError(402, "monthly_access_payment_required", "Monthly access payment is required");
        }
        try {
            const created = await SlotAccount.create({
                zelfName: identity.zelfName,
                domain: identity.domain,
                tagName: identity.tagName,
                spent: amount,
                slots: [],
                purchases: [],
                monthlyCharges: [charge],
            });
            return { idempotent: false, spent: created.spent };
        } catch (error) {
            if (!isDuplicateKey(error)) throw error;
            updated = await debitExisting();
            if (updated) return { idempotent: false, spent: updated.spent };
            current = await SlotAccount.findOne({ zelfName: identity.zelfName }).lean();
        }
    }

    if ((current?.monthlyCharges || []).some((row) => row && row.periodKey === periodKey)) {
        return { idempotent: true, spent: current.spent || 0 };
    }

    throw accessError(402, "monthly_access_payment_required", "Monthly access payment is required");
};

const spendableAfter = async (view) => {
    if (!view?.identity?.zelfName) return view?.spendable ?? 0;
    const account = await loadAccount(view.identity.zelfName);
    return spendableBalance(view.onChain, account.spent || 0);
};

const blockedResult = async (view, { audit = true } = {}) => {
    if (audit) {
        await writeAudit({
            zelfName: view.identity.zelfName,
            periodKey: view.periodKey,
            event: "grace_blocked",
            amountZns: view.quote.amountZns,
            amountUsd: view.quote.amountUsd,
            tokenPriceUsd: view.quote.tokenPriceUsd,
            trigger: view.trigger,
            quoteId: view.quote.quoteId,
            at: view.now,
        });
    }
    const spendable = await spendableAfter(view);
    let signedDataPrice = null;
    if (view.identity?.zelfName) {
        try {
            signedDataPrice = signedQuoteFor({ ...view, spendable });
        } catch (_error) {
            signedDataPrice = null;
        }
    }
    const body = paymentRequiredBody({
        quote: view.quote,
        spendable,
        periodKey: view.periodKey,
        signedDataPrice,
    });
    return {
        allowed: false,
        blocked: true,
        charged: false,
        status: view.record?.status === "grace" ? "grace" : "none",
        body,
        receipt: null,
    };
};

const allowedResult = (view, extra = {}) => ({
    allowed: true,
    blocked: false,
    charged: false,
    status: extra.status || view.kind,
    reason: view.reason || null,
    receipt: extra.receipt || null,
    idempotent: Boolean(extra.idempotent),
    ...extra,
});

/**
 * Read the month. Does not write a record.
 * @returns {Promise<Object>}
 */
const inspect = async (input) => {
    const now = input.now ? new Date(input.now) : new Date();
    const trigger = input.trigger || "decrypt";

    if (!isEnabled()) {
        return { kind: "disabled", now, trigger, periodKey: periodKeyFromDate(now) };
    }
    if (EXEMPT_TRIGGERS.has(trigger)) {
        return { kind: "exempt-operation", now, trigger, periodKey: periodKeyFromDate(now), reason: trigger };
    }

    const context = await resolveContext(input);
    if (!context?.identity?.zelfName) {
        return { kind: "skip", now, trigger, periodKey: periodKeyFromDate(now) };
    }

    const periodKey = periodKeyFromDate(now);
    if (PAID_PLANS.has(context.plan)) {
        return {
            kind: "exempt-plan",
            now,
            trigger,
            periodKey,
            reason: context.plan,
            identity: context.identity,
            plan: context.plan,
            domainConfig: context.domainConfig,
            publicData: context.publicData,
        };
    }

    let record = mongoose.connection.readyState === 1 ? await findMonth(context.identity.zelfName, periodKey) : null;
    if (record?.status === "reserving") {
        record = await settleReservation(record);
    }

    const amount = describeAmount({
        tagName: context.identity.tagName,
        domainConfig: context.domainConfig,
        tokenPriceUsd: input.tokenPriceUsd,
        floorUsd: input.floorUsd,
    });
    const quote = {
        ...amount,
        periodKey,
        quoteId: record?.quoteId || input.quoteId || null,
    };

    const balance = await observedBalance(input, context.publicData);
    const account = await loadAccount(context.identity.zelfName);
    const spendable = balance.available ? spendableBalance(balance.onChain, account.spent || 0) : 0;
    const graceAllowed = await graceAllowedFor(context.identity.zelfName, now);

    const view = {
        kind: "ready",
        now,
        trigger,
        periodKey,
        identity: context.identity,
        plan: context.plan,
        domainConfig: context.domainConfig,
        publicData: context.publicData,
        record,
        quote,
        onChain: balance.onChain,
        balanceAvailable: balance.available,
        spendable,
        graceAllowed,
    };

    if (record?.status === "paid") {
        view.kind = "paid";
        return view;
    }
    if (record?.status === "grace") {
        view.kind = "block";
        view.quote = { ...quote, ...quoteFromRecord(record), periodKey };
        return view;
    }
    if (record?.status === "reserving") {
        throw accessError(409, "monthly_access_in_progress", "Monthly access is being recorded. Retry.");
    }
    if (spendable < amount.amountZns && !graceAllowed) {
        view.kind = "block";
        return view;
    }
    return view;
};

const storePaid = async (identity, quote, { trigger, now, settlement }) => {
    const set = {
        status: "paid",
        settlement,
        chargedAt: now,
        amountZns: quote.amountZns,
        amountUsd: quote.amountUsd,
        tokenPriceUsd: quote.tokenPriceUsd,
        premiumYearlyUsd: quote.premiumYearlyUsd,
        floorUsd: quote.floorUsd,
        quoteId: quote.quoteId,
        trigger,
        domain: identity.domain,
        tagName: identity.tagName,
    };
    return MonthlyAccess.findOneAndUpdate(
        { zelfName: identity.zelfName, periodKey: quote.periodKey },
        {
            $set: set,
            $setOnInsert: {
                zelfName: identity.zelfName,
                periodKey: quote.periodKey,
            },
        },
        { upsert: true, new: true },
    ).lean();
};

const commitReady = async (view) => {
    await ensureIndexes();
    const quote = {
        ...view.quote,
        quoteId: view.quote.quoteId || crypto.randomUUID(),
    };
    const base = {
        zelfName: view.identity.zelfName,
        domain: view.identity.domain,
        tagName: view.identity.tagName,
        periodKey: view.periodKey,
        status: "reserving",
        amountZns: quote.amountZns,
        amountUsd: quote.amountUsd,
        tokenPriceUsd: quote.tokenPriceUsd,
        premiumYearlyUsd: quote.premiumYearlyUsd,
        floorUsd: quote.floorUsd,
        trigger: view.trigger,
        quoteId: quote.quoteId,
    };

    let claimed;
    try {
        const created = await MonthlyAccess.create(base);
        claimed = created.toObject();
    } catch (error) {
        if (!isDuplicateKey(error)) throw error;
        let existing = null;
        for (let attempt = 0; attempt < 10 && !existing; attempt += 1) {
            existing = await findMonth(view.identity.zelfName, view.periodKey);
            if (!existing) await sleep(20);
        }
        if (existing?.status === "reserving") existing = await settleReservation(existing);
        if (existing?.status === "paid") {
            const spendable = await spendableAfter(view);
            return allowedResult(view, {
                status: "paid",
                idempotent: true,
                charged: false,
                receipt: presentRecord(existing, { charged: false, idempotent: true, spendableBalance: spendable }),
            });
        }
        if (existing?.status === "grace") {
            return blockedResult({ ...view, record: existing, quote: { ...quote, ...quoteFromRecord(existing) } });
        }
        throw accessError(409, "monthly_access_in_progress", "Monthly access is being recorded. Retry.");
    }

    const finishPaid = async (debit) => {
        const paid = await MonthlyAccess.findOneAndUpdate(
            { _id: claimed._id, status: "reserving" },
            { $set: { status: "paid", settlement: "zns", chargedAt: view.now, quoteId: quote.quoteId } },
            { new: true },
        ).lean();
        if (!paid) {
            const current = await MonthlyAccess.findById(claimed._id).lean();
            if (current?.status === "paid") {
                const spendable = await spendableAfter(view);
                return allowedResult(view, {
                    status: "paid",
                    idempotent: true,
                    charged: false,
                    receipt: presentRecord(current, { charged: false, idempotent: true, spendableBalance: spendable }),
                });
            }
            throw accessError(409, "monthly_access_in_progress", "Monthly access is being recorded. Retry.");
        }
        const account = await loadAccount(view.identity.zelfName);
        const spendable = spendableBalance(view.onChain, account.spent || 0);
        await writeAudit({
            zelfName: view.identity.zelfName,
            periodKey: view.periodKey,
            event: "paid",
            amountZns: quote.amountZns,
            amountUsd: quote.amountUsd,
            tokenPriceUsd: quote.tokenPriceUsd,
            trigger: view.trigger,
            quoteId: quote.quoteId,
            at: view.now,
        });
        return allowedResult(view, {
            status: "paid",
            charged: !debit.idempotent,
            idempotent: Boolean(debit.idempotent),
            receipt: presentRecord(paid, {
                charged: !debit.idempotent,
                idempotent: Boolean(debit.idempotent),
                spendableBalance: spendable,
            }),
        });
    };

    if (view.spendable >= quote.amountZns) {
        try {
            const debit = await debitOnce({
                identity: view.identity,
                cost: quote.amountZns,
                periodKey: view.periodKey,
                quoteId: quote.quoteId,
                onChain: view.onChain,
                now: view.now,
            });
            return finishPaid(debit);
        } catch (error) {
            if (error?.status !== 402 && error?.clientCode !== "monthly_access_payment_required") {
                await MonthlyAccess.deleteOne({ _id: claimed._id, status: "reserving" });
                throw error;
            }
        }
    }

    if (view.graceAllowed) {
        const grace = await MonthlyAccess.findOneAndUpdate(
            { _id: claimed._id, status: "reserving" },
            { $set: { status: "grace", graceAt: view.now } },
            { new: true },
        ).lean();
        if (!grace) {
            const current = await MonthlyAccess.findById(claimed._id).lean();
            if (current?.status === "paid") {
                const spendable = await spendableAfter(view);
                return allowedResult(view, {
                    status: "paid",
                    idempotent: true,
                    receipt: presentRecord(current, { charged: false, idempotent: true, spendableBalance: spendable }),
                });
            }
            if (current?.status === "grace") {
                return blockedResult({ ...view, record: current, quote });
            }
            throw accessError(409, "monthly_access_in_progress", "Monthly access is being recorded. Retry.");
        }
        await writeAudit({
            zelfName: view.identity.zelfName,
            periodKey: view.periodKey,
            event: "grace_opened",
            amountZns: quote.amountZns,
            amountUsd: quote.amountUsd,
            tokenPriceUsd: quote.tokenPriceUsd,
            trigger: view.trigger,
            quoteId: quote.quoteId,
            at: view.now,
        });
        return allowedResult(view, {
            status: "grace",
            charged: false,
            receipt: presentRecord(grace, {
                charged: false,
                spendableBalance: view.spendable,
                znsNeeded: paymentOptions(quote, view.spendable).znsNeeded,
            }),
        });
    }

    await MonthlyAccess.deleteOne({ _id: claimed._id, status: "reserving" });
    return blockedResult({ ...view, quote, record: null });
};

/**
 * Apply one triggering or exempt operation. Writes at most one grace or one debit.
 * @param {Object} input
 */
const applyOperation = async (input = {}) => {
    const view = await inspect(input);
    if (view.kind === "disabled" || view.kind === "skip" || view.kind === "exempt-operation") {
        return allowedResult(view, { status: view.kind === "disabled" ? "disabled" : "exempt", reason: view.reason || null });
    }
    if (view.kind === "exempt-plan") {
        await writeAudit({
            zelfName: view.identity.zelfName,
            periodKey: view.periodKey,
            event: "exempt",
            trigger: view.trigger,
            at: view.now,
        });
        return allowedResult(view, {
            status: "exempt",
            reason: view.reason,
            receipt: {
                enabled: true,
                zelfName: view.identity.zelfName,
                periodKey: view.periodKey,
                status: "exempt",
                reason: view.reason,
                plan: view.plan,
                openAllowed: true,
            },
        });
    }
    if (view.kind === "paid") {
        const account = await loadAccount(view.identity.zelfName);
        const spendable = spendableBalance(view.onChain, account.spent || 0);
        return allowedResult(view, {
            status: "paid",
            idempotent: true,
            receipt: presentRecord(view.record, { charged: false, idempotent: true, spendableBalance: spendable }),
        });
    }
    if (view.kind === "block") return blockedResult(view);
    return commitReady(view);
};

const prepareTrigger = async (input) => {
    const view = await inspect(input);
    if (view.kind === "block") {
        const blocked = await blockedResult(view);
        return { blocked: true, body: blocked.body, view };
    }
    return { blocked: false, view, input };
};

const nameFromCtx = (ctx, trigger) => {
    const auth = ctx.state?.user || {};
    const body = ctx.request?.body || {};
    const domain = body.domain || ctx.state?.extractedDomain || auth.domain || "zelf";
    if (trigger === "retrieve") return normalizeZelfName(auth.tagName, auth.domain || domain);
    if (trigger === "zns-decrypt") return normalizeZelfName(body.zelfName, domain);
    if (trigger === "wallet-decrypt") return normalizeZelfName(body.zelfName || auth.tagName, domain);
    const raw = body.tagName || body.zelfName || auth.tagName;
    return normalizeZelfName(raw, domain);
};

const inputFromCtx = (ctx, trigger) => {
    const named = nameFromCtx(ctx, trigger);
    return {
        trigger,
        authUser: ctx.state?.user,
        zelfName: named.zelfName,
        tagName: named.tagName,
        domain: named.domain,
    };
};

/**
 * Run a triggering controller: block before the open when the month is already
 * unpaid, and record grace or the debit only after the open succeeds.
 * When the fee is off, the response stays `{ data }`.
 */
const runMonthlyAccess = async (ctx, trigger, producer) => {
    const prepared = await prepareTrigger(inputFromCtx(ctx, trigger));
    if (prepared.blocked) {
        ctx.status = 402;
        ctx.body = prepared.body;
        return;
    }

    const data = await producer();
    const view = prepared.view;
    if (!view || view.kind === "disabled" || view.kind === "exempt-operation") {
        ctx.body = { data };
        return;
    }

    if (view.kind === "skip") {
        const revealed = data?.publicData?.zelfName || data?.publicData?.tagName || data?.zelfName;
        if (!revealed) {
            ctx.body = { data };
            return;
        }
        const settled = await applyOperation({
            trigger,
            authUser: ctx.state?.user,
            zelfName: revealed,
            publicData: data?.publicData,
            domain: ctx.request?.body?.domain || ctx.state?.user?.domain,
        });
        if (settled.blocked) {
            ctx.status = 402;
            ctx.body = settled.body;
            return;
        }
        ctx.body = { data };
        if (settled.receipt) ctx.body.monthlyAccess = settled.receipt;
        return;
    }

    let result;
    if (view.kind === "exempt-plan" || view.kind === "paid" || view.kind === "ready") {
        const named = nameFromCtx(ctx, trigger);
        const revealed = data?.publicData?.zelfName || data?.publicData?.tagName || data?.zelfName;
        result = await applyOperation({
            ...inputFromCtx(ctx, trigger),
            zelfName: named.zelfName || revealed,
            publicData: data?.publicData || view.publicData,
            domainConfig: view.domainConfig,
            plan: view.plan,
            skipSubscriptionLookup: true,
        });
    } else {
        ctx.body = { data };
        return;
    }

    if (result.blocked) {
        ctx.status = 402;
        ctx.body = result.body;
        return;
    }

    ctx.body = { data };
    if (isEnabled() && result.receipt) ctx.body.monthlyAccess = result.receipt;
};

const historyFor = async (zelfName) => {
    if (mongoose.connection.readyState !== 1) return [];
    const rows = await MonthlyAccess.find({ zelfName, status: { $in: ["grace", "paid"] } })
        .sort({ periodKey: -1 })
        .limit(12)
        .lean();
    return rows.map((row) => presentRecord(row));
};

const statusPayload = async (input) => {
    const now = input.now ? new Date(input.now) : new Date();
    const periodKey = periodKeyFromDate(now);
    if (!isEnabled()) {
        return {
            enabled: false,
            status: "disabled",
            openAllowed: true,
            periodKey,
            zelfName: input.zelfName || null,
        };
    }

    const context = await resolveContext(input);
    if (!context?.identity?.zelfName) {
        throw accessError(401, "ERR_ZELF_IDENTITY_REQUIRED", "Authenticated Zelf identity is required");
    }

    if (PAID_PLANS.has(context.plan)) {
        return {
            enabled: true,
            zelfName: context.identity.zelfName,
            plan: context.plan,
            periodKey,
            status: "exempt",
            reason: context.plan,
            openAllowed: true,
            graceAvailable: false,
            history: input.includeHistory === false ? undefined : await historyFor(context.identity.zelfName),
        };
    }

    const amount = describeAmount({
        tagName: context.identity.tagName,
        domainConfig: context.domainConfig,
        tokenPriceUsd: input.tokenPriceUsd,
        floorUsd: input.floorUsd,
    });
    const record = mongoose.connection.readyState === 1 ? await findMonth(context.identity.zelfName, periodKey) : null;
    const balance = await observedBalance(input, context.publicData);
    const account = await loadAccount(context.identity.zelfName);
    const spendable = balance.available ? spendableBalance(balance.onChain, account.spent || 0) : null;
    const graceAllowed = await graceAllowedFor(context.identity.zelfName, now);
    const stable = record?.status === "reserving" ? await settleReservation(record) : record;
    const status = !stable ? "none" : stable.status === "reserving" ? "pending" : stable.status;
    const quote = { ...amount, periodKey, quoteId: stable?.quoteId || null };
    const spendableNumber = spendable == null ? 0 : spendable;
    const short = spendableNumber < amount.amountZns;

    let openAllowed = true;
    if (status === "grace" || status === "pending") openAllowed = false;
    if (status === "none" && short && !graceAllowed) openAllowed = false;

    const needsOptions = status === "grace" || status === "none" || status === "pending";
    const optionBlock = needsOptions ? paymentOptions(quote, spendableNumber) : null;

    return {
        enabled: true,
        zelfName: context.identity.zelfName,
        plan: context.plan,
        periodKey,
        status,
        openAllowed,
        graceAvailable: status === "none" && graceAllowed,
        spendableBalance: spendable,
        onChainBalance: balance.available ? balance.onChain : null,
        tokensSpent: account.spent || 0,
        amountZns: amount.amountZns,
        amountUsd: amount.amountUsd,
        tokenPriceUsd: amount.tokenPriceUsd,
        floorUsd: amount.floorUsd,
        premiumYearlyUsd: amount.premiumYearlyUsd,
        znsNeeded: optionBlock ? optionBlock.znsNeeded : 0,
        options: optionBlock ? optionBlock.options : undefined,
        record: presentRecord(stable && stable.status !== "reserving" ? stable : null),
        history: input.includeHistory === false ? undefined : await historyFor(context.identity.zelfName),
    };
};

const getMonthlyAccessStatus = (input) => statusPayload(input);

const quoteMonthlyAccess = async (input) => {
    const now = input.now ? new Date(input.now) : new Date();
    if (!isEnabled()) {
        throw accessError(409, "monthly_access_disabled", "Monthly access is not enabled");
    }
    const context = await resolveContext(input);
    if (!context?.identity?.zelfName) {
        throw accessError(401, "ERR_ZELF_IDENTITY_REQUIRED", "Authenticated Zelf identity is required");
    }
    if (PAID_PLANS.has(context.plan)) {
        return {
            enabled: true,
            zelfName: context.identity.zelfName,
            periodKey: periodKeyFromDate(now),
            status: "exempt",
            reason: context.plan,
            openAllowed: true,
            signedDataPrice: null,
        };
    }

    const amount = describeAmount({
        tagName: context.identity.tagName,
        domainConfig: context.domainConfig,
        tokenPriceUsd: input.tokenPriceUsd,
        floorUsd: input.floorUsd,
    });
    const payload = quotePayload(context.identity, amount, now);
    await writeAudit({
        zelfName: context.identity.zelfName,
        periodKey: payload.periodKey,
        event: "quoted",
        amountZns: payload.amountZns,
        amountUsd: payload.amountUsd,
        tokenPriceUsd: payload.tokenPriceUsd,
        trigger: "quote",
        quoteId: payload.quoteId,
        at: now,
    });

    const balance = await observedBalance(input, context.publicData);
    const account = await loadAccount(context.identity.zelfName);
    const spendable = balance.available ? spendableBalance(balance.onChain, account.spent || 0) : null;

    return {
        ...payload,
        signedDataPrice: signQuote(payload),
        spendableBalance: spendable,
        ...paymentOptions(payload, spendable || 0),
    };
};

const verifyQuoteToken = (token) => {
    let decoded;
    try {
        decoded = jwt.verify(token, quoteSecret());
    } catch (_error) {
        throw accessError(401, "monthly_access_quote_invalid", "Monthly access quote is not valid");
    }
    if (!decoded || decoded.typ !== QUOTE_TYPE || !decoded.zelfName || !decoded.periodKey) {
        throw accessError(401, "monthly_access_quote_invalid", "Monthly access quote is not valid");
    }
    return decoded;
};

const confirmMonthlyAccess = async (input) => {
    if (!isEnabled()) {
        throw accessError(409, "monthly_access_disabled", "Monthly access is not enabled");
    }
    const method = input.method === "card" ? "card" : "zns";
    const decoded = verifyQuoteToken(input.token);
    const now = input.now ? new Date(input.now) : new Date();
    const currentPeriod = periodKeyFromDate(now);
    const owner = normalizeZelfName(input.authUser?.tagName, input.authUser?.domain || "zelf");

    if (!owner.zelfName || owner.zelfName !== String(decoded.zelfName || "").toLowerCase()) {
        throw accessError(403, "ERR_SESSION_OWNER_MISMATCH", "Session is not the owner of this Zelf ID");
    }

    if (Number(decoded.ttl) < moment.utc(now).unix() || decoded.periodKey !== currentPeriod) {
        throw accessError(409, "monthly_access_quote_expired", "Monthly access quote has expired. Request a new quote.");
    }

    const context = await resolveContext({ ...input, zelfName: decoded.zelfName });
    if (!context?.identity?.zelfName || context.identity.zelfName !== decoded.zelfName) {
        throw accessError(403, "ERR_SESSION_OWNER_MISMATCH", "Session is not the owner of this Zelf ID");
    }

    if (PAID_PLANS.has(context.plan)) {
        return {
            enabled: true,
            zelfName: context.identity.zelfName,
            periodKey: decoded.periodKey,
            status: "exempt",
            reason: context.plan,
            idempotent: true,
            charged: false,
        };
    }

    if (method === "card") {
        throw accessError(409, "monthly_access_card_unavailable", "Card payment for this month is not available yet", {
            periodKey: decoded.periodKey,
            amountUsd: decoded.amountUsd,
            amountZns: decoded.amountZns,
            quoteId: decoded.quoteId,
        });
    }

    const existing = await findMonth(context.identity.zelfName, decoded.periodKey);
    if (existing?.status === "paid") {
        await writeAudit({
            zelfName: context.identity.zelfName,
            periodKey: decoded.periodKey,
            event: "idempotent_replay",
            amountZns: existing.amountZns,
            amountUsd: existing.amountUsd,
            tokenPriceUsd: existing.tokenPriceUsd,
            trigger: "confirm",
            quoteId: existing.quoteId,
            at: now,
        });
        const account = await loadAccount(context.identity.zelfName);
        const balance = await observedBalance(input, context.publicData);
        return {
            ...presentRecord(existing, {
                charged: false,
                idempotent: true,
                spendableBalance: balance.available ? spendableBalance(balance.onChain, account.spent || 0) : null,
            }),
            idempotent: true,
            charged: false,
        };
    }

    const balance = await observedBalance(input, context.publicData);
    if (!balance.available) {
        throw accessError(503, "ERR_TOKEN_BALANCE_UNAVAILABLE", "Token balance is unavailable");
    }
    const account = await loadAccount(context.identity.zelfName);
    const spendable = spendableBalance(balance.onChain, account.spent || 0);
    const quote = {
        periodKey: decoded.periodKey,
        premiumYearlyUsd: decoded.premiumYearlyUsd,
        amountUsd: decoded.amountUsd,
        tokenPriceUsd: decoded.tokenPriceUsd,
        floorUsd: decoded.floorUsd,
        amountZns: Number(decoded.amountZns),
        quoteId: decoded.quoteId,
    };

    if (spendable < quote.amountZns) {
        const body = paymentRequiredBody({
            quote,
            spendable,
            periodKey: quote.periodKey,
            signedDataPrice: input.token,
        });
        throw accessError(402, "monthly_access_payment_required", body.message, body);
    }

    await ensureIndexes();
    const debit = await debitOnce({
        identity: context.identity,
        cost: quote.amountZns,
        periodKey: quote.periodKey,
        quoteId: quote.quoteId,
        onChain: balance.onChain,
        now,
    });
    const paid = await storePaid(context.identity, quote, { trigger: input.trigger || "confirm", now, settlement: "zns" });
    await writeAudit({
        zelfName: context.identity.zelfName,
        periodKey: quote.periodKey,
        event: debit.idempotent ? "idempotent_replay" : "paid",
        amountZns: quote.amountZns,
        amountUsd: quote.amountUsd,
        tokenPriceUsd: quote.tokenPriceUsd,
        trigger: "confirm",
        quoteId: quote.quoteId,
        at: now,
    });

    const after = await loadAccount(context.identity.zelfName);
    return {
        ...presentRecord(paid, {
            charged: !debit.idempotent,
            idempotent: Boolean(debit.idempotent),
            spendableBalance: spendableBalance(balance.onChain, after.spent || 0),
        }),
        charged: !debit.idempotent,
        idempotent: Boolean(debit.idempotent),
    };
};

const operationClass = (trigger) => {
    if (EXEMPT_TRIGGERS.has(trigger)) return "exempt";
    if (TRIGGER_TRIGGERS.has(trigger)) return "trigger";
    return "unknown";
};

module.exports = {
    EXEMPT_TRIGGERS,
    TRIGGER_TRIGGERS,
    applyOperation,
    confirmMonthlyAccess,
    describeAmount,
    formatAmountUsd,
    getMonthlyAccessStatus,
    isEnabled,
    ensureIndexes,
    operationClass,
    paymentRequiredBody,
    periodKeyFromDate,
    premiumYearlyUsdFor,
    prepareTrigger,
    previousPeriodKey,
    quoteMonthlyAccess,
    runMonthlyAccess,
    verifyQuoteToken,
};
