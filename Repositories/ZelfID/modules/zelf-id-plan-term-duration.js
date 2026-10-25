/**
 * Duration that an unlock cleared on a plan term, from planExpiresAt minus the term start.
 * Returns null when the row already has a duration or the span is not 1, 2, 3, or 5 years.
 */
const moment = require("moment");
const { parseLeaseDate } = require("../../Tags/modules/lease-date.util");

const PAID_TERM_YEARS = [1, 2, 3, 5];
const HOUR_TOLERANCE = 48;

const renewalAmbiguous = (row = {}, renewalCount = 0) => {
    if (renewalCount > 1) return true;
    if (!row.createdAt || !row.updatedAt) return false;
    return moment.utc(row.updatedAt).diff(moment.utc(row.createdAt), "hours", true) > HOUR_TOLERANCE;
};

/**
 * Stored term start, or `createdAt` only when the row was not renewed.
 * @returns {import("moment").Moment|null}
 */
const termStart = (row = {}, renewalCount = 0) => {
    if (row.termStartedAt) {
        const stored = moment.utc(row.termStartedAt);
        return stored.isValid() ? stored : null;
    }
    if (renewalAmbiguous(row, renewalCount) || !row.createdAt) return null;
    const created = moment.utc(row.createdAt);
    return created.isValid() ? created : null;
};

const restoredDurationForPlanTerm = (row = {}, renewalCount = 0) => {
    const current = row.duration == null ? "" : String(row.duration).trim();
    if (current) return null;
    if (!row.planExpiresAt) return null;

    const end = parseLeaseDate(row.planExpiresAt);
    const start = termStart(row, renewalCount);
    if (!end.isValid() || !start || !end.isAfter(start)) return null;

    for (const years of PAID_TERM_YEARS) {
        const expected = start.clone().add(years, "year");
        if (Math.abs(end.diff(expected, "hours", true)) <= HOUR_TOLERANCE) return String(years);
    }

    return null;
};

module.exports = {
    HOUR_TOLERANCE,
    PAID_TERM_YEARS,
    renewalAmbiguous,
    restoredDurationForPlanTerm,
    termStart,
};
