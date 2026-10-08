const { addressLookupValues } = require("./ton-address-lookup.util");
const IPFS = require("../../../Core/ipfs");
const config = require("../../../Core/config");
const { getDomainConfig } = require("../config/supported-domains");
const { generateStorageKey } = require("./domain-registry.module");
const {
    CONTINUATION_LINK_KEY,
    CONTINUATION_LINK_KEY_2,
    buildSearchablePinPages,
    extractAddressKeyvaluesFromPublicData,
    getContinuationCanonicalName,
    isContinuationPublicData,
    isPackedAddressPublicData,
    mergeAddressKeyvaluesIntoPublicData,
    mergeContinuationAddresses,
    buildUpsertPrimarySearchableKeyvalues,
    expandPackedAddresses,
} = require("./tags-addresses.module");

/**
 * Tags IPFS Module
 *
 * This module handles IPFS operations for the Tags system with multi-domain support.
 * It extends the existing IPFS functionality to work with different domain types
 * and .hold states while maintaining compatibility with existing ZNS logic.
 */

/** Record types stored by Zelf Keys (see Repositories/ZelfKeys). */
const ZELF_KEYS_RECORD_TYPES = new Set(["password", "notes", "note", "credit_card", "payment-card", "contact", "zotp"]);

const isZelfKeysRecord = (item = {}) => {
	const keyvalues = item.keyvalues || item.metadata?.keyvalues || {};
	return ZELF_KEYS_RECORD_TYPES.has(String(keyvalues.type || "").toLowerCase());
};

/**
 * Get tag data from IPFS
 * @param {Object} data - Search parameters
 * @param {string} data.tagName - Tag name (e.g., "username.avax")
 * @param {string} data.domain - Domain name (e.g., "avax")
 * @param {string} data.key - Search key
 * @param {string} data.value - Search value
 * @param {string} data.cid - IPFS CID
 * @param {string} data.expires - Expiration date
 * @returns {Object} - IPFS data
 */
const get = async (data) => {
	const { cid, tagName, domain, key, value, expires, domainConfig, includeAllAddressPages } = data;

	if (cid) return await IPFS.retrieve(cid, expires);

	let result = [];

	if (tagName) {
		const storageKey = domainConfig ? domainConfig.tags.storage.keyPrefix : generateStorageKey(domain);

		result = await IPFS.filter(storageKey, tagName, { throwOnError: true });

		// Fallback for legacy tags: tags pinned under ZNS or older schemas used 'zelfName' or Pinata file 'name'
		if (!result.length && storageKey !== "zelfName") {
			result = await IPFS.filter("zelfName", tagName, { throwOnError: true });
		}

		if (!result.length) {
			const byName = await IPFS.filter("name", tagName, { throwOnError: true });
			const lowerTag = tagName.toLowerCase();
			result = (byName || []).filter((item) => {
				// Zelf Keys items are pinned as `<zelfName>_<suffix>` too; they are not the tag.
				if (isZelfKeysRecord(item)) return false;

				const n = String(item.name || "").toLowerCase();
				return (
					n === lowerTag ||
					n === `${lowerTag}.hold` ||
					n === `${lowerTag}.png` ||
					n.startsWith(`${lowerTag}_`) ||
					n.startsWith(`${lowerTag}.`)
				);
			});
		}
	} else if (key && value) {
		const values = addressLookupValues(key, value);
		result = (await Promise.all(values.map((address) => IPFS.filter(key, address, { throwOnError: true })))).flat();
	}

	const formatted = _formatSearchResults(result).filter((row) => {
		if (!isContinuationPublicData(row.publicData)) return true;
		return Boolean(key && value);
	});

	const resolved = [];

	for (const row of formatted) {
		if (isContinuationPublicData(row.publicData)) {
			const primary = await _resolveContinuationToPrimary(row);
			resolved.push(includeAllAddressPages ? await _mergeAllContinuationPages(primary) : primary);
			continue;
		}

		if (includeAllAddressPages) {
			resolved.push(await _mergeAllContinuationPages(row));
			continue;
		}

		resolved.push(row);
	}

	return resolved;
};

