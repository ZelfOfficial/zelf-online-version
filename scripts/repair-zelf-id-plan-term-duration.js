/**
 * Restore plan-term duration cleared by an unlock that saved the row without duration.
 * Dry-run unless `--apply` is passed.
 * Refuses every database except `wallet_development`, unless `--target-db <name>` matches the URI.
 *
 *   node scripts/repair-zelf-id-plan-term-duration.js
 *   node scripts/repair-zelf-id-plan-term-duration.js --apply
 *   node scripts/repair-zelf-id-plan-term-duration.js --target-db wallet_development --apply
 */
const mongoose = require("mongoose");
const config = require("../Core/config");
const PlanTerm = require("../Repositories/ZelfID/models/zelf-id-plan-term.model");
const QuoteGrant = require("../Repositories/ZelfID/models/zelf-id-quote-grant.model");
const { restoredDurationForPlanTerm } = require("../Repositories/ZelfID/modules/zelf-id-plan-term-duration");

const DEV_DB_ALLOWLIST = ["wallet_development"];

const databaseNameFromUri = (uri) => {
    const raw = String(uri || "");
    const normalized = raw.replace(/^mongodb(?:\+srv)?:\/\//, "http://");
    try {
        const path = new URL(normalized).pathname.replace(/^\//, "");
        return decodeURIComponent(path.split("/")[0] || "");
    } catch (_error) {
        return "";
    }
};

const targetDbFromArgv = (argv = process.argv) => {
    const index = argv.indexOf("--target-db");
    if (index === -1) return "";
    return String(argv[index + 1] || "").trim();
};

const assertAllowedDatabase = ({ uri, targetDb = "" }) => {
    const name = databaseNameFromUri(uri);
    if (!name) {
        const error = new Error("MongoDB URI has no database name.");
        error.code = "database_not_allowed";
        throw error;
    }
    if (targetDb) {
        if (name !== targetDb) {
            const error = new Error(`Database ${name} does not match --target-db ${targetDb}.`);
            error.code = "database_not_allowed";
            throw error;
        }
        return name;
    }
    if (!DEV_DB_ALLOWLIST.includes(name)) {
        const error = new Error(`Refusing database ${name}. Use wallet_development or pass --target-db.`);
        error.code = "database_not_allowed";
        throw error;
    }
    return name;
};

const summarizeRepair = ({ apply, scanned, changes }) =>
    apply
        ? { apply: true, scanned, restored: changes.length, changes }
        : { apply: false, scanned, wouldRestore: changes.length, changes };

const main = async () => {
    const apply = process.argv.includes("--apply");
    const uri = config.db?.uri || process.env.MONGODB_URI || "";
    if (!uri) {
        console.error("MONGODB_URI is not set.");
        process.exitCode = 1;
        return;
    }
    const database = assertAllowedDatabase({ uri, targetDb: targetDbFromArgv() });

    await mongoose.connect(uri);
    const rows = await PlanTerm.find({
        $or: [{ duration: null }, { duration: "" }, { duration: { $exists: false } }],
        planExpiresAt: { $nin: [null, ""] },
    }).lean();

    const changes = [];
    for (const row of rows) {
        const grants = await QuoteGrant.countDocuments({ zelfName: row.zelfName, status: "done" });
        const duration = restoredDurationForPlanTerm(row, grants);
        if (!duration) continue;
        changes.push({ zelfName: row.zelfName, duration, planExpiresAt: row.planExpiresAt });
        if (apply) {
            await PlanTerm.updateOne(
                { _id: row._id, $or: [{ duration: null }, { duration: "" }, { duration: { $exists: false } }] },
                { $set: { duration } }
            );
        }
    }

    console.log(JSON.stringify({ database, ...summarizeRepair({ apply, scanned: rows.length, changes }) }, null, 2));
    await mongoose.disconnect();
};

if (require.main === module) {
    main().catch(async (error) => {
        console.error(error.message || error);
        process.exitCode = 1;
        await mongoose.disconnect().catch(() => {});
    });
}

module.exports = {
    DEV_DB_ALLOWLIST,
    assertAllowedDatabase,
    databaseNameFromUri,
    summarizeRepair,
    targetDbFromArgv,
};
