/**
 * Restore plan-term duration cleared by an unlock that saved the row without duration.
 * Dry-run unless `--apply` is passed. Refuses a URI that looks like production.
 *
 *   node scripts/repair-zelf-id-plan-term-duration.js
 *   node scripts/repair-zelf-id-plan-term-duration.js --apply
 */
const mongoose = require("mongoose");
const config = require("../Core/config");
const PlanTerm = require("../Repositories/ZelfID/models/zelf-id-plan-term.model");
const { restoredDurationForPlanTerm } = require("../Repositories/ZelfID/modules/zelf-id-plan-term-duration");

const apply = process.argv.includes("--apply");

const looksLikeProduction = (uri) => /prod|production|zelf\.world/i.test(String(uri || ""));

const main = async () => {
    const uri = config.db?.uri || process.env.MONGODB_URI || "";
    if (!uri) {
        console.error("MONGODB_URI is not set.");
        process.exitCode = 1;
        return;
    }
    if (looksLikeProduction(uri)) {
        console.error("Refusing to run against a production MongoDB URI.");
        process.exitCode = 1;
        return;
    }

    await mongoose.connect(uri);
    const rows = await PlanTerm.find({
        $or: [{ duration: null }, { duration: "" }, { duration: { $exists: false } }],
        planExpiresAt: { $nin: [null, ""] },
    }).lean();

    const changes = [];
    for (const row of rows) {
        const duration = restoredDurationForPlanTerm(row);
        if (!duration) continue;
        changes.push({ zelfName: row.zelfName, duration, planExpiresAt: row.planExpiresAt });
        if (apply) {
            await PlanTerm.updateOne({ _id: row._id, $or: [{ duration: null }, { duration: "" }, { duration: { $exists: false } }] }, { $set: { duration } });
        }
    }

    console.log(JSON.stringify({ apply, scanned: rows.length, restored: changes.length, changes }, null, 2));
    await mongoose.disconnect();
};

if (require.main === module) {
    main().catch(async (error) => {
        console.error(error);
        process.exitCode = 1;
        await mongoose.disconnect().catch(() => {});
    });
}

module.exports = { looksLikeProduction, main };
