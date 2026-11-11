const config = require("../../../Core/config");
const { string, stringEnum, validate } = require("../../../Core/JoiUtils");
const { extractDomainAndName, validateDomainAndName } = require("../../Tags/middlewares/tags.middleware");
const SessionModule = require("../../Session/modules/session.module");

const NETWORK_ALIASES = Object.freeze({
    arb: "arbitrum",
    arbitrum: "arbitrum",
    avax: "avalanche",
    avalanche: "avalanche",
    eth: "ethereum",
    ethereum: "ethereum",
    matic: "polygon",
    op: "optimism",
    optimism: "optimism",
    polygon: "polygon",
});

const SUPPORTED_ALCHEMY_NETWORKS = Object.freeze(["ethereum", "polygon", "arbitrum", "optimism", "avalanche"]);
const SUPPORTED_TOKEN_MODES = Object.freeze(["all", "curated"]);
const TX_HASH_RE = /^0x[a-fA-F0-9]{64}$/;

const schemas = {
    balances: {
        domain: string().required(),
        network: string(),
        networks: string(),
        tagName: string().required(),
        tokenMode: stringEnum(SUPPORTED_TOKEN_MODES),
    },
    transaction: {
        domain: string().required(),
        network: string().required(),
        tagName: string().required(),
        transactionHash: string().required(),
    },
    transactions: {
        domain: string().required(),
        maxCount: string(),
        network: string().required(),
        pageKey: string(),
        tagName: string().required(),
    },
};

const normalizeNetwork = (value) => {
    if (!value) return null;

    const normalized = NETWORK_ALIASES[String(value).trim().toLowerCase()];

    return normalized || null;
};

const parseNetworks = ({ network, networks }) => {
    const input = [];

    if (Array.isArray(networks)) {
        input.push(...networks);
    } else if (networks !== undefined && networks !== null && networks !== "") {
        input.push(networks);
    }

    if (network !== undefined && network !== null && network !== "") {
        input.push(network);
    }

    const rawValues = input
        .flatMap((value) => String(value).split(","))
        .map((value) => String(value).trim())
        .filter(Boolean);

    const normalized = rawValues.map((value) => normalizeNetwork(value)).filter(Boolean);

    return {
        invalid: rawValues.filter((value) => !normalizeNetwork(value)),
        networks: [...new Set(normalized)],
    };
};

const parseMaxCount = (value) => {
    if (value === undefined || value === null || value === "") return 25;

    const maxCount = Number(value);

    if (!Number.isInteger(maxCount) || maxCount < 1 || maxCount > 100) {
        return null;
    }

    return maxCount;
};

const ensureTagOwnership = async (ctx, tagName, domain) => {
    const verifiedTagName = await SessionModule.readVerifiedTagName(ctx.state.user);

    if (!verifiedTagName) {
        ctx.status = 403;
        ctx.body = { message: "owned tag session required", code: "Forbidden" };
        return false;
    }

    const requestedTagName = `${tagName}.${domain}`.toLowerCase();

    if (verifiedTagName !== requestedTagName) {
        ctx.status = 403;
        ctx.body = { message: "tag not owned", code: "Forbidden" };
        return false;
    }

    return true;
};

const validateTagRequest = async ({ ctx, payload }) => {
    const { domain: extractedDomain, name } = extractDomainAndName(payload.tagName, payload.domain);

    const domainValidation = await validateDomainAndName(extractedDomain, name);

    if (!domainValidation.valid) {
        if (domainValidation.status === 400) {
            ctx.status = 400;
            ctx.body = {
                message: domainValidation.code || domainValidation.error,
                code: domainValidation.code || domainValidation.error,
            };
            return null;
        }
        ctx.status = 409;
        ctx.body = { validationError: domainValidation.error };
        return null;
    }

    const owned = await ensureTagOwnership(ctx, name, extractedDomain);

    if (!owned) return null;

    return {
        domain: extractedDomain,
        fullTagName: `${name}.${extractedDomain}`,
        tagName: name,
    };
};

