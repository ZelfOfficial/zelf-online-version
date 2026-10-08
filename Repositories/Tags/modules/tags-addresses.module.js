/**
 * Pinata metadata: 9 custom keyvalues, 250 chars per key/value, one-key filter.
 *
 * New writes keep addresses as standalone searchable keys. Overflow goes on
 * continuation pins that share the same QR and point back via `_tagName` /
 * `__tagName`. Old packed `addresses*` blobs stay readable via merge only.
 */

const PINATA_KEYVALUE_MAX_COUNT = 9;
const PINATA_KEYVALUE_MAX_LENGTH = 250;
const ADDRESS_CHUNK_KEYS = ["addresses", "addresses2", "addresses3"];
const MAX_ADDRESS_CHUNKS = ADDRESS_CHUNK_KEYS.length;

const CONTINUATION_LINK_KEY = "_tagName";
const CONTINUATION_LINK_KEY_2 = "__tagName";

const TOP_LEVEL_ADDRESS_FIELDS = ["ethAddress", "solanaAddress"];

const ADDRESS_FIELDS_ORDER = ["btc", "arweave", "sui", "xlm", "dot", "ksm", "ton", "aptos"];

const SHORT_STORAGE_TO_APP = {
    btc: "btcAddress",
    arweave: "arweaveAddress",
    sui: "suiAddress",
    xlm: "xlmAddress",
    dot: "dotAddress",
    ksm: "ksmAddress",
    ton: "tonAddress",
    aptos: "aptosAddress",
};

const APP_TO_SHORT_STORAGE = {
    btcAddress: "btc",
    arweaveAddress: "arweave",
    suiAddress: "sui",
    xlmAddress: "xlm",
    dotAddress: "dot",
    ksmAddress: "ksm",
    tonAddress: "ton",
    aptosAddress: "aptos",
};

const APP_ADDRESS_FIELDS = [
    ...TOP_LEVEL_ADDRESS_FIELDS,
    "btcAddress",
    "arweaveAddress",
    "suiAddress",
    "xlmAddress",
    "dotAddress",
    "ksmAddress",
    "tonAddress",
    "aptosAddress",
];

const SEARCHABLE_ADDRESS_FIELDS = [
    "ethAddress",
    "solanaAddress",
    "btcAddress",
    "suiAddress",
    "xlmAddress",
    "tonAddress",
    "arweaveAddress",
    "aptosAddress",
    "dotAddress",
    "ksmAddress",
];

const STANDALONE_ADDRESS_FIELDS = TOP_LEVEL_ADDRESS_FIELDS;
const PACKED_ONLY_ADDRESS_FIELDS = SEARCHABLE_ADDRESS_FIELDS.filter((field) => !STANDALONE_ADDRESS_FIELDS.includes(field));
const ADDRESS_KEYVALUE_CHUNKS = ADDRESS_CHUNK_KEYS;
const PRIMARY_RESERVED_KEYS = ["zelfName", "tagName", "domain", "extraParams"];

/** Lease / payment / re-pin fields that belong in the `extraParams` JSON. */
const EXTRA_PARAMS_ALLOWED_KEYS = [
    "hasPassword",
    "origin",
    "registeredAt",
    "renewedAt",
    "expiresAt",
    "price",
    "duration",
    "type",
    "plan",
    "v",
    "st",
    "eventID",
    "eventPrice",
];

const EXTRA_PARAMS_SECURITY_TYPES = new Set(["pin", "password", "securePassword"]);

/** Drop these first when the allow-listed JSON is still over 250 chars. */
const EXTRA_PARAMS_OPTIONAL_KEYS = ["eventID", "eventPrice", "renewedAt", "price", "duration"];

const ADDRESS_KEY_ALIASES = {
    eth: "ethAddress",
    ethereum: "ethAddress",
    sol: "solanaAddress",
    solana: "solanaAddress",
    bitcoin: "btcAddress",
    stellar: "xlmAddress",
    polkadot: "dotAddress",
    kusama: "ksmAddress",
    ...SHORT_STORAGE_TO_APP,
};