const _formatRecord = (item) => {
	const formattedResult = {
		id: item.id || item.ID,
		url: item.url,
		ipfs_pin_hash: item.ipfs_pin_hash || item.ipfsHash || item.cid,
		ipfsHash: item.ipfs_pin_hash || item.ipfsHash || item.cid,
		cid: item.ipfs_pin_hash || item.ipfsHash || item.cid,
		size: item.size || item.PinSize,
		user_id: item.user_id,
		date_pinned: item.date_pinned || item.Timestamp || item.created_at,
		date_unpinned: item.date_unpinned,
		publicData: item.publicData || item.metadata?.keyvalues || item.metadata || item.keyvalues,
		network: item.network,
		pinned: item.pinned,
		duplicated: item.is_duplicate,
		saved: !Boolean(item.is_duplicate),
		web3: item.web3,
		name: item.name,
		metadata: item.metadata,
		created_at: item.created_at,
		updated_at: item.updated_at,
		deleted_at: item.deleted_at,
	};

	if (formattedResult?.publicData?.extraParams) {
		const extraParams = JSON.parse(formattedResult.publicData.extraParams);

		Object.assign(formattedResult.publicData, extraParams);

		delete formattedResult.publicData.extraParams;
	}

	if (formattedResult?.publicData) {
		if (isPackedAddressPublicData(formattedResult.publicData)) {
			formattedResult.publicData._needsPinSplit = true;
		}

		mergeAddressKeyvaluesIntoPublicData(formattedResult.publicData);
	}

	if (formattedResult?.publicData?.referral) {
		const referral = JSON.parse(formattedResult.publicData.referral);

		formattedResult.publicData.referralTagName = referral.tagName;

		formattedResult.publicData.referralSolanaAddress = referral.solanaAddress;

		delete formattedResult.publicData.referral;
	}

	if (formattedResult.publicData?.ethAddress) {
		formattedResult.publicData.blockDAGAddress = formattedResult.publicData.ethAddress;

		formattedResult.publicData.avalancheAddress = formattedResult.publicData.ethAddress;
	}

	// Legacy: historical IPFS payloads stored Coinbase Commerce checkout JSON as `coinBase`.
	if (formattedResult?.publicData?.coinBase) {
		delete formattedResult.publicData.coinBase;
	}

	if (formattedResult?.publicData) {
		delete formattedResult.publicData.coinbase_hosted_url;
		delete formattedResult.publicData.coinbase_expires_at;

		if (!formattedResult.publicData.tagName && formattedResult.publicData.zelfName) {
			formattedResult.publicData.tagName = formattedResult.publicData.zelfName;
		}
	}

	return formattedResult;
};

const _lookupPrimaryByCanonicalName = async (canonicalName) => {
	if (!canonicalName) return null;

	const byTagName = await IPFS.filter("tagName", canonicalName, { throwOnError: true });
	if (byTagName?.[0]) return _formatRecord(byTagName[0]);

	const byZelfName = await IPFS.filter("zelfName", canonicalName, { throwOnError: true });
	if (byZelfName?.[0]) return _formatRecord(byZelfName[0]);

	return null;
};

const _resolveContinuationToPrimary = async (continuationRow) => {
	const canonicalName = getContinuationCanonicalName(continuationRow.publicData);
	const primary = await _lookupPrimaryByCanonicalName(canonicalName);

	if (!primary) return continuationRow;

	mergeContinuationAddresses(primary.publicData, continuationRow.publicData);
	return primary;
};

