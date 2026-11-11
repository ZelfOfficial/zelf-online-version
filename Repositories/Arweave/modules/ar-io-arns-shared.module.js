const { ArweaveSigner, ANT } = require("@ar.io/sdk");
const config = require("../../../Core/config");

const mappingOfSites = {
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

const initAnt = () => {
	const walletKey = buildWalletKey();
	return ANT.init({
		signer: new ArweaveSigner(walletKey),
		processId: config.arns.processId,
	});
};

/**
 * Map ANT record key to domain (zelf, and any other suffix still registered in mappingOfSites).
 * @param {string} recordKey
 * @returns {string}
 */
const resolveDomainForRecordKey = (recordKey) => {
	if (!recordKey || recordKey === "@") return "zelf";

	const suffixDomains = Object.keys(mappingOfSites).filter((d) => d !== "zelf");
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
const setAntRecord = async ({ ant, recordKey, transactionId, ttlSeconds = 3600 }) => {
	const client = ant || initAnt();
	const txId = transactionId || resolveExpectedTransactionId(recordKey);

	if (recordKey === "@") {
		if (typeof client.setBaseNameRecord === "function") {
			return client.setBaseNameRecord({ transactionId: txId, ttlSeconds });
		}
		return client.setRecord({ undername: "@", transactionId: txId, ttlSeconds }, { tags: [] });
	}

	if (typeof client.setUndernameRecord === "function") {
		return client.setUndernameRecord({ undername: recordKey, transactionId: txId, ttlSeconds });
	}

	return client.setRecord({ undername: recordKey, transactionId: txId, ttlSeconds }, { tags: [] });
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
