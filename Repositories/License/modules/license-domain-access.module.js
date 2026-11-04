/**
 * Resolve which license domain the caller may administer.
 * Allowed: the license owner (jwt.email owns the license) or staff of that license (jwt.ownerEmail).
 * Everyone else gets 403. A requested domain different from the caller's license domain is 403.
 */
const STAFF_TYPES = new Set(["staff", "staff_account"]);

const licenseDomainOf = (myLicense) =>
    String(myLicense?.publicData?.licenseDomain || myLicense?.domainConfig?.name || myLicense?.name || "")
        .trim()
        .toLowerCase();

const resolveAuthorizedDomain = async (jwt, requestedDomain, deps = {}) => {
    const getMyLicense = deps.getMyLicense || require("./license.module").getMyLicense;
    if (!jwt) throw new Error("401:unauthorized");

    const isStaff = STAFF_TYPES.has(jwt.accountType);
    const ownerEmail = String((isStaff ? jwt.ownerEmail : jwt.email) || "").toLowerCase();
    if (!ownerEmail) throw new Error("403:not_license_owner_or_staff");

    const result = await getMyLicense(jwt, false);
    const myLicense = result?.myLicense;
    const domain = licenseDomainOf(myLicense);
    const licenseOwner = String(myLicense?.publicData?.licenseOwner || "").toLowerCase();

    if (!domain) throw new Error("403:no_license_for_account");
    if (licenseOwner && licenseOwner !== ownerEmail) throw new Error("403:not_license_owner_or_staff");

    const wanted = String(requestedDomain || "").trim().toLowerCase().replace(/^\./, "");
    if (wanted && wanted !== domain) throw new Error("403:domain_not_managed_by_account");

    return { domain, isStaff, ownerEmail };
};

module.exports = { resolveAuthorizedDomain, licenseDomainOf };
