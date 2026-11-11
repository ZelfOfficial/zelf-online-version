const OWNER_KEY = /email|owner|phone|tagname|zelfname|address|identifier|clientid|wallet/i;

const IDENTITY_FIELDS = [
    "email",
    "staffEmail",
    "ownerEmail",
    "phone",
    "staffPhone",
    "tagName",
    "verifiedTagName",
    "ethAddress",
    "solanaAddress",
    "identifier",
    "clientId",
    "walletAddress",
];

const isSuperAdminCaller = (authUser) => Boolean(authUser && authUser.superAdminId);

const callerIdentities = (authUser) => {
    if (!authUser || typeof authUser !== "object") return [];

    const identities = [];

    for (const field of IDENTITY_FIELDS) {
        const value = authUser[field];
        if (value == null) continue;
        const normalized = String(value).trim().toLowerCase();
        if (normalized) identities.push(normalized);
    }

    return identities;
};

const publicDataOf = (record) => {
    if (!record || typeof record !== "object") return {};
    if (record.publicData && typeof record.publicData === "object") return record.publicData;
    if (record.metadata?.keyvalues && typeof record.metadata.keyvalues === "object") return record.metadata.keyvalues;
    if (record.keyvalues && typeof record.keyvalues === "object") return record.keyvalues;
    return {};
};

const recordOwnedByCaller = (record, authUser) => {
    if (isSuperAdminCaller(authUser)) return true;

    const identities = new Set(callerIdentities(authUser));
    if (!identities.size) return false;

    const data = publicDataOf(record);

    for (const [key, value] of Object.entries(data)) {
        if (!OWNER_KEY.test(String(key))) continue;
        if (value == null || typeof value === "object") continue;
        if (identities.has(String(value).trim().toLowerCase())) return true;
    }

    return false;
};

const filterOwnedRecords = (records, authUser) => {
    const list = Array.isArray(records) ? records : [];
    if (isSuperAdminCaller(authUser)) return list;
    return list.filter((record) => recordOwnedByCaller(record, authUser));
};

module.exports = {
    isSuperAdminCaller,
    callerIdentities,
    recordOwnedByCaller,
    filterOwnedRecords,
};
