const config = require("../../../Core/config");
const solanaAnt = require("./solana-ant.client");

const mappingOfSites = {
	bdag: config.arns.blockdag_transaction_id,
	socials: config.arns.socials_transaction_id,
	zelf: config.arns.index_transaction_id,
};

const buildWalletKey = () => ({
	kty: "RSA",
	n: config.arwave.n,
	e: config.arwave.e,
	d: config.arwave.d,
	p: config.arwave.p,
	q: config.arwave.q,
	dp: config.arwave.dp,
	dq: config.arwave.dq,
	qi: config.arwave.qi,
	kid: "2011-04-29",
});

const initAnt = () => ({
	getRecords: () => solanaAnt.getRecords(),
});

/**
 * Map ANT record key to domain (zelf, bdag, …).
 * @param {string} recordKey
 * @returns {string}
 */
const resolveDomainForRecordKey = (recordKey) => {
	if (!recordKey || recordKey === "@") return "zelf";

	const suffixDomains = Object.keys(mappingOfSites)
		.filter((domain) => domain !== "zelf")
		.sort((left, right) => right.length - left.length);
	for (let index = 0; index < suffixDomains.length; index++) {
		const domain = suffixDomains[index];
		if (recordKey.endsWith(`_${domain}`)) return domain;
	}

	return "zelf";
};

/**
 * Expected manifest/index transaction id for an ANT record key.
 * @param {string} recordKey
 * @returns {string}
 */
const resolveExpectedTransactionId = (recordKey) => {
	const domain = resolveDomainForRecordKey(recordKey);
	return mappingOfSites[domain] || config.arns.index_transaction_id;
};

/**
 * Parse record key into tagName + domain for URL logging.
 * @param {string} recordKey
 * @returns {{ tagName: string, domain: string }}
 */
const parseRecordKey = (recordKey) => {
	if (recordKey === "@") return { tagName: "@", domain: "zelf" };

	const domain = resolveDomainForRecordKey(recordKey);
	if (domain === "zelf") return { tagName: recordKey, domain: "zelf" };

	const suffix = `_${domain}`;
	return {
		tagName: recordKey.slice(0, -suffix.length),
		domain,
	};
};

/**
 * Write or refresh a single ANT undername record on-chain.
 * @param {Object} params
 * @param {import('@ar.io/sdk').ANT} [params.ant]
 * @param {string} params.recordKey
 * @param {string} [params.transactionId]
 * @param {number} [params.ttlSeconds]
 * @returns {Promise<Object>}
 */
const setAntRecord = async ({ recordKey, transactionId, ttlSeconds = 3600 }) => {
	const txId = transactionId || resolveExpectedTransactionId(recordKey);
	return solanaAnt.setRecord({ recordKey, transactionId: txId, ttlSeconds });
};

module.exports = {
	mappingOfSites,
	buildWalletKey,
	initAnt,
	resolveDomainForRecordKey,
	resolveExpectedTransactionId,
	parseRecordKey,
	setAntRecord,
};
