/**
 * Backfill the reverse address index (#540) from every Arweave and IPFS record of a domain.
 *
 * Read-only against Arweave and Pinata; it only writes the TagAddressIndex collection,
 * which the search treats as a hint (every hit is re-verified against the live record).
 *
 * Usage:
 *   node scripts/backfill-tag-address-index.js [--domain zelf] [--source all|arweave|ipfs] [--max-pages 500] [--dry-run]
 */
const mongoose = require("mongoose");
const config = require("../Core/config");
const IPFS = require("../Core/ipfs");
const { postGraphql } = require("../Repositories/Arweave/modules/arweave-gateway.module");
const TagAddressIndex = require("../Repositories/Tags/modules/tag-address-index.module");
const { expandStoredExtraParams } = require("../Repositories/Tags/modules/tags-addresses.module");

const PAGE_SIZE = 100;

const argValue = (name, fallback) => {
    const index = process.argv.indexOf(`--${name}`);
    return index > -1 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
};

const domain = argValue("domain", "zelf");
const tagName = argValue("tag", "domain");
const source = argValue("source", "all");
const maxPages = Number(argValue("max-pages", 500));
const IPFS_MAX_RECORDS = 50000;
const dryRun = process.argv.includes("--dry-run");
const owner = config.arwave.env === "development" ? config.arwave.hold.owner : config.arwave.owner;

const pageQuery = (after) => `{
    transactions(
        owners: ["${owner}"],
        tags: [{ name: "${tagName}", values: ["${domain}"] }],
        sort: HEIGHT_DESC,
        first: ${PAGE_SIZE}${after ? `,\n        after: "${after}"` : ""}
    ) {
        edges { cursor node { id tags { name value } } }
    }
}`;

const withExtraParams = (publicData) => {
    if (publicData.extraParams) {
        try {
            Object.assign(publicData, expandStoredExtraParams(publicData.extraParams));
        } catch (_error) {
            /* keep the raw tags */
        }
        delete publicData.extraParams;
    }

    return publicData;
};

const arweaveRecord = (node) => {
    const publicData = {};

    for (const tag of node.tags || []) publicData[tag.name] = tag.value;

    return { id: node.id, publicData: withExtraParams(publicData) };
};

const ipfsRecord = (file) => ({
    id: file.id,
    publicData: withExtraParams({ ...(file.publicData || file.metadata?.keyvalues || file.keyvalues || {}) }),
});

const totals = { records: 0, entries: 0, names: new Set() };

const indexBatch = async (batch, recordSource) => {
    for (const record of batch) {
        const recordEntries = TagAddressIndex.entriesForRecord(record);
        if (!recordEntries.length) continue;

        totals.entries += recordEntries.length;
        totals.names.add(recordEntries[0].tagName);
    }

    totals.records += batch.length;

    if (!dryRun) await TagAddressIndex.indexRecords(batch, { domain, source: recordSource });
};

const backfillArweave = async () => {
    if (!owner) throw new Error("ARWEAVE_OWNER is not configured");

    let after = null;

    for (let page = 0; page < maxPages; page++) {
        const edges = (await postGraphql(pageQuery(after))) || [];

        await indexBatch(edges.map((edge) => arweaveRecord(edge.node)), "arweave");
        console.log(`arweave page ${page + 1}: ${edges.length} records (names with packed addresses ${totals.names.size})`);

        if (edges.length < PAGE_SIZE) break;
        after = edges[edges.length - 1].cursor;
    }
};

const backfillIpfs = async () => {
    const files = await IPFS.filter("domain", domain, { limit: IPFS_MAX_RECORDS, throwOnError: true });

    for (let start = 0; start < files.length; start += PAGE_SIZE) {
        await indexBatch(files.slice(start, start + PAGE_SIZE).map(ipfsRecord), "ipfs");
    }

    console.log(`ipfs: ${files.length} records (names with packed addresses ${totals.names.size})`);
};

const main = async () => {
    if (!dryRun) await mongoose.connect(config.db.uri);

    if (["all", "arweave"].includes(source)) await backfillArweave();
    if (["all", "ipfs"].includes(source)) await backfillIpfs();

    console.log(JSON.stringify({ domain, source, dryRun, records: totals.records, names: totals.names.size, entries: totals.entries }));

    if (!dryRun) await mongoose.disconnect();
};

main().catch(async (error) => {
    console.error(error);
    process.exitCode = 1;
    await mongoose.disconnect().catch(() => {});
});
