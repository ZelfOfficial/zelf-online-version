/**
 * Run the confirm cases once in UTC and once in America/Edmonton.
 * Each child process loads moment only after TZ is set.
 */
const { spawnSync } = require("child_process");
const path = require("path");

const cases = path.resolve(__dirname, "zelf-id-confirm-tz.child.test.js");

const run = (tz) =>
    spawnSync(process.execPath, [require.resolve("jest/bin/jest"), cases, "--runInBand", "--forceExit", "--no-coverage"], {
        cwd: path.resolve(__dirname, "../.."),
        env: { ...process.env, TZ: tz, CONFIRM_TZ_CHILD: "1" },
        encoding: "utf8",
    });

describe("confirm timezone matrix", () => {
    test("coupon, whitelist, crypto, and stripe confirms hold in UTC and America/Edmonton", () => {
        for (const tz of ["UTC", "America/Edmonton"]) {
            const result = run(tz);
            if (result.status !== 0) {
                throw new Error(`${tz} confirm tests failed\n${result.stdout}\n${result.stderr}`);
            }
        }
    }, 180000);
});
