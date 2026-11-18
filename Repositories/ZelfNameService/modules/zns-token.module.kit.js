/**
 * Option A: ZNS Token Module - @solana-program/token + @solana/kit (0 vulnerabilities)
 * Test via SOLANA_USE_KIT=true or /purchase-rewards-kit, /referral-rewards-kit routes.
 *
 * TODO: Migrate to @solana/kit API when ready. For now uses same manual SPL as Option B
 * so routing works. Replace implementation with @solana-program/token when migrating.
 */
const solanaWeb3 = require("@solana/web3.js");
const splManual = require("../../../Core/spl-token-manual");
const { sendWithRetry } = require("../../../Core/solana-tx");
const config = require("../../../Core/config");
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

const tokenMintAddress = new solanaWeb3.PublicKey(config.solana.tokenMintAddress);

const giveTokensAfterPurchase = async (amount, receiverSolanaAddress) => {
    assertPayoutAddressAllowed(receiverSolanaAddress);

    try {
        await initConnection();

        const senderKey = Uint8Array.from(JSON.parse(config.solana.sender));
        const senderWallet = solanaWeb3.Keypair.fromSecretKey(senderKey);

        const computeBudgetInstruction = solanaWeb3.ComputeBudgetProgram.setComputeUnitPrice({
            microLamports: 100000,
        });

        const senderTokenAccount = await splManual.getOrCreateAssociatedTokenAccount(
            connection,
            senderWallet,
            tokenMintAddress,
            senderWallet.publicKey,
        );

        // Dev-mode divisor matches non-kit module (10): preserves sender wallet during testing
        // while still emitting meaningful per-purchase balances.
        const isDevMode = config.solana.devModeTokens === true || config.solana.devModeTokens === "true";
        const actualAmount = isDevMode ? amount / 10 : amount;
        const amountToSend = Math.round(actualAmount * 10 ** 8);

        if (isDevMode) console.log(`[DEV MODE] Token transfer reduced: ${amount} → ${actualAmount} tokens`);

        if (senderTokenAccount.amount < amountToSend) throw new Error("Insufficient balance in sender's token account.");

        const receiverPublicKey = new solanaWeb3.PublicKey(receiverSolanaAddress);

        const receiverTokenAccount = await splManual.getOrCreateAssociatedTokenAccount(
            connection,
            senderWallet,
            tokenMintAddress,
            receiverPublicKey,
        );

        const transferInstruction = splManual.createTransferCheckedInstruction(
            senderTokenAccount.address,
            tokenMintAddress,
            receiverTokenAccount.address,
            senderWallet.publicKey,
            amountToSend,
            8,
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
            tokenAmount: 250,
            status: "pending",
            attempts: 0,
            payload: {},
            ipfsHash: zelfNameObject.ipfsHash,
            arweaveId: zelfNameObject.arweaveId || "not_set",
        });

        return await purchaseReward.save();
    } catch (error) {
        console.error("Error adding purchase:", error);
        throw error;
    }
};

const releaseReferralRewards = async (authUser) => {
    let referralRewards = null;
    let firstGroup = null;

    try {
        referralRewards = await MongoORM.groupAggregate(ReferralRewardModel, {
            wheres: { status: "pending" },
            groupBy: "referralZelfName",
            sum: "zelfNamePrice",
            includeFields: ["referralZelfName", "referralSolanaAddress", "status"],
        });

        if (!referralRewards || referralRewards.length === 0) {
            return { nothingToProcess: true };
        }

        firstGroup = referralRewards[0];

        const rewardTokens = Math.round(firstGroup.totalSum * 0.05 * 100) / 100;

        await giveTokensAfterPurchase(rewardTokens, firstGroup.referralSolanaAddress);

        await ReferralRewardModel.updateMany(
            {
                referralZelfName: firstGroup._id,
                status: "pending",
            },
            {
                $set: {
                    status: "completed",
                    completedAt: new Date(),
                },
                $inc: { attempts: 1 },
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
                    referralZelfName: firstGroup._id,
                    status: "pending",
                },
                {
                    $set: {},
                    $inc: { attempts: 1 },
                },
            );
        }

        throw error;
    }
};

const releasePurchaseRewards = async (authUser) => {
    const purchaseReward = await MongoORM.buildQuery({ where_status: "pending", findOne: true }, PurchaseRewardModel, null);

    if (!purchaseReward) {
        return { nothingToProcess: true };
    }

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

        throw error;
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
        throw error;
    }
};

module.exports = {
    getPurchaseReward,
    addReferralReward,
    addPurchaseReward,
    releaseReferralRewards,
    releasePurchaseRewards,
    giveTokensAfterPurchase,
};
