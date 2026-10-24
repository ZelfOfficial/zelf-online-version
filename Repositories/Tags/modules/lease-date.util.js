/**
 * Lease stamps share one UTC clock.
 *
 * New writers format with `formatLeaseDate`. Readers parse with `parseLeaseDate`.
 * A naive `YYYY-MM-DD HH:mm:ss` string is a UTC wall time: that is what v4 stored
 * on UTC servers, and it does not follow the process timezone. Strings that already
 * carry a zone (ISO `Z` or an offset) stay absolute instants.
 */
const moment = require("moment");

const LEASE_DATE_FORMAT = "YYYY-MM-DD HH:mm:ss";

const formatLeaseDate = (amount, unit, from = moment.utc()) => {
    const stamp = moment.utc(from);
    if (amount) stamp.add(amount, unit);
    return stamp.format(LEASE_DATE_FORMAT);
};

const parseLeaseDate = (value) => {
    if (value == null || value === "") return moment.invalid();
    if (typeof value === "number" && Number.isFinite(value)) return moment.unix(value).utc();
    if (value instanceof Date) return moment.utc(value);

    const text = String(value).trim();
    if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(text)) return moment.parseZone(text).utc();

    const strict = moment.utc(text, LEASE_DATE_FORMAT, true);
    if (strict.isValid()) return strict;
    return moment.utc(text);
};

module.exports = {
    LEASE_DATE_FORMAT,
    formatLeaseDate,
    parseLeaseDate,
};