const _isUsableString = (value) => typeof value === "string" && value.trim() !== "";

const _readAddressFromSource = (source, chunkKey) => {
    const appKey = SHORT_STORAGE_TO_APP[chunkKey];

    if (_isUsableString(source[appKey])) return source[appKey].trim();
    if (_isUsableString(source[chunkKey])) return source[chunkKey].trim();

    return null;
};

const buildAddressBundle = (source) => {
    if (!source || typeof source !== "object") return {};

    const bundle = {};

    for (const chunkKey of ADDRESS_FIELDS_ORDER) {
        const value = _readAddressFromSource(source, chunkKey);
        if (value !== null) bundle[chunkKey] = value;
    }

    return bundle;
};

const buildTopLevelAddressKeyvalues = (source) => {
    if (!source || typeof source !== "object") return {};

    const out = {};

    for (const appKey of TOP_LEVEL_ADDRESS_FIELDS) {
        if (_isUsableString(source[appKey])) out[appKey] = source[appKey].trim();
    }

    return out;
};

const serializeAddressBundleToPinataKeyvalues = (bundle) => {
    if (!bundle || typeof bundle !== "object") return {};

    const entries = ADDRESS_FIELDS_ORDER.filter((key) => _isUsableString(bundle[key])).map((key) => [key, bundle[key]]);

    if (!entries.length) return {};

    const chunks = [];
    let current = {};

    const flushCurrent = () => {
        if (Object.keys(current).length) {
            chunks.push(current);
            current = {};
        }
    };

    for (const [key, value] of entries) {
        const probe = { ...current, [key]: value };
        const probeLength = JSON.stringify(probe).length;

        if (probeLength <= PINATA_KEYVALUE_MAX_LENGTH) {
            current = probe;
            continue;
        }

        const singleLength = JSON.stringify({ [key]: value }).length;

        if (singleLength > PINATA_KEYVALUE_MAX_LENGTH) {
            const error = new Error(`tags_addresses_field_too_long:${key}:${singleLength}`);
            error.status = 400;
            throw error;
        }

        flushCurrent();
        current = { [key]: value };
    }

    flushCurrent();

    if (chunks.length > MAX_ADDRESS_CHUNKS) {
        const error = new Error(`tags_addresses_too_many_chunks:${chunks.length}`);
        error.status = 400;
        throw error;
    }

    const result = {};

    chunks.forEach((chunk, index) => {
        result[ADDRESS_CHUNK_KEYS[index]] = JSON.stringify(chunk);
    });

    return result;
};

/**
 * Read-only compat for old packed pins. New writes must use
 * {@link buildSearchablePinPages} instead.
 */
const buildAddressKeyvalues = (source) => ({
    ...buildTopLevelAddressKeyvalues(source),
    ...serializeAddressBundleToPinataKeyvalues(buildAddressBundle(source)),
});

const _parseChunk = (raw) => {
    if (!raw) return null;
    if (typeof raw === "object") return raw;
    if (typeof raw !== "string") return null;

    try {
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === "object" ? parsed : null;
    } catch (_error) {
        return null;
    }
};

const mergeAddressKeyvaluesIntoPublicData = (publicData) => {
    if (!publicData || typeof publicData !== "object") return publicData;

    const merged = {};

    for (const chunkKey of ADDRESS_CHUNK_KEYS) {
        const chunk = _parseChunk(publicData[chunkKey]);
        if (chunk) Object.assign(merged, chunk);
        if (chunkKey in publicData) delete publicData[chunkKey];
    }

    for (const [shortKey, appKey] of Object.entries(SHORT_STORAGE_TO_APP)) {
        if (shortKey in merged) {
            if (merged[appKey] === undefined) merged[appKey] = merged[shortKey];
            delete merged[shortKey];
        }
    }

    Object.assign(publicData, merged);

    return publicData;
};

