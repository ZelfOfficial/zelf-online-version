/**
 * Module for Arweave AR-IO ARNs operations
 */

const axios = require("axios");
const config = require("../../../Core/config");
const TagsSearchModule = require("../../Tags/modules/tags-search.module");
const { buildArnsUndernameUrls, resolveZelfLink } = require("./arweave-gateway.module");
const { initAnt, resolveExpectedTransactionId, setAntRecord, mappingOfSites } = require("./ar-io-arns-shared.module");

const mappingOfSitesRef = mappingOfSites;

/**
 * Check if the undername URL resolves directly on the gateway
 * @param {string} url - Gateway undername URL
 * @returns {Promise<boolean>}
 */
const _checkGatewayUrl = async (url) => {
	try {
		const res = await axios.head(url, {
			timeout: 5000,
			maxRedirects: 5,
			validateStatus: (status) => status >= 200 && status < 400,
		});
		return res.status >= 200 && res.status < 400;
	} catch {
		return false;
	}
};

/**
 * Get AR-IO ARNs for a user
 * @param {Object} params - Query parameters
 * @param {Object} authUser - Authenticated user object
 * @returns {Promise<Object>} AR-IO ARNs data
 */
const get = async (params, authUser = {}) => {
	const { tagObject, tagName, domain } = await _validateTagName(params.zelfName.split(".")[0], params.zelfName.split(".")[1], authUser);
	const primaryUrl = (await resolveZelfLink(tagName, domain)).url;

	let records = null;
	try {
		const ant = initAnt();
		records = await ant.getRecords();
	} catch (error) {
		// When the AO Compute Unit is restricted (e.g. process whitelist error), fall back to gateway verification
		const gatewayResolves = await _checkGatewayUrl(primaryUrl);
		if (gatewayResolves) {
			return {
				success: true,
				exists: true,
				record: {
					transactionId: mappingOfSitesRef[domain] || config.arns.index_transaction_id,
					ttlSeconds: 3600,
				},
				upToDate: true,
				zelfName: tagName,
				tagName,
				domain,
				primaryUrl,
				zelfLinkUrls: buildArnsUndernameUrls(tagName, domain),
			};
		}

		return {
			success: true,
			exists: false,
			record: null,
			zelfName: tagName,
			tagName,
			domain,
			primaryUrl,
			zelfLinkUrls: buildArnsUndernameUrls(tagName, domain),
		};
	}

	const recordKey = domain === "zelf" ? `${tagName}` : `${tagName}_${domain}`;

	// Find the specific record by undername
	const record = records[recordKey] || null;

	if (!record) {
		return {
			success: true,
			exists: false,
			record: null,
			zelfName: tagName,
			tagName,
			domain,
			primaryUrl,
			zelfLinkUrls: buildArnsUndernameUrls(tagName, domain),
		};
	}

	return {
		success: true,
		exists: true,
		record: record,
		upToDate: record.transactionId === mappingOfSitesRef[domain],
		zelfName: tagName,
		tagName,
		domain,
		primaryUrl,
		zelfLinkUrls: buildArnsUndernameUrls(tagName, domain),
	};
};

/**
 * Create a new AR-IO ARN
 * @param {Object} data - ARN data to create
 * @param {Object} authUser - Authenticated user object
 * @returns {Promise<Object>} Created ARN data
 */
const create = async (data, authUser = {}) => {
	const tagName = data.zelfName.split(".")[0];
	const domain = data.zelfName.split(".")[1];

	const zelfName = await _validateTagName(data.zelfName.split(".")[0], data.zelfName.split(".")[1], authUser);
	const primaryUrl = (await resolveZelfLink(tagName, domain)).url;
	const recordKey = domain === "zelf" ? `${tagName}` : `${tagName}_${domain}`;
	const transactionId = resolveExpectedTransactionId(recordKey);

	let ant;
	let records = {};
	try {
		ant = initAnt();
		records = (await ant.getRecords()) || {};
	} catch (error) {
		// If dryrun fails (CU whitelist/outage), check if the gateway already serves it
		const gatewayResolves = await _checkGatewayUrl(primaryUrl);
		if (gatewayResolves) {
			return {
				success: true,
				exists: true,
				record: { transactionId, ttlSeconds: 3600 },
				upToDate: true,
				zelfName,
				tagName,
				domain,
				primaryUrl,
				zelfLinkUrls: buildArnsUndernameUrls(tagName, domain),
			};
		}
	}

	if (records[recordKey] && records[recordKey].transactionId === transactionId) {
		return {
			success: true,
			exists: true,
			record: records[recordKey],
			upToDate: records[recordKey].transactionId === transactionId,
			zelfName,
			tagName,
			domain,
			primaryUrl,
			zelfLinkUrls: buildArnsUndernameUrls(tagName, domain),
		};
	}

	if (!ant) ant = initAnt();
	const record = await setAntRecord({
		ant,
		recordKey,
		transactionId,
		ttlSeconds: 3600,
	});

	return {
		...record,
		primaryUrl,
		zelfLinkUrls: buildArnsUndernameUrls(tagName, domain),
	};
};

const _validateTagName = async (tagName, domain, authUser) => {
	const tagResult = await TagsSearchModule.searchTag(
		{
			tagName,
			domain,
			environment: "all",
			type: "mainnet",
		},
		authUser
	);

	if (!tagResult.tagObject) throw new Error("404:not_found_in_arweave");

	return {
		tagObject: tagResult.tagObject,
		tagName,
		domain,
	};
};

module.exports = {
	get,
	create,
};
