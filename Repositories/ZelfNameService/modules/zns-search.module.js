const moment = require("moment");
const { parseLeaseDate } = require("../../Tags/modules/lease-date.util");
const ArweaveModule = require("../../Arweave/modules/arweave.module");
const IPFSModule = require("../../IPFS/modules/ipfs.module");
const ZNSPartsModule = require("./zns-parts.module");
const WalrusModule = require("../../Walrus/modules/walrus.module");

/**
 * Main search function for ZelfNames
 * @param {Object} params - Search parameters
 * @param {Object} authUser - Authenticated user object
 * @returns {Object} Search results from different sources
 */
const searchZelfName = async (params, authUser) => {
	// check if its missing .zelf extension if so, add it
	if (params.zelfName && !params.zelfName?.includes(".zelf") && !params.zelfName?.endsWith(".zelfpay")) {
		params.zelfName = `${params.zelfName}.zelf`;
	}

	const query = params.zelfName ? { key: "zelfName", value: params.zelfName } : { key: params.key, value: params.value };

	query.value = query.key === "zelfName" ? query.value.toLowerCase() : query.value;

	if (params.duration) query.duration = params.duration;

	const searchResult = {
		arweave: await _searchInArweave(query),
	};

	// Search in primary source (Arweave)
	searchResult.ipfs = params.environment === "arweave" ? [] : await _searchInIPFS(params.environment, query, authUser, true);

	if (searchResult.ipfs?.available) return searchResult.ipfs;

	searchResult.ipfs = searchResult.ipfs;

	return searchResult;

	/*
	{
		"success": true,
		"blobId": "fSWx7-xmJKC7L7JqWKGngAVrYtkwkZ8hhvY1IK3fNxI",
		"publicUrl": "https://aggregator.walrus.space/fSWx7-xmJKC7L7JqWKGngAVrYtkwkZ8hhvY1IK3fNxI",
		"explorerUrl": "https://walruscan.com/mainnet/blob/fSWx7-xmJKC7L7JqWKGngAVrYtkwkZ8hhvY1IK3fNxI",
		"metadata": {
			"zelfProof": "AwjFLS9YX3iFObebRZYLNavEUYOs7OO0M3MPsMYZRqZIcYWPMrTds6EWHY9+FI/VmYZzT/YkCfAR72x9Q3dJj5yRALeZXcFnJ8xeNyxQRLqCf4XtTxaJJbecerajzyaEKgeMnSNGRjuGbvzXBbJMiB0Kr0sZgMNgJFRssAQ5zV5/YFFaEOs5DB3b36/Hhy/woEQBYmjJsvE2WuUYyXTKSj/lVvizGcpm9hyNMMb6mRS8gfgQUDwHm2rJdn2APn90cRZh74DNu937KlMbXsmAoj9Cazei3rRRIFfm8KH7gvSfIbXmEgFUeHmOXwCD0Cu1vbjOfP6F47t0SDSiWjxR+6t1KTWkiHQO+w8NQy0Y0E8mDrYrznhEx29sfG4Kiu05qYpUrxPp7b0XyNsPBDHumjB5RjS2ZVSwGWBMfjugck9wW9vxYlY5y/Gk4hhShO0ViAeK4OEhmYahvJpgDs9Q9bCouZ8TEfxW4LOT11/UDf9sOk9L6yU/Hn4kzm7akSZrYnANy7Di7nuM2d8yHAT/Wi0rdYJWisMVKEx513MIS52//IPzKyX9Nj+5FRplmrQu4hn7rwe8IuvtYj0y0Gd6cLO3BNAzVteAsOdwZ8RXzlBXu4oofqaudYh9xQ3QlECIVpFEXCSKqaIn7umsc+isyNA73KLyOTraBhfrjymFG+9LXLqOmRJw/9WKqJGMA2OgFz373PghWvQ3Odi/5rxrX3fut40tBwCQDdmDoJI3dRNdgD2cokOBSjEgF/rCkVX3d99hTFcM+yMmcpkALtjD/POhEZGG9uJgKQ5M+/XE7R/+LRE9R/UwWujmrfRTMV5lnzg2/G/gzJ4j8Kpgxw/ZHLuFo3UVa1UKeu4WJ36HHmppv5woMD68vAKEcxXHsLa/Sz6Xg80832OMyLBuhBVQB3/+XJ5AXHfQqq31kSBY8YBMVkMVH48fpnaOwp+hXI0+dUwRTsyyFCzA47O8M/oFehWFuI6lenFBPPFgbopH3g/RiX1pGxv35J/AefkhUncIQzeHuP83ja4Hv2dhzb1p05r8CtUEsIgTLSlCAWUlotY5Dlz95E1yAeH7E3ThanQh+A==",
			"hasPassword": "true",
			"contentType": "image/png",
			"fileName": "jumitrmo.zelf.hold.png",
			"uploadTimestamp": "2025-07-15T19:07:42.660Z",
			"sizeBytes": 18047,
			"network": "mainnet"
		},
		"storage": {
			"epochs": 5,
			"network": "mainnet",
			"deletable": false
		},
		"uploadResult": {
			"blobId": "fSWx7-xmJKC7L7JqWKGngAVrYtkwkZ8hhvY1IK3fNxI",
			"blobObject": {
				"id": {
					"id": "0x41c03b1c7931db7d77ce8127289effb4c0700b502e72ab7a5dcb608e23d4d4a3"
				},
				"registered_epoch": 9,
				"blob_id": "8240351619959906259125496024078508970520452290642942755717499122791467787645",
				"size": "18047",
				"encoding_type": 1,
				"certified_epoch": 9,
				"storage": {
					"id": {
						"id": "0xd49d8dc53ca4d7a92b42f0de7c2215d16e210660a9456d3ed9370db17d606cac"
					},
					"start_epoch": 9,
					"end_epoch": 14,
					"storage_size": "66034000"
				},
				"deletable": false
			}
		}
	}
	*/

	// return {
	// 	// walrus: await WalrusModule.prepareImageForFrontend(blobDetails.blobId),
	// 	walrus: await WalrusModule.zelfNameRegistration(searchResult.ipfs[0].zelfProofQRCode, searchResult.ipfs[0].publicData),
	// };
};