const _mergeAllContinuationPages = async (primaryRow) => {
	let record = primaryRow;

	if (isContinuationPublicData(record.publicData)) {
		record = await _resolveContinuationToPrimary(record);
	}

	const canonicalName =
		getContinuationCanonicalName(record.publicData) ||
		record.publicData?.tagName ||
		record.publicData?.zelfName ||
		record.name;

	if (!canonicalName) return record;

	for (const linkKey of [CONTINUATION_LINK_KEY, CONTINUATION_LINK_KEY_2]) {
		const rows = await IPFS.filter(linkKey, canonicalName);
		if (!rows?.[0]) continue;
		mergeContinuationAddresses(record.publicData, _formatRecord(rows[0]).publicData);
	}

	return record;
};

/**
 * Copy overflow-page addresses onto primary publicData when `_tagName` / `__tagName` pins exist.
 * Decrypt backfill must see aptos/dot/ksm that lease already wrote on continuation pages.
 * @param {Object} publicData
 * @returns {Promise<Object>}
 */
const hydrateContinuationAddresses = async (publicData) => {
	if (!publicData || typeof publicData !== "object") return publicData;

	try {
		await _mergeAllContinuationPages({
			publicData,
			name: publicData.tagName || publicData.zelfName,
		});
	} catch {
		/* keep primary publicData if continuation lookup fails */
	}

	return publicData;
};

const _formatSearchResults = (result) => {
	const formattedResults = [];

	for (let index = 0; index < result.length; index++) {
		const item = result[index];

		formattedResults.push(_formatRecord(item));
	}

	return formattedResults;
};

/**
 * True if a pin belongs to the licensed domain. Metadata `domain` is set on many
 * pins but `.zelfpay` / similar often omit it while `name` / zelfName carry the suffix.
 * @param {Object} row - formatted record from _formatRecord
 * @param {string} domainLower - e.g. "zelf", "bdag"
 */
const _rowBelongsToDomain = (row, domainLower) => {
	const metaDomain = String(row.publicData?.domain || "").toLowerCase();
	if (metaDomain === domainLower) return true;

	const label = String(row.name || row.publicData?.zelfName || "").toLowerCase();
	if (!label) return false;

	if (label.endsWith(`.${domainLower}pay`)) return true;
	if (label.endsWith(`.${domainLower}`)) return true;
	if (label.includes(`.${domainLower}.`)) return true;

	return false;
};

/**
 * Show tag file from IPFS
 * @param {Object} data - File parameters
 * @param {string} data.cid - IPFS CID
 * @param {Object} authUser - Authenticated user
 * @returns {Object} - IPFS file data
 */
const show = async (data, authUser) => {
	const { cid } = data;

	try {
		const file = await IPFS.retrieve(cid);
		return file;
	} catch (exception) {
		const error = new Error("file_not_found");
		error.status = 404;
		throw error;
	}
};

/**
 * Insert tag data into IPFS
 * @param {Object} data - Tag data
 * @param {string} data.base64 - Base64 encoded data
 * @param {Object} data.metadata - Tag metadata
 * @param {string} data.name - Tag name
 * @param {boolean} data.pinIt - Whether to pin the file
 * @param {string} data.domain - Domain name
 * @param {Object} authUser - Authenticated user
 * @returns {Object} - IPFS upload result
 */
const insert = async (data, authUser) => {
	const { base64, metadata, name, pinIt } = data;

	if ((authUser.pro || config.env === "development") && pinIt) return await IPFS.pinFile(base64, name, null, metadata);

	return await IPFS.upload(base64, name, null, metadata);
};

/**
 * Pin a primary record plus any overflow address pages that share the same QR.
 * @param {Object} data
 * @param {string} data.base64
 * @param {Object} data.reserved
 * @param {Object} data.addresses
 * @param {string} data.name
 * @param {boolean} data.pinIt
 * @param {Object} authUser
 * @returns {Object} formatted primary pin
 */
