/**
 * Lease stamps stay on UTC even when the process timezone is America/Edmonton (MDT, UTC-6).
 * A naive `YYYY-MM-DD HH:mm:ss` string is the UTC wall time v4 stored on UTC servers.
 */
const { spawnSync } = require("child_process");
const path = require("path");

describe("lease dates in America/Edmonton", () => {
    test("writers and readers agree on UTC and do not shift a legacy stamp by the local offset", () => {
        const script = `
            const moment = require("moment");
            const { formatLeaseDate, parseLeaseDate } = require("./Repositories/Tags/modules/lease-date.util");
            if (process.env.TZ !== "America/Edmonton") process.exit(2);
            const written = formatLeaseDate();
            const parsed = parseLeaseDate(written);
            const asLocal = moment(written, "YYYY-MM-DD HH:mm:ss", true);
            if (Math.abs(asLocal.utcOffset()) < 360) process.exit(3);
            if (parsed.toISOString() !== moment.utc(written, "YYYY-MM-DD HH:mm:ss", true).toISOString()) process.exit(4);
            if (Math.abs(parsed.diff(moment.utc(), "seconds")) > 2) process.exit(5);
            if (parsed.valueOf() === asLocal.valueOf()) process.exit(6);
            const legacy = parseLeaseDate("2026-01-15 18:30:00");
            if (legacy.toISOString() !== "2026-01-15T18:30:00.000Z") process.exit(7);
            process.stdout.write("ok");
        `;
        const result = spawnSync(process.execPath, ["-e", script], {
            cwd: path.resolve(__dirname, "../.."),
            env: { ...process.env, TZ: "America/Edmonton" },
            encoding: "utf8",
        });
        expect(result.status).toBe(0);
        expect(result.stdout).toContain("ok");
    });
});