/**
 * Same as mergeAddressKeyvaluesIntoPublicData but keeps the packed chunks and never
 * overwrites an explicit field. Arweave records only carry TON/DOT/KSM inside
 * `addresses2`, so without this their tagObject had no `tonAddress` (#540).
 */
const expandPackedAddresses = (publicData) => {
    if (!publicData || typeof publicData !== "object" || !isPackedAddressPublicData(publicData)) return publicData;

    const unpacked = mergeAddressKeyvaluesIntoPublicData(
        Object.fromEntries(ADDRESS_CHUNK_KEYS.filter((chunkKey) => chunkKey in publicData).map((chunkKey) => [chunkKey, publicData[chunkKey]]))
    );

    for (const [appKey, value] of Object.entries(unpacked)) {
        if (!_isUsableString(publicData[appKey]) && _isUsableString(value)) publicData[appKey] = value.trim();
    }

    return publicData;
};

const getAllChainAddresses = (publicData) => {
    if (!publicData || typeof publicData !== "object") return {};

    const out = {};

    for (const appKey of APP_ADDRESS_FIELDS) {
        if (_isUsableString(publicData[appKey])) {
            out[appKey] = publicData[appKey];
            continue;
        }

        const shortKey = APP_TO_SHORT_STORAGE[appKey];

        if (shortKey && _isUsableString(publicData[shortKey])) {
            out[appKey] = publicData[shortKey];
        }
    }

    return out;
};

const resolveAddressKey = (key) => ADDRESS_KEY_ALIASES[String(key || "").toLowerCase()] || key;

const normalizeAddressMap = (source = {}) => {
    const addresses = {};

    if (!source || typeof source !== "object") return addresses;

    for (const field of SEARCHABLE_ADDRESS_FIELDS) {
        const value = source[field];
        if (_isUsableString(value)) addresses[field] = value.trim();
    }

    return addresses;
};

const isPackedAddressPublicData = (source = {}) => ADDRESS_CHUNK_KEYS.some((chunkKey) => Boolean(source?.[chunkKey]));

const isContinuationPublicData = (source = {}) => Boolean(source?.[CONTINUATION_LINK_KEY] || source?.[CONTINUATION_LINK_KEY_2]);

const getContinuationCanonicalName = (source = {}) => source?.[CONTINUATION_LINK_KEY] || source?.[CONTINUATION_LINK_KEY_2] || null;

const continuationPinName = (tagName, pageIndex) => {
    const prefix = pageIndex === 0 ? "_" : "__";
    return `${prefix}${tagName}`;
};

const resolveEncryptVersion = (source = {}) => {
    const raw = source.v ?? source.zelfEncryptVersion ?? source.encryptVersion;
    const parsed = Number.parseInt(String(raw ?? ""), 10);
    return parsed === 4 ? 4 : 3;
};

const pickAllowedExtraParams = (extraParams = {}) => {
    const picked = {};

    for (const key of EXTRA_PARAMS_ALLOWED_KEYS) {
        const value = extraParams[key];
        if (value === undefined || value === null || value === "") continue;
        picked[key] = value;
    }

    if (picked.st != null && !EXTRA_PARAMS_SECURITY_TYPES.has(String(picked.st))) {
        delete picked.st;
    }

    return picked;
};

/**
 * Keep `extraParams` to the known lease schema and under Pinata's 250-char cap.
 * Addresses, referral, session JWTs, and other publicData do not belong here.
 * @param {Object} extraParams
 * @returns {Object}
 */
const cleanExtraParamsForPinata = (extraParams) => {
    if (!extraParams || typeof extraParams !== "object") return extraParams;

    const cleaned = pickAllowedExtraParams(extraParams);
    const checkLength = (obj) => JSON.stringify(obj).length;

    if (checkLength(cleaned) <= PINATA_KEYVALUE_MAX_LENGTH) return cleaned;

    for (const key of EXTRA_PARAMS_OPTIONAL_KEYS) {
        if (!(key in cleaned)) continue;
        delete cleaned[key];
        if (checkLength(cleaned) <= PINATA_KEYVALUE_MAX_LENGTH) return cleaned;
    }

    return cleaned;
};