const insertSearchablePins = async (data, authUser) => {
	const { base64, reserved, addresses, name, pinIt } = data;
	const pages = buildSearchablePinPages({
		reserved,
		addresses: addresses || extractAddressKeyvaluesFromPublicData(data.addressSource || {}),
		tagName: name,
	});

	const primary = await insert(
		{
			base64,
			name: pages.primary.name,
			metadata: pages.primary.keyvalues,
			pinIt,
		},
		authUser
	);

	for (const page of pages.continuations) {
		await insert(
			{
				base64,
				name: page.name,
				metadata: page.keyvalues,
				pinIt,
			},
			authUser
		);
	}

	const formatted = _formatRecord(primary);
	for (const page of pages.continuations) {
		mergeContinuationAddresses(formatted.publicData, page.keyvalues);
	}
	return formatted;
};

const _findContinuationPinRow = async (page) => {
	const byName = await IPFS.filter("name", page.name);
	if (byName?.length) {
		const exact = byName.find((row) => String(row.name || "").toLowerCase() === String(page.name).toLowerCase());
		if (exact) return exact;
		return byName[0];
	}

	const linkValue = page.keyvalues?.[page.linkKey];
	if (page.linkKey && linkValue) {
		const rows = await IPFS.filter(page.linkKey, linkValue);
		if (rows?.length) {
			const exact = rows.find((row) => String(row.name || "").toLowerCase() === String(page.name).toLowerCase());
			return exact || rows[0];
		}
	}

	return null;
};

/**
 * Update searchable pin metadata when the QR bytes are unchanged (Pinata CID dedupe).
 * Falls back to {@link insertSearchablePins} when no existing primary pin id is known.
 *
 * @param {Object} data
 * @param {string} [data.existingPrimaryPinId]
 * @param {string} data.base64
 * @param {Object} data.reserved
 * @param {Object} data.addresses
 * @param {string} data.name
 * @param {boolean} data.pinIt
 * @param {Object} authUser
 * @returns {Promise<Object>}
 */
const _continuationPlaceholderBase64 = (canonicalName, pageIndex) => {
	const payload = JSON.stringify({
		_zelfAddressContinuation: true,
		tagName: canonicalName,
		page: pageIndex,
		ts: Date.now(),
	});
	return `data:application/json;base64,${Buffer.from(payload).toString("base64")}`;
};

const _publicDataFromKeyvalues = (keyvalues = {}) => {
	const publicData = { ...keyvalues };
	mergeAddressKeyvaluesIntoPublicData(publicData);
	expandPackedAddresses(publicData);
	return publicData;
};

