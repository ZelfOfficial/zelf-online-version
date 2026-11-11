const { isRemovedRecordKey } = require("../../../Core/removed-blockdag");
const { buildArnsUndernameUrl } = require("./arweave-gateway.module");
const {
	initAnt,
	resolveExpectedTransactionId,
	parseRecordKey,
	setAntRecord,
} = require("./ar-io-arns-shared.module");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * List ANT records with expected tx ids and arweave.net URLs.
 * @returns {Promise<Array<Object>>}
 */
const listRecordsForMigration = async () => {
	const ant = initAnt();
	const records = await ant.getRecords();
	const keys = Object.keys(records || {})
		.filter((recordKey) => !isRemovedRecordKey(recordKey))
		.sort();

	return keys.map((recordKey) => {
		const current = records[recordKey];
		const expectedTxId = resolveExpectedTransactionId(recordKey);
		const { tagName, domain } = parseRecordKey(recordKey);
		const primaryUrl = recordKey === "@" ? null : buildArnsUndernameUrl(tagName, domain);

		return {
			recordKey,
			tagName,
			domain,
			currentTransactionId: current?.transactionId || null,
			expectedTransactionId: expectedTxId,
			needsUpdate: Boolean(current?.transactionId && current.transactionId !== expectedTxId),
			primaryUrl,
			ttlSeconds: current?.ttlSeconds ?? null,
		};
	});
};

/**
 * Refresh ANT undername records on-chain so gateways pick up arweave.net routing.
 * Re-broadcasts setRecord for each key (same or corrected transactionId).
 *
 * @param {Object} [options]
 * @param {boolean} [options.dryRun=true]
 * @param {number} [options.delayMs=2000] - pause between on-chain writes
 * @param {string} [options.filter] - only migrate keys containing this substring
 * @param {boolean} [options.onlyStale=false] - skip records already on expected tx id
 * @param {boolean} [options.includeBase=true] - include @ base record
 * @returns {Promise<{ dryRun: boolean, planned: number, updated: number, skipped: number, results: Array }>}
 */
const migrateAllUndernameRecords = async (options = {}) => {
	const {
		dryRun = true,
		delayMs = 2000,
		filter = "",
		onlyStale = false,
		includeBase = true,
	} = options;

	const ant = initAnt();
	const inventory = await listRecordsForMigration();
	const filterLower = filter.trim().toLowerCase();

	let candidates = inventory.filter((row) => includeBase || row.recordKey !== "@");
	if (filterLower) {
		candidates = candidates.filter((row) => row.recordKey.toLowerCase().includes(filterLower));
	}
	if (onlyStale) {
		candidates = candidates.filter((row) => row.needsUpdate);
	}

	const results = [];
	let updated = 0;
	let skipped = 0;

	for (let index = 0; index < candidates.length; index++) {
		const row = candidates[index];
		const transactionId = row.expectedTransactionId;

		if (dryRun) {
			results.push({
				recordKey: row.recordKey,
				status: "planned",
				transactionId,
				primaryUrl: row.primaryUrl,
				previousTransactionId: row.currentTransactionId,
				needsUpdate: row.needsUpdate,
			});
			continue;
		}

		try {
			const response = await setAntRecord({
				ant,
				recordKey: row.recordKey,
				transactionId,
				ttlSeconds: 3600,
			});

			updated++;
			results.push({
				recordKey: row.recordKey,
				status: "updated",
				transactionId,
				primaryUrl: row.primaryUrl,
				previousTransactionId: row.currentTransactionId,
				messageId: response?.id || response?.messageId || null,
			});
		} catch (error) {
			skipped++;
			results.push({
				recordKey: row.recordKey,
				status: "error",
				transactionId,
				primaryUrl: row.primaryUrl,
				previousTransactionId: row.currentTransactionId,
				error: error?.message || String(error),
			});
		}

		if (!dryRun && index < candidates.length - 1 && delayMs > 0) {
			await sleep(delayMs);
		}
	}

	return {
		dryRun,
		planned: candidates.length,
		updated,
		skipped,
		results,
	};
};

module.exports = {
	listRecordsForMigration,
	migrateAllUndernameRecords,
};