const serializePinataValue = (value) => (typeof value === "object" ? JSON.stringify(value) : String(value));

const stampExtraParamsVersion = (extraParams = {}, version) => {
    const parsed =
        typeof extraParams === "string"
            ? (() => {
                  try {
                      return JSON.parse(extraParams);
                  } catch (_error) {
                      return {};
                  }
              })()
            : { ...(extraParams || {}) };

    parsed.v = Number(version) === 4 ? 4 : 3;
    delete parsed.zelfEncryptVersion;
    return pickAllowedExtraParams(parsed);
};

const collectReservedKeyvalues = (reserved = {}) => {
    const keyvalues = {};

    for (const [key, value] of Object.entries(reserved || {})) {
        if (value === undefined || value === null || value === "") continue;
        if (SEARCHABLE_ADDRESS_FIELDS.includes(key)) continue;
        if (ADDRESS_CHUNK_KEYS.includes(key)) continue;
        if (key === CONTINUATION_LINK_KEY || key === CONTINUATION_LINK_KEY_2) continue;
        if (key.length > PINATA_KEYVALUE_MAX_LENGTH) continue;

        const serialized = serializePinataValue(value);
        if (serialized.length > PINATA_KEYVALUE_MAX_LENGTH) continue;

        keyvalues[key] = serialized;
    }

    return keyvalues;
};

const collectAddressEntries = (addresses = {}) => {
    const normalized = normalizeAddressMap(addresses);
    const entries = [];

    for (const field of SEARCHABLE_ADDRESS_FIELDS) {
        if (!normalized[field]) continue;
        if (normalized[field].length > PINATA_KEYVALUE_MAX_LENGTH) continue;
        entries.push([field, normalized[field]]);
    }

    return entries;
};

/**
 * Split reserved metadata + addresses into a primary pin and overflow pages.
 * Primary always keeps the domain storage key, domain, and extraParams.
 */
/**
 * Primary-pin keyvalues for metadata-only upserts (same QR CID). Packs overflow chains
 * into `addresses` / `addresses2` JSON chunks so search expands them without continuation pins.
 */
const buildUpsertPrimarySearchableKeyvalues = (reserved = {}, addresses = {}) => {
    const reservedKeyvalues = collectReservedKeyvalues(reserved);
    const topLevel = buildTopLevelAddressKeyvalues(addresses);
    const packed = serializeAddressBundleToPinataKeyvalues(buildAddressBundle(addresses));

    const merged = { ...reservedKeyvalues };
    const room = () => PINATA_KEYVALUE_MAX_COUNT - Object.keys(merged).length;

    for (const appKey of TOP_LEVEL_ADDRESS_FIELDS) {
        if (!topLevel[appKey] || room() <= 0) break;
        merged[appKey] = topLevel[appKey];
    }

    for (const chunkKey of ADDRESS_CHUNK_KEYS) {
        if (!packed[chunkKey] || room() <= 0) break;
        merged[chunkKey] = packed[chunkKey];
    }

    if (Object.keys(merged).length > PINATA_KEYVALUE_MAX_COUNT) {
        const error = new Error("tags_addresses_primary_keyvalues_overflow");
        error.status = 400;
        throw error;
    }

    return merged;
};