const upsertSearchablePins = async (data, authUser) => {
	const { base64, reserved, addresses, name, pinIt, existingPrimaryPinId } = data;
	const addressMap = addresses || extractAddressKeyvaluesFromPublicData(data.addressSource || {});
	const packedPrimaryKeyvalues = buildUpsertPrimarySearchableKeyvalues(reserved, addressMap);
	const pages = buildSearchablePinPages({
		reserved,
		addresses: addressMap,
		tagName: name,
	});

	let primaryPinId = existingPrimaryPinId || null;
	let primaryRow = null;

	if (primaryPinId) {
		primaryRow = await IPFS.updateFileKeyvalues(existingPrimaryPinId, packedPrimaryKeyvalues);
		primaryRow = { ...primaryRow, name };
	} else {
		const inserted = await insert(
			{
				base64,
				name,
				metadata: packedPrimaryKeyvalues,
				pinIt,
			},
			authUser
		);

		primaryPinId = inserted?.id || null;
		if (primaryPinId && existingPrimaryPinId && inserted?.id === existingPrimaryPinId) {
			primaryRow = await IPFS.updateFileKeyvalues(existingPrimaryPinId, packedPrimaryKeyvalues);
			primaryRow = { ...primaryRow, name };
		} else {
			primaryRow = inserted;
		}
	}

	const packedPublic = _publicDataFromKeyvalues(packedPrimaryKeyvalues);
	const needsContinuationPages = pages.continuations.some((page) =>
		Object.keys(page.keyvalues).some((key) => {
			if (key === CONTINUATION_LINK_KEY || key === CONTINUATION_LINK_KEY_2) return false;
			const appKey = key.endsWith("Address") ? key : null;
			return appKey && addressMap[appKey] && !packedPublic[appKey];
		})
	);

	if (needsContinuationPages) {
		for (let pageIndex = 0; pageIndex < pages.continuations.length; pageIndex += 1) {
			const page = pages.continuations[pageIndex];
			const existing = await _findContinuationPinRow(page);
			if (existing?.id) {
				if (existing.id !== primaryPinId) {
					await IPFS.updateFileKeyvalues(existing.id, page.keyvalues);
				}
				continue;
			}

			const placeholder = _continuationPlaceholderBase64(name, pageIndex);
			const inserted = await insert(
				{
					base64: placeholder,
					name: page.name,
					metadata: page.keyvalues,
					pinIt,
				},
				authUser
			);

			if (inserted?.id && inserted.id !== primaryPinId) {
				await IPFS.updateFileKeyvalues(inserted.id, page.keyvalues);
			}
		}
	}

	let formatted = _formatRecord(primaryPinId ? await IPFS.getFileById(primaryPinId) : primaryRow);
	formatted = await _mergeAllContinuationPages(formatted);
	return formatted;
};

const unpinContinuationSiblings = async (canonicalName) => {
	if (!canonicalName) return null;

	const ids = [];

	for (const linkKey of [CONTINUATION_LINK_KEY, CONTINUATION_LINK_KEY_2]) {
		const rows = await IPFS.filter(linkKey, canonicalName);
		for (const row of rows || []) {
			const id = row.ipfs_pin_hash || row.IpfsHash || row.id;
			if (id) ids.push(id);
		}
	}

	if (!ids.length) return null;

	return unPinFiles(ids);
};

/**
 * Insert tag data into IPFS
 * @param {Object} data - Tag data
 * @param {string} data.base64 - Base64 encoded data
 * @param {Object} data.metadata - Tag metadata
 * @param {string} data.name - Tag name
 * @param {boolean} data.pinIt - Whether to pin the file
 * @param {string} data.domain - Domain name
 * @param {Object} authUser - Authenticated user
 * @returns {Object} - IPFS upload result
 */
const tagRegistration = async (data, authUser) => {
	const { base64, metadata, name, pinIt } = data;

	let record = null;
	if ((authUser.pro || config.env === "development") && pinIt) {
		record = await IPFS.pinFile(base64, name, null, metadata);
	} else {
		record = await IPFS.upload(base64, name, null, metadata);
	}

	return _formatRecord(record);
};

/**
 * Unpin tag files from IPFS
 * @param {Array} ids - Array of IPFS CIDs to unpin
 * @returns {Object} - Unpin result
 */
const unPinFiles = async (ids = []) => {
	try {
		const unpinnedFiles = await IPFS.deleteFiles(ids);

		return unpinnedFiles;
	} catch (exception) {
		console.error("Error unpinning files:", exception);
		return null;
	}
};

/**
 * Search for tags by domain
 * @param {Object} params - Search parameters
 * @param {string} params.domain - Domain name
 * @param {Object} authUser - Authenticated user
 * @returns {Array} - Search results
 */
