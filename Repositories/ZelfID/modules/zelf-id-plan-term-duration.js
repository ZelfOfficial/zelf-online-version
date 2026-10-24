/**
 * Duration that an unlock cleared on a plan term, from planExpiresAt minus the term start.
 * Returns null when the row already has a duration or the span is not 1, 2, 3, or 5 years.
 */
const moment = require("moment");
const { parseLeaseDate } = require("../../Tags/modules/lease-date.util");

const PAID_TERM_YEARS = [1, 2, 3, 5];
const HOUR_TOLERANCE = 48;

const restoredDurationForPlanTerm = (row = {}) => {
    const current = row.duration == null ? "" : String(row.duration).trim();
    if (current) return null;
    if (!row.planExpiresAt || !row.createdAt) return null;

    const end = parseLeaseDate(row.planExpiresAt);
    const start = moment.utc(row.createdAt);
    if (!end.isValid() || !start.isValid() || !end.isAfter(start)) return null;

    for (const years of PAID_TERM_YEARS) {
        const expected = start.clone().add(years, "year");
        if (Math.abs(end.diff(expected, "hours", true)) <= HOUR_TOLERANCE) return String(years);
    }

    return null;
};

module.exports = {
    HOUR_TOLERANCE,
    PAID_TERM_YEARS,
    restoredDurationForPlanTerm,
};
