/**
 * One Zelf name for sessions, vault ownership, slot accounts, and plan lookup.
 * Trim, lowercase, strip a trailing `.{domain}` (any case, repeated), then append the domain.
 * `JimBot`, `Jimbot.Zelf`, and `Jimbot.Zelf.zelf` with domain `zelf` are all `jimbot.zelf`.
 * @param {string} tagName
 * @param {string} [domain]
 * @returns {{ tagName: string, domain: string, zelfName: string }}
 */
const normalizeZelfName = (tagName, domain = "zelf") => {
    const tld = String(domain || "zelf")
        .trim()
        .toLowerCase()
        .replace(/^\.+/, "");
    let bare = String(tagName || "")
        .trim()
        .toLowerCase();

    if (!bare || !tld) {
        return { tagName: "", domain: tld, zelfName: "" };
    }

    const suffix = `.${tld}`;
    while (bare.endsWith(suffix)) {
        bare = bare.slice(0, -suffix.length);
    }
    bare = bare.replace(/\.+$/, "");

    if (!bare) {
        return { tagName: "", domain: tld, zelfName: "" };
    }

    return {
        tagName: bare,
        domain: tld,
        zelfName: `${bare}.${tld}`,
    };
};

module.exports = {
    normalizeZelfName,
};
