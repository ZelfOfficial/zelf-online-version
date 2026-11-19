const mongoose = require("mongoose");
const { Address } = require("@ton/core");
const TagAddressIndex = require("../models/tag-address-index.model");
const { PACKED_ONLY_ADDRESS_FIELDS, SEARCHABLE_ADDRESS_FIELDS, expandPackedAddresses } = require("./tags-addresses.module");

/**
 * Reverse lookup for addresses that a key/value search cannot reach (#540).
 *
 * Only packed fields are indexed: ethAddress / solanaAddress are standalone keyvalues
 * and the regular search already finds them. The index is a hint, never the answer:
 * the caller must confirm the address against the live record before trusting it.
 */

const KEY_ALIASES = {
    polkadotAddress: "dotAddress",
    kusamaAddress: "ksmAddress",
    bitcoinAddress: "btcAddress",
    stellarAddress: "xlmAddress",
};

const CASE_INSENSITIVE_KEYS = new Set(["ethAddress", "suiAddress", "aptosAddress"]);

const RECENTLY_INDEXED_MAX = 5000;
const recentlyIndexed = new Set();

const canonicalKey = (key) => KEY_ALIASES[key] || key;

const supportsKey = (key) => PACKED_ONLY_ADDRESS_FIELDS.includes(canonicalKey(key));

/** One stored form per account: TON EQ/UQ/raw collapse to raw, hex chains to lowercase. */
const canonicalValue = (key, value) => {
    if (typeof value !== "string" || value.trim() === "") return null;

    const trimmed = value.trim();
    const field = canonicalKey(key);

    if (field === "tonAddress") {
        try {
            return Address.parse(trimmed).toRawString();
        } catch (_error) {
            return null;
        }
    }

    return CASE_INSENSITIVE_KEYS.has(field) ? trimmed.toLowerCase() : trimmed;
};

const _baseTagName = (publicData = {}, fallbackName) => {
    const raw = publicData.tagName || publicData.zelfName || fallbackName;
    if (typeof raw !== "string" || raw.trim() === "") return null;

    // `.hold` copies resolve through the same name: searchTag type=both checks both.
    return raw.trim().toLowerCase().replace(/\.hold$/, "");
};

const _isReady = () => mongoose.connection?.readyState === 1;

/** Address entries a record exposes, packed chunks included. Does not mutate the record. */
const entriesForRecord = (record) => {
    if (!record?.publicData || typeof record.publicData !== "object") return [];

    const tagName = _baseTagName(record.publicData);
    if (!tagName) return [];

    const publicData = expandPackedAddresses({ ...record.publicData });
    const entries = [];

    for (const key of PACKED_ONLY_ADDRESS_FIELDS) {
        const value = canonicalValue(key, publicData[key]);
        if (value) entries.push({ key, value, tagName });
    }

    return entries;
};

/** Fire-and-forget: search latency must never depend on this write. */
const indexRecords = (records = [], { domain, source } = {}) => {
    if (!_isReady()) return;

    const operations = [];

    for (const record of records) {
        const cacheKey = `${record?.id || ""}|${_baseTagName(record?.publicData || {}) || ""}`;
        if (recentlyIndexed.has(cacheKey)) continue;

        const entries = entriesForRecord(record);
        if (!entries.length) continue;

        if (recentlyIndexed.size >= RECENTLY_INDEXED_MAX) recentlyIndexed.clear();
        recentlyIndexed.add(cacheKey);

        for (const entry of entries) {
            operations.push({
                updateOne: {
                    filter: { key: entry.key, value: entry.value, tagName: entry.tagName },
                    update: {
                        $set: { domain: domain || "zelf", source: source || "", recordId: record.id || "" },
                    },
                    upsert: true,
                },
            });
        }
    }

    if (!operations.length) return;

    // Returned for the backfill script; searches never await it.
    return TagAddressIndex.bulkWrite(operations, { ordered: false }).catch((error) => {
        console.warn("tag-address-index write failed:", error?.message || error);
    });
};

