/**
 * Full tag for a list search. Same rule as TagsPartsModule.getFullTagName,
 * kept here so list ownership does not load the tags module.
 * @param {string} tagName
 * @param {string} domain
 */
const fullTagName = (tagName, domain) => {
	if (!tagName || !domain) {
		throw new Error(`Invalid parameters: tagName=${tagName}, domain=${domain}`);
	}

	if (tagName.includes(`.${domain}`)) return tagName;

	return `${tagName}.${domain}`;
};

/**
 * Wallet that a list reads. Only the session stamp copied onto `authToken.tagName`
 * counts. A device `identifier` and a query `tagName` are not an owner.
 * @param {Object} authToken
 * @returns {{ identifier: string, domain: string, fullTagName: string }}
 */
const listOwner = (authToken) => {
	const domain = authToken?.domain || "zelf";
	const identifier = typeof authToken?.tagName === "string" ? authToken.tagName.trim() : "";

	if (!identifier) {
		const error = new Error("403:ERR_SESSION_NOT_VERIFIED");
		throw error;
	}

	return {
		identifier,
		domain,
		fullTagName: fullTagName(identifier, domain),
	};
};

module.exports = {
	fullTagName,
	listOwner,
};