/**
 * Search in Arweave
 * @param {Object} query - Query object
 * @returns {Array} formatted Arweave records
 */
const _searchInArweave = async (query) => {
	try {
		const searchResults = await ArweaveModule.search(query);

		return await _returnFormattedArweaveRecords(searchResults);
	} catch (exception) {
		console.error({ exception: exception });
		return [];
	}
};

/**
 * Search in Storacha (placeholder for future implementation)
 * @param {Object} params - Search parameters
 * @param {Object} query - Query object
 * @returns {Array} formatted Storacha records
 */
const _searchInStoracha = async (params, query) => {
	// TODO: Implement Storacha search logic
	try {
		// const searchResults = await StorachaModule.search(params.zelfName || params.key === "zelfName" ? params.value : null, query);
		// return await _returnFormattedStorachaRecords(searchResults);
		return [];
	} catch (exception) {
		console.error({ StorachaSearchException: exception });
		return [];
	}
};

/**
 * Search in Walrus (placeholder for future implementation)
 * @param {Object} params - Search parameters
 * @param {Object} query - Query object
 * @returns {Array} formatted Walrus records
 */
const _searchInWalrus = async (params, query) => {
	// TODO: Implement Walrus search logic
	try {
		// const searchResults = await WalrusModule.search(params.zelfName || params.key === "zelfName" ? params.value : null, query);
		// return await _returnFormattedWalrusRecords(searchResults);
		return [];
	} catch (exception) {
		console.error({ WalrusSearchException: exception });
		return [];
	}
};

/**
 * Retrieve records from IPFS based on environment
 * @param {Array} ipfsRecords - Array to store IPFS records
 * @param {String} environment - Environment type (hold, mainnet, both)
 * @param {Object} query - Query object
 * @param {Object} authUser - Authenticated user object
 */
const _retriveFromIPFSByEnvironment = async (ipfsRecords, environment, query, authUser) => {
	switch (environment) {
		case "hold":
			ipfsRecords.push(
				...(await IPFSModule.get(
					{
						key: query.key || "zelfName",
						value: `${query.value || query.zelfName}.hold`,
					},
					authUser
				))
			);
			break;
		case "mainnet":
			ipfsRecords.push(...(await IPFSModule.get(query, authUser)));
			break;

		default:
			try {
				ipfsRecords.push(...(await IPFSModule.get(query, authUser)));
			} catch (exception) {
				console.error({ mainNetIPFSError: exception });
			}

			try {
				ipfsRecords.push(
					...(await IPFSModule.get(
						{
							key: query.key || "zelfName",
							value: `${query.value || query.zelfName}.hold`,
						},
						authUser
					))
				);
			} catch (exception) {
				console.error({ holdIPFSError: exception });
			}

			break;
	}
};

