const { ethers } = require("ethers");
const config = require("../../../Core/config");

const CONSTANTS = {
    contractAddress: config.avalanche?.contractAddress || "0x6C995090C530756d59E6eEa5a3bA209863e0E167",
    network: "mainnet",
    rpcUrl: config.avalanche?.rpcUrl || process.env.AVALANCHE_RPC_URL || "",
    chainId: config.avalanche?.chainId || 43114,
    gasPrice: "25000000000", // 25 gwei
    NFT_ABI: [
        "function name() view returns (string)",
        "function symbol() view returns (string)",
        "function totalSupply() view returns (uint256)",
        "function owner() view returns (address)",
        "function paused() view returns (bool)",
        "function mintNFT(address to, string memory tokenURI) returns (uint256)",
    ],
};

const getMasterWallet = async () => {
    const rpcUrl = process.env.AVALANCHE_RPC_URL || CONSTANTS.rpcUrl;
    if (!rpcUrl) throw new Error("AVALANCHE_RPC_URL is not configured");

    const provider = new ethers.JsonRpcProvider(rpcUrl);

    const mnemonic = process.env.MNEMONICS;

    if (!mnemonic) throw new Error("MNEMONICS not found in .env file");

    const masterWallet = ethers.Wallet.fromPhrase(mnemonic, provider);
    const balance = await provider.getBalance(masterWallet.address);
    const contract = new ethers.Contract(CONSTANTS.contractAddress, CONSTANTS.NFT_ABI, masterWallet);

    return {
        balance,
        contract,
        masterWallet,
    };
};

const createNFT = async (data, authToken) => {
    if (!authToken) throw new Error("authtoken_required");
    if (!authToken.ethAddress) throw new Error("authtoken_eth_address_required");

    const { identifier } = data;

    let recipientAddress;

    try {
        recipientAddress = ethers.getAddress(authToken.ethAddress);
    } catch (error) {
        throw new Error(`Invalid Ethereum address: ${authToken.ethAddress}. Error: ${error.message}`);
    }

    const NFTData = await prepareNFTData(data, authToken);

    const { contract, masterWallet } = await getMasterWallet();

    const zelfKeyData = await insertMetadata(NFTData, data.publicData, identifier);

    const tokenURI = zelfKeyData.ipfsUrl;

    try {
        const gasEstimate = await contract.mintNFT.estimateGas(recipientAddress, tokenURI);
        const gasPrice = ethers.parseUnits(CONSTANTS.gasPrice, "wei");
        const estimatedCost = gasEstimate * gasPrice;

        const tx = await contract.mintNFT(recipientAddress, tokenURI, {
            gasLimit: gasEstimate,
            gasPrice,
        });

        await tx.wait();

        const totalSupply = await contract.totalSupply();
        const newTokenId = totalSupply.toString();

        const _estimatedCost = ethers.formatEther(estimatedCost);

        return {
            contractAddress: CONSTANTS.contractAddress,
            cost: _estimatedCost,
            explorerUrl: `https://snowtrace.io/tx/${tx.hash}`,
            imageUrl: NFTData.image,
            metadata: NFTData,
            metadataUrl: tokenURI,
            owner: recipientAddress,
            recipient: recipientAddress,
            success: true,
            tokenId: newTokenId,
            transactionHash: tx.hash,
        };
    } catch (error) {
        if (!error.data) throw new Error(`NFT minting failed: ${error.message}. Address: ${recipientAddress}, TokenURI: ${tokenURI}`);

        const errorData = error.data;
        const errorSelector = errorData.slice(0, 10); // First 4 bytes (8 hex chars + 0x)

        if (errorSelector === "0x118cdaa7") {
            const provider = new ethers.JsonRpcProvider(CONSTANTS.rpcUrl);
            const contractOwner = await contract.owner().catch(() => null);
            const masterWalletBalance = await provider.getBalance(masterWallet.address);
            const recipientCode = await provider.getCode(recipientAddress).catch(() => null);

            const diagnosticInfo = [
                `Master Wallet: ${masterWallet.address}`,
                `Master Wallet Balance: ${ethers.formatEther(masterWalletBalance)} AVAX`,
                contractOwner ? `Contract Owner: ${contractOwner}` : "Could not fetch owner",
                contractOwner
                    ? `Is Master Wallet Owner: ${contractOwner.toLowerCase() === masterWallet.address.toLowerCase() ? "✅ Yes" : "❌ No"}`
                    : "N/A",
                `Recipient Address: ${recipientAddress}`,
                recipientCode ? `Recipient is EOA: ${recipientCode === "0x" ? "✅ Yes" : "❌ No (Contract)"}` : "N/A",
            ].join("\n  - ");

            throw new Error(
                `NFT minting failed: The master wallet is not authorized to mint.\n\n` +
                    `Root Cause: The mintNFT function requires the onlyOwner modifier. Only the contract owner can mint NFTs.\n\n` +
                    `Diagnostics:\n  - ${diagnosticInfo}\n\n` +
                    `Solutions:\n` +
                    `1. Transfer contract ownership to the master wallet (${masterWallet.address})\n` +
                    `2. Modify the contract to allow the master wallet to mint (add minter role or remove onlyOwner)\n` +
                    `3. Use the contract owner's wallet to mint instead\n\n` +
                    `Contract: https://snowtrace.io/address/${CONSTANTS.contractAddress}`,
            );
        }

        throw new Error(`NFT minting failed: Contract reverted with error selector ${errorSelector}. Full error data: ${errorData}`);
    }
};