/** Candidate tag names for an address, newest first. */
const findTagNames = async (key, value, { limit = 3 } = {}) => {
    if (!_isReady() || !supportsKey(key)) return [];

    const canonical = canonicalValue(key, value);
    if (!canonical) return [];

    try {
        const rows = await TagAddressIndex.find({ key: canonicalKey(key), value: canonical })
            .sort({ updatedAt: -1 })
            .limit(limit)
            .lean();

        return [...new Set(rows.map((row) => row.tagName))];
    } catch (error) {
        console.warn("tag-address-index read failed:", error?.message || error);
        return [];
    }
};

/** True when the record currently registers this address (packed chunks included). */
const recordHasAddress = (publicData, key, value) => {
    if (!publicData || typeof publicData !== "object") return false;

    const expected = canonicalValue(key, value);
    if (!expected) return false;

    const field = canonicalKey(key);
    const expanded = expandPackedAddresses({ ...publicData });

    return canonicalValue(field, expanded[field] || expanded[key]) === expected;
};

const _addressSet = (publicData) => {
    const expanded = expandPackedAddresses({ ...publicData });
    const values = new Set();

    for (const key of SEARCHABLE_ADDRESS_FIELDS) {
        const value = canonicalValue(key, expanded[key]);
        if (value) values.add(`${key}:${value}`);
    }

    return { expanded, values };
};

/**
 * Re-pins after 2026-08-04 (v3 upgrade) kept only the metadata: qa99.zelf's newest
 * Arweave record has no address at all and its IPFS record lost TON/DOT/KSM. Fill the
 * missing fields from older records of the same wallet, newest first. A record only
 * contributes when it shares an address with what is already known, so a name that
 * changed hands never inherits the previous owner's addresses, and explicit values
 * (such as a repaired TON address) are never overwritten.
 */
const hydrateMissingAddresses = (publicData, records = []) => {
    if (!publicData || typeof publicData !== "object") return publicData;

    const known = _addressSet(publicData).values;

    for (const record of records) {
        if (!record?.publicData || record.publicData === publicData) continue;

        const { expanded, values } = _addressSet(record.publicData);
        if (!values.size) continue;

        const sameWallet = !known.size || [...values].some((value) => known.has(value));
        if (!sameWallet) continue;

        for (const key of SEARCHABLE_ADDRESS_FIELDS) {
            if (typeof publicData[key] === "string" && publicData[key].trim() !== "") continue;
            if (typeof expanded[key] !== "string" || expanded[key].trim() === "") continue;

            publicData[key] = expanded[key].trim();
        }

        for (const value of values) known.add(value);
    }

    return publicData;
};

const _hasAddressValue = (value) => typeof value === "string" && value.trim() !== "";

/**
 * Last resort after IPFS continuation lookup: fill packed fields that are still
 * empty from tagaddressindexes for this tag and domain. Does not overwrite a
 * value already on the record and does not call Pinata.
 */
const fillMissingIndexedAddresses = async (publicData, { domain, tagName } = {}) => {
    if (!publicData || typeof publicData !== "object") return publicData;
    if (!_isReady()) return publicData;

    const missing = PACKED_ONLY_ADDRESS_FIELDS.filter((key) => !_hasAddressValue(publicData[key]));
    if (!missing.length) return publicData;

    const resolvedName = _baseTagName(publicData, tagName);
    const resolvedDomain = typeof domain === "string" && domain.trim() !== "" ? domain.trim() : publicData.domain;
    if (!resolvedName || typeof resolvedDomain !== "string" || resolvedDomain.trim() === "") return publicData;

    try {
        const rows = await TagAddressIndex.find({
            tagName: resolvedName,
            domain: resolvedDomain.trim(),
            key: { $in: missing },
        })
            .sort({ updatedAt: -1 })
            .lean();

        const filled = new Set();

        for (const row of rows) {
            if (!row || filled.has(row.key) || !missing.includes(row.key)) continue;
            if (!_hasAddressValue(row.value)) continue;

            publicData[row.key] = row.value.trim();
            filled.add(row.key);
        }
    } catch (error) {
        console.warn("tag-address-index address fallback failed:", resolvedName, error?.message || "read_failed");
    }

    return publicData;
};

module.exports = {
    canonicalKey,
    canonicalValue,
    entriesForRecord,
    fillMissingIndexedAddresses,
    findTagNames,
    hydrateMissingAddresses,
    indexRecords,
    recordHasAddress,
    supportsKey,
};
