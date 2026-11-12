#!/usr/bin/env node
/**
 * Re-tag the 7 ZelfKeys pins saved under a throwaway session identifier (Nov 11 17:00 UTC → fix).
 *
 * Cause: POST /api/sessions stopped putting tagName in the JWT (f51a5b6), so ownerParts() fell back to the
 * session `identifier` and the records were pinned with keyOwner/category/name = "<identifier>.zelf...".
 * Only Pinata metadata changes (name + keyvalues). The encrypted proof is not touched.
 *
 * Usage:
 *   node scripts/retag-orphaned-zelfkeys.js                      dry run (default): reads only, prints the diff
 *   node scripts/retag-orphaned-zelfkeys.js --apply              writes a backup, then updates metadata
 *   node scripts/retag-orphaned-zelfkeys.js --apply --unpin <id> also unpins the given duplicate (never by default)
 *   node scripts/retag-orphaned-zelfkeys.js --verify             re-reads and checks every record is under its owner
 *   --env development                                            use the dev Pinata account (default: production)
 *
 * Every record is checked before it is written: it must still carry the expected throwaway owner, and nothing
 * is written if the backup file cannot be created.
 */
const fs = require("fs");
const path = require("path");
const axios = require("axios");

require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => {
    const i = args.indexOf(name);
    return i === -1 ? null : args[i + 1];
};

const APPLY = flag("--apply");
const VERIFY = flag("--verify");
const UNPIN = option("--unpin");
const ENV = option("--env") || "production";

const prefix = ENV === "development" ? "_" : "";
const JWT = process.env[`${prefix}PINATA_JWT`];
const API = "https://api.pinata.cloud/v3/files/public";

/** Matched from metadata (issuer / username / time) and the logs on 2026-11-12. */
const RECORDS = [
    { id: "01a1cdac-c7af-7bfb-b552-cb2dd1fa4d14", owner: "johansecurity.zelf", note: "Vercel 2FA, 02:53:35Z (kept copy)" },
    { id: "01a1cdaa-5ba9-7a47-b42e-a30bedd33310", owner: "johansecurity.zelf", note: "Vercel 2FA, 02:50:56Z (duplicate save)" },
    { id: "01a1cd76-9dbc-7487-959f-9f64b7641032", owner: "qa.zelf", note: "password 'A', 01:54:25Z (weaker match)" },
    { id: "01a1cd57-905d-7f04-b539-d3925def5236", owner: "qa.zelf", note: "password 'a', 01:20:30Z" },
    { id: "01a1cd55-d1d0-71bd-b693-e2a16b39a391", owner: "qa.zelf", note: "2FA3, 01:18:36Z" },
    { id: "01a1cd51-ea78-76d5-ae86-9294279a31fe", owner: "qa.zelf", note: "password 'A', 01:14:20Z" },
    { id: "01a1cd4b-d498-79d8-a406-0e38d74f8346", owner: "qa.zelf", note: "2FA4, 01:07:41Z" },
];

const KNOWN_REAL_OWNERS = new Set(RECORDS.map((r) => r.owner));
const http = axios.create({ headers: { Authorization: `Bearer ${JWT}` }, timeout: 30000 });

const getFile = async (id) => (await http.get(`${API}/${id}`)).data.data;

/** Replace the throwaway owner wherever it appears in a string. */
const swapOwner = (value, oldOwner, newOwner) => (typeof value === "string" ? value.split(oldOwner).join(newOwner) : value);

const plan = (file, owner) => {
    const kv = file.keyvalues || {};
    const oldOwner = kv.keyOwner;

    if (!oldOwner) return { skip: "no keyOwner on the pin" };
    if (oldOwner === owner) return { skip: "already under the real owner" };
    if (KNOWN_REAL_OWNERS.has(oldOwner)) return { skip: `keyOwner is ${oldOwner}, not a throwaway identifier` };
    if (!String(kv.category || "").startsWith(oldOwner)) return { skip: "category does not start with the throwaway owner" };

    const nextKv = Object.fromEntries(Object.entries(kv).map(([k, v]) => [k, swapOwner(v, oldOwner, owner)]));

    return {
        oldOwner,
        name: { from: file.name, to: swapOwner(file.name, oldOwner, owner) },
        changes: Object.keys(kv)
            .filter((k) => nextKv[k] !== kv[k])
            .map((k) => ({ key: k, from: kv[k], to: nextKv[k] })),
        keyvalues: nextKv,
    };
};

const main = async () => {
    if (!JWT) throw new Error(`Missing ${prefix}PINATA_JWT for env "${ENV}"`);

    if (VERIFY) {
        let bad = 0;
        for (const rec of RECORDS) {
            const file = await getFile(rec.id);
            const ok = file.keyvalues?.keyOwner === rec.owner && String(file.keyvalues?.category || "").startsWith(`${rec.owner}_`);
            if (!ok) bad++;
            console.log(`${ok ? "OK  " : "FAIL"} ${rec.id} keyOwner=${file.keyvalues?.keyOwner} category=${file.keyvalues?.category}`);
        }
        process.exit(bad ? 1 : 0);
    }

    console.log(`Mode: ${APPLY ? "APPLY" : "DRY RUN"}  |  Pinata: ${ENV}${UNPIN ? `  |  unpin: ${UNPIN}` : ""}\n`);

    const files = [];
    for (const rec of RECORDS) {
        let file;
        try {
            file = await getFile(rec.id);
        } catch (error) {
            console.log(`MISSING ${rec.id} (${error.response?.status || error.message})`);
            continue;
        }
        files.push({ rec, file, change: plan(file, rec.owner) });
    }

    for (const { rec, file, change } of files) {
        console.log(`• ${rec.id}  → ${rec.owner}  [${rec.note}]  created ${file.created_at}`);
        if (change.skip) {
            console.log(`    SKIP: ${change.skip}`);
            continue;
        }
        console.log(`    name: ${change.name.from}  →  ${change.name.to}`);
        change.changes.forEach((c) => console.log(`    ${c.key}: ${c.from}  →  ${c.to}`));
    }

    if (UNPIN && !RECORDS.some((r) => r.id === UNPIN)) throw new Error("--unpin must be one of the 7 listed ids");

    if (!APPLY) {
        console.log("\nDry run only. Nothing was written. Re-run with --apply after the tagName fix is deployed.");
        return;
    }

    const backupFile = path.resolve(__dirname, `retag-orphaned-zelfkeys.backup.${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
    fs.writeFileSync(backupFile, JSON.stringify(files.map(({ rec, file }) => ({ id: rec.id, owner: rec.owner, file })), null, 2), { flag: "wx" });
    console.log(`\nBackup written: ${backupFile}`);

    for (const { rec, file, change } of files) {
        if (change.skip) continue;
        await http.put(`${API}/${rec.id}`, { name: change.name.to, keyvalues: change.keyvalues });
        const after = await getFile(rec.id);
        const ok = after.keyvalues?.keyOwner === rec.owner;
        console.log(`${ok ? "UPDATED" : "CHECK  "} ${rec.id} keyOwner=${after.keyvalues?.keyOwner}`);
    }

    if (UNPIN) {
        await http.delete(`${API}/${UNPIN}`);
        console.log(`UNPINNED ${UNPIN}`);
    }

    console.log("\nDone. Run with --verify, then check GET /api/zelf-keys/list as each owner.");
};

main().catch((error) => {
    console.error("Failed:", error.response?.data || error.message);
    process.exit(1);
});

