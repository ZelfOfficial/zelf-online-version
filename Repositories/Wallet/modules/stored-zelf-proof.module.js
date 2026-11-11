const { normalizeZelfName } = require("../../Tags/modules/zelf-name.util");

/**
 * Byte-compare two zelfProof strings. Both values are public records, not secrets.
 * @param {string} clientProof
 * @param {string} storedProof
 * @returns {boolean}
 */
const proofsMatch = (clientProof, storedProof) => {
	if (typeof clientProof !== "string" || typeof storedProof !== "string") return false;
	const left = clientProof.trim();
	const right = storedProof.trim();
	if (!left || !right || left.length !== right.length) return false;
	return Buffer.from(left).equals(Buffer.from(right));
};

const proofFromTagObject = (tagObject) => {
	if (!tagObject || typeof tagObject !== "object") return "";
	const fromPublic = tagObject.publicData?.zelfProof;
	if (typeof fromPublic === "string" && fromPublic.trim()) return fromPublic.trim();
	if (typeof tagObject.zelfProof === "string" && tagObject.zelfProof.trim()) return tagObject.zelfProof.trim();
	return "";
};

const rawNameFromTagObject = (tagObject) => {
	const publicData = tagObject?.publicData || {};
	const raw = publicData.zelfName || publicData.tagName || tagObject?.zelfName || tagObject?.tagName || "";
	return typeof raw === "string" ? raw.trim() : "";
};

/**
 * Load the server-stored zelfProof for a Zelf name.
 * Returns null when the name has no stored record or the lookup cannot be confirmed.
 * The returned name comes from the stored record (or the name the record was stored under).
 * @param {string} rawName
 * @param {string} [domain]
 * @param {Object} [authUser]
 * @returns {Promise<{ zelfName: string, zelfProof: string }|null>}
 */
const findStoredZelfProof = async (rawName, domain, authUser) => {
	const resolvedDomain = domain || "zelf";
	const normalized = normalizeZelfName(rawName, resolvedDomain);
	if (!normalized.zelfName) return null;

	let domainConfig;
	try {
		const { getDomainConfig } = require("../../Tags/config/supported-domains");
		domainConfig = getDomainConfig(normalized.domain);
	} catch (error) {
		return null;
	}
	if (!domainConfig) return null;

	let result;
	try {
		const TagsSearchModule = require("../../Tags/modules/tags-search.module");
		result = await TagsSearchModule.searchTag(
			{
				tagName: normalized.tagName,
				domain: normalized.domain,
				domainConfig,
				environment: "all",
				type: "both",
			},
			authUser
		);
	} catch (error) {
		return null;
	}

	if (!result || result.available || result.searchIncomplete || !result.tagObject) return null;

	const zelfProof = proofFromTagObject(result.tagObject);
	if (!zelfProof) return null;

	const recordName = rawNameFromTagObject(result.tagObject);
	const storedName = recordName ? normalizeZelfName(recordName, normalized.domain) : normalized;
	if (!storedName.zelfName || storedName.zelfName !== normalized.zelfName) return null;

	return {
		zelfName: storedName.zelfName,
		zelfProof,
	};
};

module.exports = {
	findStoredZelfProof,
	proofsMatch,
};