const configValidation = (ctx) => {
    if (!config.alchemy?.apiKey) {
        ctx.status = 501;
        ctx.body = { error: "service_unavailable" };
        return false;
    }

    return true;
};

const hasCuratedTokens = (network) => {
    const curatedTokens = config.alchemy?.curatedTokens?.[network];

    return Boolean(curatedTokens && Object.keys(curatedTokens).length > 0);
};

const getBalancesValidation = async (ctx, next) => {
    const payload = ctx.request.query || {};

    const valid = validate(schemas.balances, payload);

    if (valid.error) {
        ctx.status = 400;
        ctx.body = { validationError: valid.error.message };
        return;
    }

    const tagRequest = await validateTagRequest({ ctx, payload });

    if (!tagRequest) return;

    const { networks, invalid } = parseNetworks(payload);
    const tokenMode = payload.tokenMode ? String(payload.tokenMode).trim().toLowerCase() : "all";

    if (invalid.length > 0) {
        ctx.status = 409;
        ctx.body = { validationError: "unsupported network" };
        return;
    }

    if (networks.length === 0) {
        ctx.status = 400;
        ctx.body = { validationError: "missing network or networks" };
        return;
    }

    if (tokenMode === "curated") {
        const unsupportedCuratedNetwork = networks.find((network) => !hasCuratedTokens(network));

        if (unsupportedCuratedNetwork) {
            ctx.status = 409;
            ctx.body = { validationError: `curated token mode not configured for ${unsupportedCuratedNetwork}` };
            return;
        }
    }

    if (!configValidation(ctx)) return;

    ctx.state.alchemyRequest = {
        ...tagRequest,
        networks,
        tokenMode,
    };

    await next();
};

const getTransactionsValidation = async (ctx, next) => {
    const payload = ctx.request.query || {};
    const valid = validate(schemas.transactions, payload);

    if (valid.error) {
        ctx.status = 400;
        ctx.body = { validationError: valid.error.message };
        return;
    }

    const tagRequest = await validateTagRequest({ ctx, payload });

    if (!tagRequest) return;

    const network = normalizeNetwork(payload.network);

    if (!network || !SUPPORTED_ALCHEMY_NETWORKS.includes(network)) {
        ctx.status = 409;
        ctx.body = { validationError: "unsupported network" };
        return;
    }

    const maxCount = parseMaxCount(payload.maxCount);

    if (maxCount === null) {
        ctx.status = 400;
        ctx.body = { validationError: "maxCount must be an integer between 1 and 100" };
        return;
    }

    if (!configValidation(ctx)) return;

    ctx.state.alchemyRequest = {
        ...tagRequest,
        maxCount,
        network,
        pageKey: payload.pageKey ? String(payload.pageKey) : undefined,
    };

    await next();
};

const getTransactionValidation = async (ctx, next) => {
    const payload = ctx.request.query || {};
    const valid = validate(schemas.transaction, payload);

    if (valid.error) {
        ctx.status = 400;
        ctx.body = { validationError: valid.error.message };
        return;
    }

    const tagRequest = await validateTagRequest({ ctx, payload });

    if (!tagRequest) return;

    const network = normalizeNetwork(payload.network);

    if (!network || !SUPPORTED_ALCHEMY_NETWORKS.includes(network)) {
        ctx.status = 409;
        ctx.body = { validationError: "unsupported network" };
        return;
    }

    if (!TX_HASH_RE.test(String(payload.transactionHash).trim())) {
        ctx.status = 400;
        ctx.body = { validationError: "invalid transactionHash" };
        return;
    }

    if (!configValidation(ctx)) return;

    ctx.state.alchemyRequest = {
        ...tagRequest,
        network,
        transactionHash: String(payload.transactionHash).trim(),
    };

    await next();
};

module.exports = {
    SUPPORTED_ALCHEMY_NETWORKS,
    getBalancesValidation,
    getTransactionValidation,
    getTransactionsValidation,
    normalizeNetwork,
};