const buildSearchablePinPages = ({ reserved = {}, addresses = {}, tagName } = {}) => {
    const reservedKeyvalues = collectReservedKeyvalues(reserved);
    const addressEntries = collectAddressEntries(addresses);
    const reservedCount = Object.keys(reservedKeyvalues).length;
    const primaryAddressBudget = Math.max(0, PINATA_KEYVALUE_MAX_COUNT - reservedCount);

    const primaryAddresses = addressEntries.slice(0, primaryAddressBudget);
    const overflow = addressEntries.slice(primaryAddressBudget);

    const primaryKeyvalues = { ...reservedKeyvalues };
    for (const [key, value] of primaryAddresses) {
        primaryKeyvalues[key] = value;
    }

    const pages = {
        primary: {
            name: tagName,
            keyvalues: primaryKeyvalues,
        },
        continuations: [],
    };

    const pageSize = PINATA_KEYVALUE_MAX_COUNT - 1;
    const linkKeys = [CONTINUATION_LINK_KEY, CONTINUATION_LINK_KEY_2];

    for (let pageIndex = 0; pageIndex < linkKeys.length && overflow.length > pageIndex * pageSize; pageIndex += 1) {
        const slice = overflow.slice(pageIndex * pageSize, (pageIndex + 1) * pageSize);
        const keyvalues = {
            [linkKeys[pageIndex]]: tagName,
        };

        for (const [key, value] of slice) {
            keyvalues[key] = value;
        }

        pages.continuations.push({
            name: continuationPinName(tagName, pageIndex),
            keyvalues,
            linkKey: linkKeys[pageIndex],
        });
    }

    return pages;
};

const extractAddressKeyvaluesFromPublicData = (source = {}) => {
    const expanded = {};

    if (source && typeof source === "object") {
        for (const chunkKey of ADDRESS_CHUNK_KEYS) {
            const chunk = _parseChunk(source[chunkKey]);
            if (!chunk) continue;

            for (const [rawKey, value] of Object.entries(chunk)) {
                if (!_isUsableString(value)) continue;
                expanded[resolveAddressKey(rawKey)] = value.trim();
            }
        }
    }

    return normalizeAddressMap({
        ...expanded,
        ...(source || {}),
    });
};

const mergeContinuationAddresses = (target = {}, source = {}) => {
    for (const field of SEARCHABLE_ADDRESS_FIELDS) {
        if (source[field] && !target[field]) target[field] = source[field];
    }
    return target;
};

const omitAddressKeyvalues = (metadata = {}) => collectReservedKeyvalues(metadata);

module.exports = {
    EXTRA_PARAMS_ALLOWED_KEYS,
    EXTRA_PARAMS_SECURITY_TYPES,
    ADDRESS_CHUNK_KEYS,
    ADDRESS_FIELDS_ORDER,
    ADDRESS_KEYVALUE_CHUNKS,
    APP_ADDRESS_FIELDS,
    APP_TO_SHORT_STORAGE,
    CONTINUATION_LINK_KEY,
    CONTINUATION_LINK_KEY_2,
    MAX_ADDRESS_CHUNKS,
    PACKED_ONLY_ADDRESS_FIELDS,
    PINATA_KEYVALUE_MAX_COUNT,
    PINATA_KEYVALUE_MAX_LENGTH,
    PRIMARY_RESERVED_KEYS,
    SEARCHABLE_ADDRESS_FIELDS,
    SHORT_STORAGE_TO_APP,
    STANDALONE_ADDRESS_FIELDS,
    TOP_LEVEL_ADDRESS_FIELDS,
    buildAddressBundle,
    buildAddressKeyvalues,
    buildUpsertPrimarySearchableKeyvalues,
    buildSearchablePinPages,
    buildTopLevelAddressKeyvalues,
    cleanExtraParamsForPinata,
    collectReservedKeyvalues,
    continuationPinName,
    expandPackedAddresses,
    extractAddressKeyvaluesFromPublicData,
    getAllChainAddresses,
    getContinuationCanonicalName,
    isContinuationPublicData,
    isPackedAddressPublicData,
    mergeAddressKeyvaluesIntoPublicData,
    mergeContinuationAddresses,
    normalizeAddressMap,
    omitAddressKeyvalues,
    resolveEncryptVersion,
    serializeAddressBundleToPinataKeyvalues,
    stampExtraParamsVersion,
};