const searchByDomain = async (params, authUser) => {
	const { domain, limit, pageOffset, name } = params;

	const domainConfig = getDomainConfig(domain);

	if (!domainConfig) throw new Error("Domain not supported");

	// Default to 50 records, support 25, 50, 100, 250, 500; cap matches Core/ipfs filter SAFETY_CAP
	const paginationOptions = {
		limit: limit ? parseInt(limit, 10) : 50,
		pageOffset: pageOffset ? parseInt(pageOffset, 10) : 0,
	};

	const namePattern = typeof name === "string" ? name.trim() : "";

	if (namePattern) {
		const records = await IPFS.filter("name", namePattern, paginationOptions);
		const formatted = _formatSearchResults(records);
		const domainLower = String(domain).toLowerCase();
		return formatted.filter((row) => !isContinuationPublicData(row.publicData) && _rowBelongsToDomain(row, domainLower));
	}

	const records = await IPFS.filter("domain", domain, paginationOptions);

	return _formatSearchResults(records).filter((row) => !isContinuationPublicData(row.publicData));
};

/**
 * Search for tags by storage key
 * @param {Object} params - Search parameters
 * @param {string} params.domain - Domain name
 * @param {string} params.name - Tag name
 * @param {Object} authUser - Authenticated user
 * @returns {Array} - Search results
 */
const searchByStorageKey = async (params, authUser) => {
	const { domain, name } = params;

	// Generate domain-specific storage key
	const storageKey = generateStorageKey(domain, name);

	return await IPFS.filter("storageKey", storageKey);
};

/**
 * Get hold domain data
 * @param {Object} params - Search parameters
 * @param {string} params.domain - Domain name
 * @param {string} params.name - Tag name
 * @param {Object} authUser - Authenticated user
 * @returns {Array} - Hold domain data
 */
const getHoldDomain = async (params, authUser) => {
	const { domain, name } = params;

	// Get domain configuration
	const domainConfig = getDomainConfiguration(domain);
	const holdSuffix = domainConfig?.holdSuffix || ".hold";

	// Generate hold domain name
	const holdDomain = `${name}${holdSuffix}.${domain}`;

	// Search for hold domain data
	return await IPFS.filter("name", holdDomain);
};

/**
 * Insert hold domain data
 * @param {Object} data - Hold domain data
 * @param {string} data.base64 - Base64 encoded data
 * @param {Object} data.metadata - Hold domain metadata
 * @param {string} data.name - Tag name
 * @param {string} data.domain - Domain name
 * @param {boolean} data.pinIt - Whether to pin the file
 * @param {Object} authUser - Authenticated user
 * @returns {Object} - IPFS upload result
 */
const insertHoldDomain = async (data, authUser) => {
	const { base64, metadata, name, domain, pinIt } = data;

	// Get domain configuration
	const domainConfig = getDomainConfiguration(domain);
	const holdSuffix = domainConfig?.holdSuffix || ".hold";

	// Generate hold domain name
	const holdDomain = `${name}${holdSuffix}.${domain}`;

	// Generate storage key for hold domain
	const storageKey = generateStorageKey(domain, `${name}${holdSuffix}`);

	// Enhanced metadata for hold domain
	const enhancedMetadata = {
		...metadata,
		storageKey,
		domain,
		holdDomain,
		holdSuffix,
		domainConfig: domainConfig?.type || "custom",
		timestamp: new Date().toISOString(),
		status: "hold",
	};

	// Check if user has pro access or is in development
	if ((authUser.pro || config.env === "development") && pinIt) {
		return await IPFS.pinFile(base64, holdDomain, null, enhancedMetadata);
	}

	return await IPFS.upload(base64, holdDomain, null, enhancedMetadata);
};

/**
 * Update tag data in IPFS
 * @param {Object} data - Tag data
 * @param {string} data.base64 - Base64 encoded data
 * @param {Object} data.metadata - Tag metadata
 * @param {string} data.name - Tag name
 * @param {string} data.domain - Domain name
 * @param {boolean} data.pinIt - Whether to pin the file
 * @param {Object} authUser - Authenticated user
 * @returns {Object} - IPFS upload result
 */
