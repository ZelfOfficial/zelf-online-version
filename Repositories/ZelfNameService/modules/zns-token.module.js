const config = require("../../../Core/config");
if (config.solana?.useKit) { module.exports = require("./zns-token.module.kit"); return; }

const solanaWeb3 = require("@solana/web3.js");
const splManual = require("../../../Core/spl-token-manual");
const { sendWithRetry } = require("../../../Core/solana-tx");
const ReferralRewardModel = require("../models/referral-rewards.model");
const PurchaseRewardModel = require("../models/purchase-rewards.model");
const MongoORM = require("../../../Core/mongo-orm");
const { assertPayoutAddressAllowed, isPayoutAddressBlockedError } = require("./zns-payout-denylist");

let connection;

const initConnection = async () => {
    if (connection) return connection;

    connection = new solanaWeb3.Connection(config.solana.rpcUrl);

    await connection.getSlot();
};

// Token mint address (ZNS token address)
const tokenMintAddress = new solanaWeb3.PublicKey(config.solana.tokenMintAddress);

const isAccountActive = async (solanaAddress) => {
    try {
        await initConnection();
        const publicKey = new solanaWeb3.PublicKey(solanaAddress);
        const accountInfo = await connection.getAccountInfo(publicKey);
        
        // If accountInfo is null, the account does not exist (not activated)
        // If lamports is 0, it's also not funded
        if (!accountInfo || accountInfo.lamports === 0) {
            return false;
        }
        
        return true;
    } catch (error) {
        console.error("Error checking account activity:", error);
        // If the public key is invalid or another error occurs, default to inactive to be safe
        return false;
    }
};

const giveTokensAfterPurchase = async (amount, receiverSolanaAddress) => {
    assertPayoutAddressAllowed(receiverSolanaAddress);

    try {
        await initConnection();

        const senderKey = Uint8Array.from(JSON.parse(config.solana.sender));
        const senderWallet = solanaWeb3.Keypair.fromSecretKey(senderKey);

        // Compute Budget Program Instruction (to increase gas fees)
        const computeBudgetInstruction = solanaWeb3.ComputeBudgetProgram.setComputeUnitPrice({
            microLamports: 100000, // Adjust this value to set a higher priority fee
        });

        // Get or create the sender's associated token account (Option B: manual SPL, no bigint-buffer)
        const senderTokenAccount = await splManual.getOrCreateAssociatedTokenAccount(
            connection,
            senderWallet,
            tokenMintAddress,
            senderWallet.publicKey,
        );

        // Convert amount to smallest unit (8 decimals for ZNS token)
        // Amount is expected in tokens, so always multiply by 10^8
        // In dev mode, divide by 10 to preserve wallet balance during testing while still
        // emitting a meaningful balance (e.g. $99 plan -> 1980 / 10 = 198 ZNS).
        const isDevMode = config.solana.devModeTokens === true || config.solana.devModeTokens === "true";

        const actualAmount = isDevMode ? amount / 10 : amount;

        const amountToSend = Math.round(actualAmount * 10 ** 8);

        if (isDevMode) console.log(`[DEV MODE] Token transfer reduced: ${amount} → ${actualAmount} tokens`);

        if (senderTokenAccount.amount < amountToSend) throw new Error("Insufficient balance in sender's token account.");

        // Receiver's public key
        const receiverPublicKey = new solanaWeb3.PublicKey(receiverSolanaAddress);

        // Get or create the receiver's associated token account
        const receiverTokenAccount = await splManual.getOrCreateAssociatedTokenAccount(
            connection,
            senderWallet, // Payer (sender pays for account creation if needed)
            tokenMintAddress,
            receiverPublicKey,
        );

        // Create the token transfer instruction
        const transferInstruction = splManual.createTransferCheckedInstruction(
            senderTokenAccount.address, // Sender's token account
            tokenMintAddress, // Token mint address
            receiverTokenAccount.address, // Receiver's token account
            senderWallet.publicKey, // Owner of the sender's token account
            amountToSend, // Amount to send (in smallest unit)
            8, // Decimals of the token
        );

        const transferTransaction = new solanaWeb3.Transaction().add(computeBudgetInstruction, transferInstruction);

        const transferSignature = await sendWithRetry(connection, transferTransaction, [senderWallet]);

        return transferSignature;
    } catch (error) {
        console.error("Error sending token:", { error });
        throw error;
    }
};

// sendWithRetry is imported from Core/solana-tx.js (HTTP-only polling, no WebSocket signatureSubscribe)

const addReferralReward = async (zelfNameObject) => {
    if (!zelfNameObject) return null;

    try {
        const referralReward = new ReferralRewardModel({
            zelfName: zelfNameObject.zelfName,
            ethAddress: zelfNameObject.ethAddress,
            solanaAddress: zelfNameObject.solanaAddress,
            referralZelfName: zelfNameObject.referralZelfName,
            referralSolanaAddress: zelfNameObject.referralSolanaAddress,
            zelfNamePrice: zelfNameObject.zelfNamePrice,
            status: "pending",
            attempts: 0,
            payload: {},
            ipfsHash: zelfNameObject.ipfsHash,
            arweaveId: zelfNameObject.arweaveId,
        });

        await referralReward.save();

        return referralReward;
    } catch (error) {
        console.error("Error adding purchase:", error);
    }
};