/**
 * Search in IPFS
 * @param {String} environment - Environment type (hold, mainnet, both)
 * @param {Object} query - Query object
 * @param {Object} authUser - Authenticated user object
 * @param {Boolean} foundInArweave - Whether results were found in Arweave
 * @returns {Array|Object} IPFS search results
 * @author Miguel Trevino
 */
const _searchInIPFS = async (environment = "both", query, authUser, foundInArweave) => {
	const zelfName = query.value || query.zelfName;

	const { price, reward } = zelfName.includes(".zelf")
		? ZNSPartsModule.calculateZelfNamePrice(zelfName.split(".zelf")[0].length, query.duration)
		: { price: 0, reward: 0 };

	try {
		let ipfsRecords = [];

		await _retriveFromIPFSByEnvironment(ipfsRecords, environment, query, authUser);

		if (!ipfsRecords.length) {
			return zelfName && zelfName.includes(".zelf")
				? {
						price,
						reward,
						zelfName,
						available: true,
				  }
				: null;
		}

		const zelfNames = await _returnFormattedIPFSRecords(ipfsRecords, environment, foundInArweave);

		if (!zelfNames.length) {
			const error = new Error("not_found_in_arweave");
			error.status = 404;
			throw error;
		}

		return foundInArweave ? zelfNames : { ipfs: zelfNames };
	} catch (exception) {
		console.error({ _searchInIPFS_exception: exception });

		return foundInArweave
			? []
			: query.key === "zelfName"
			? {
					price,
					reward,
					zelfName,
					available: true,
			  }
			: null;
	}
};

/**
 * Format Arweave search results
 * @param {Array} searchResults - Raw Arweave search results
 * @returns {Array} Formatted Arweave records
 */
const _returnFormattedArweaveRecords = async (searchResults) => {
	if (searchResults?.available) return [];

	const zelfNames = [];

	const now = moment();

	const hideRecordsWithoutRegisteredAt = Boolean(searchResults.length >= 2);

	for (let index = 0; index < searchResults.length; index++) {
		const zelfNameObject = await ZNSPartsModule.formatArweaveRecord(searchResults[index]);

		if (hideRecordsWithoutRegisteredAt && !zelfNameObject.publicData.registeredAt) continue;

		const expiresAt = parseLeaseDate(zelfNameObject.publicData.expiresAt).add(45, "day");

		const isExpired = moment.utc().isAfter(expiresAt);

		if (isExpired) continue;

		zelfNameObject.zelfProof = zelfNameObject.zelfProof.replace(/ /g, "+");

		zelfNames.push(zelfNameObject);
	}

	return zelfNames;
};

/**
 * Format IPFS search results
 * @param {Array} ipfsRecords - Raw IPFS records
 * @param {String} environment - Environment type
 * @param {Boolean} foundInArweave - Whether results were found in Arweave
 * @returns {Array} Formatted IPFS records
 */
const _returnFormattedIPFSRecords = async (ipfsRecords, environment, foundInArweave) => {
	const zelfNamesInIPFS = [];

	const now = moment();

	for (let index = 0; index < ipfsRecords.length; index++) {
		const ipfsRecord = ipfsRecords[index];

		const formattedIPFS = await ZNSPartsModule.formatIPFSRecord(ipfsRecord, foundInArweave);

		const expiresAt = parseLeaseDate(formattedIPFS.publicData.expiresAt).add(formattedIPFS.publicData.type === "mainnet" ? 45 : 0, "day");

		const isExpired = moment.utc().isAfter(expiresAt);

		if (isExpired) {
			ipfsRecord.ipfs_pin_hash ? await IPFSModule.unPinFiles([ipfsRecord.ipfs_pin_hash]) : "do nothing";

			continue;
		}

		if (environment === "both") {
			zelfNamesInIPFS.push(formattedIPFS);

			continue;
		}

		if (
			(environment === "hold" && ipfsRecord.metadata.keyvalues.type === "hold") ||
			(environment === "mainnet" && (!ipfsRecord.metadata.keyvalues.type || ipfsRecord.metadata.keyvalues.type === "mainnet"))
		) {
			zelfNamesInIPFS.push(formattedIPFS);
		}
	}

	return zelfNamesInIPFS;
};

module.exports = {
	searchZelfName,
	_searchInArweave,
	_searchInStoracha,
	_searchInWalrus,
	_searchInIPFS,
	_retriveFromIPFSByEnvironment,
	_returnFormattedArweaveRecords,
	_returnFormattedIPFSRecords,
};