const update = async (data, authUser) => {
	const { base64, metadata, name, domain, pinIt } = data;

	// Get domain configuration
	const domainConfig = getDomainConfiguration(domain);

	// Generate domain-specific storage key
	const storageKey = generateStorageKey(domain, name);

	// Enhanced metadata with update information
	const enhancedMetadata = {
		...metadata,
		storageKey,
		domain,
		domainConfig: domainConfig?.type || "custom",
		timestamp: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
	};

	// Check if user has pro access or is in development
	if ((authUser.pro || config.env === "development") && pinIt) {
		return await IPFS.pinFile(base64, `${name}.${domain}`, null, enhancedMetadata);
	}

	return await IPFS.upload(base64, `${name}.${domain}`, null, enhancedMetadata);
};

/**
 * Get domain statistics from IPFS
 * @param {string} domain - Domain name
 * @param {Object} authUser - Authenticated user
 * @returns {Object} - Domain statistics
 */
const getDomainStats = async (domain, authUser) => {
	try {
		// Get all tags for this domain
		const domainTags = await IPFS.filter("domain", domain);

		// Get hold domains for this domain
		const holdDomains = await IPFS.filter("holdSuffix", ".hold");
		const domainHoldDomains = holdDomains.filter((tag) => tag.metadata?.domain === domain);

		return {
			domain,
			totalTags: domainTags.length,
			holdDomains: domainHoldDomains.length,
			activeTags: domainTags.length - domainHoldDomains.length,
		};
	} catch (exception) {
		console.error("Error getting domain stats:", exception);
		return {
			domain,
			totalTags: 0,
			holdDomains: 0,
			activeTags: 0,
		};
	}
};

const deleteFiles = async (ids = []) => {
	try {
		const deletedFiles = await IPFS.deleteFiles(ids);

		return deletedFiles;
	} catch (exception) {
		console.error("Error deleting files:", exception);
	}

	return null;
};

/**
 * Best-effort recency timestamp for a formatted IPFS pin row (newest renewals first).
 * @param {Object} row
 * @returns {number}
 */
const _ipfsRowRecencyMs = (row) => {
	if (!row || typeof row !== "object") return 0;
	const candidates = [row.date_pinned, row.Timestamp, row.created_at, row.updated_at];
	for (let i = 0; i < candidates.length; i++) {
		const c = candidates[i];
		if (c == null || c === "") continue;
		if (typeof c === "number" && Number.isFinite(c)) return c;
		const n = Date.parse(String(c));
		if (Number.isFinite(n)) return n;
	}
	return 0;
};

/**
 * Sort newest-first and dedupe by pin id / CID so stale duplicates from renewals do not win.
 * @param {Array<Object>} rows - formatted rows from get() / _formatSearchResults
 * @returns {Array<Object>}
 */
const sortDedupeIpfsSearchResults = (rows) => {
	if (!Array.isArray(rows) || rows.length === 0) return rows || [];

	const sorted = [...rows].sort((a, b) => _ipfsRowRecencyMs(b) - _ipfsRowRecencyMs(a));
	const seen = new Set();
	const out = [];

	for (let i = 0; i < sorted.length; i++) {
		const row = sorted[i];
		const key = String(row.ipfsHash || row.cid || row.ipfs_pin_hash || row.id || "").trim();
		const dedupeKey = key || `__noid_${i}`;
		if (seen.has(dedupeKey)) continue;
		seen.add(dedupeKey);
		out.push(row);
	}

	return out.sort((a, b) => _ipfsRowRecencyMs(b) - _ipfsRowRecencyMs(a));
};

module.exports = {
	get,
	hydrateContinuationAddresses,
	show,
	insert,
	insertSearchablePins,
	upsertSearchablePins,
	tagRegistration,
	unPinFiles,
	unpinContinuationSiblings,
	searchByDomain,
	searchByStorageKey,
	getHoldDomain,
	insertHoldDomain,
	update,
	getDomainStats,
	formatResults: _formatSearchResults,
	formatRecord: _formatRecord,
	deleteFiles,
	sortDedupeIpfsSearchResults,
};