const addPurchaseReward = async (zelfNameObject) => {
    if (!zelfNameObject) return null;

    try {
        const purchaseReward = new PurchaseRewardModel({
            zelfName: zelfNameObject.zelfName,
            ethAddress: zelfNameObject.ethAddress,
            solanaAddress: zelfNameObject.solanaAddress,
            zelfNamePrice: zelfNameObject.zelfNamePrice,
            tokenAmount: 250, //Math.round(zelfNameObject.zelfNamePrice / config.token.rewardPrice),
            status: "pending",
            attempts: 0,
            payload: {},
            ipfsHash: zelfNameObject.ipfsHash,
            arweaveId: zelfNameObject.arweaveId || "not_set",
        });

        return await purchaseReward.save();
    } catch (error) {
        console.error("Error adding purchase:", error);
        throw error; // Re-throw for higher-level error handling if needed
    }
};

const releaseReferralRewards = async (authUser) => {
    let referralRewards = null;
    let firstGroup = null;

    try {
        referralRewards = await MongoORM.groupAggregate(ReferralRewardModel, {
            wheres: { status: "pending" }, // Match condition
            groupBy: "referralZelfName", // Group by field
            sum: "zelfNamePrice", // Field to sum
            includeFields: ["referralZelfName", "referralSolanaAddress", "status"],
        });

        // Ensure there is at least one group to process
        if (!referralRewards || referralRewards.length === 0) {
            return { nothingToProcess: true };
        }

        firstGroup = referralRewards[0];

        // Calculate reward tokens: 5% of total purchase amount
        const rewardTokens = Math.round(firstGroup.totalSum * 0.05 * 100) / 100; // 5% with 2 decimal places

        // Send tokens using proper parameters
        await giveTokensAfterPurchase(rewardTokens, firstGroup.referralSolanaAddress);

        // Update all records in this group with a single updateMany
        await ReferralRewardModel.updateMany(
            {
                referralZelfName: firstGroup._id, // Match the grouped field
                status: "pending", // Ensure only pending rewards are updated
            },
            {
                $set: {
                    status: "completed",
                    completedAt: new Date(),
                },
                $inc: { attempts: 1 }, // Increment the attempts counter
            },
        );

        return firstGroup;
    } catch (error) {
        if (isPayoutAddressBlockedError(error)) {
            if (firstGroup) {
                await ReferralRewardModel.updateMany(
                    {
                        referralZelfName: firstGroup._id,
                        status: "pending",
                    },
                    {
                        $set: {
                            status: "failed",
                            completedAt: new Date(),
                        },
                        $inc: { attempts: 1 },
                    },
                );
            }

            throw error;
        }

        console.error("Error releasing reward:", error);

        if (referralRewards.length) {
            await ReferralRewardModel.updateMany(
                {
                    referralZelfName: firstGroup._id, // Match the grouped field
                    status: "pending", // Ensure only pending rewards are updated
                },
                {
                    $set: {},
                    $inc: { attempts: 1 }, // Increment the attempts counter
                },
            );
        }

        throw error; // Re-throw for higher-level error handling if needed
    }
};

/**
 * release purchase rewards
 * @param {Object} authUser
 * @returns
 * @author Miguel Trevino
 */
const releasePurchaseRewards = async (authUser) => {
    const purchaseReward = await MongoORM.buildQuery({ where_status: "pending", findOne: true }, PurchaseRewardModel, null);

    if (!purchaseReward) {
        return { nothingToProcess: true };
    }

    // if attempts is 5 then mark it as failed
    if (purchaseReward.attempts === 5) {
        purchaseReward.status = "failed";

        purchaseReward.completedAt = new Date();

        await purchaseReward.save();

        return purchaseReward;
    }

    try {
        const signature = await giveTokensAfterPurchase(250, purchaseReward.solanaAddress);

        purchaseReward.status = "completed";
        purchaseReward.completedAt = new Date();
        purchaseReward.attempts += 1;
        purchaseReward.payload = { signature };

        await purchaseReward.save();

        return purchaseReward;
    } catch (error) {
        if (isPayoutAddressBlockedError(error)) {
            purchaseReward.status = "failed";
            purchaseReward.completedAt = new Date();
            purchaseReward.payload = { ...(purchaseReward.payload || {}), error: "PAYOUT_ADDRESS_BLOCKED" };
            await purchaseReward.save();
            throw error;
        }

        console.error("Error releasing reward:", error);

        purchaseReward.status = "pending";

        purchaseReward.attempts += 1;

        await purchaseReward.save();

        throw error; // Re-throw for higher-level error handling if needed
    }
};

const getPurchaseReward = async (zelfName, afterDate) => {
    if (!zelfName) return null;

    const queryParams = {
        where_zelfName: zelfName,
        findOne: true,
    };

    if (afterDate) queryParams["where>=_createdAt"] = afterDate;

    try {
        const purchaseReward = await MongoORM.buildQuery(queryParams, PurchaseRewardModel, null);

        if (!purchaseReward) return null;

        return purchaseReward;
    } catch (error) {
        console.error("Error getting purchase reward:", error);
        throw error; // Re-throw for higher-level error handling if needed
    }
};

module.exports = {
    getPurchaseReward,
    addReferralReward,
    addPurchaseReward,
    releaseReferralRewards,
    releasePurchaseRewards,
    giveTokensAfterPurchase,
    isAccountActive,
};