const prepareNFTData = async (data, authToken) => {
    if (!authToken) throw new Error("authtoken_required");
    if (!authToken.ethAddress) throw new Error("authtoken_eth_address_required");

    let ownerAddress;

    try {
        ownerAddress = ethers.getAddress(authToken.ethAddress);
    } catch (error) {
        throw new Error(`Invalid Ethereum address: ${authToken.ethAddress}. Error: ${error.message}`);
    }

    const { name, identifier, url, publicData, zelfProof, website } = data;

    const attributes = [
        {
            trait_type: "zelfProof",
            value: zelfProof,
        },
        {
            trait_type: "owner",
            value: ownerAddress,
        },
    ];

    for (const key in publicData) {
        attributes.push({
            trait_type: key,
            value: publicData[key],
        });
    }

    const _name = `${name || identifier}`
        .replace(/\s+/g, "_")
        .toLowerCase()
        .replace(/[^a-z0-9_]/g, "");

    const metadata = {
        attributes: attributes,
        description: `ZelfKey NFT for ${_name}`,
        external_url: website || "https://zelf.world",
        image: url,
        name: _name,
        properties: {
            files: [
                {
                    type: "image/png",
                    uri: url,
                },
            ],
            category: "image",
        },
    };

    return metadata;
};

/**
 *
 * @param {Object} NFTData
 * @param {Object} publicData
 */
const insertMetadata = async (NFTData, publicData, identifier) => {
    const PINATA_CONFIG = {
        apiKey: process.env.PINATA_API_KEY,
        secretKey: process.env.PINATA_API_SECRET,
        gateway: process.env.PINATA_GATEWAY_URL || "https://gateway.pinata.cloud",
    };

    const metadataBlob = new Blob([JSON.stringify(NFTData, null, 2)], {
        type: "application/json",
    });

    const formData = new FormData();

    formData.append("file", metadataBlob, `${identifier}.json`);
    formData.append(
        "pinataMetadata",
        JSON.stringify({
            name: identifier,
            keyvalues: {
                ...publicData,
                category: `nft_${publicData.category}`,
            },
        }),
    );

    const response = await fetch("https://api.pinata.cloud/pinning/pinFileToIPFS", {
        method: "POST",
        headers: {
            pinata_api_key: PINATA_CONFIG.apiKey,
            pinata_secret_api_key: PINATA_CONFIG.secretKey,
        },
        body: formData,
    });

    if (!response.ok) {
        throw new Error(`Pinata upload failed: ${response.status} ${response.statusText}`);
    }

    const result = await response.json();

    const ipfsHash = result.IpfsHash;

    const ipfsUrl = `https://${PINATA_CONFIG.gateway}/ipfs/${ipfsHash}`;

    return {
        ipfsHash,
        ipfsUrl,
        record: result,
    };
};

module.exports = {
    createNFT,
    insertMetadata,
};
