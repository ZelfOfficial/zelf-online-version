/**
 * Beneficiary claim notifications for real succession (confirmDeath relay).
 */

const { sendBeneficiaryClaimable } = require("./email");

const resolveBeneficiaryTagName = (entry, vaultIdHex, index) => {
    const tagNames = entry.beneficiaryTagNames || [];
    const isSingle = entry.beneficiaryEmails.length === 1;
    let tagName = tagNames[index] || vaultIdHex;

    if (isSingle) {
        if (tagNames.length > 1) {
            const valTag = tagNames.find((t) => t.toLowerCase().includes("val"));
            if (valTag) tagName = valTag;
        }
        tagName = tagName.replace(/\.zelf$/, "");
    }
    return tagName;
};

/** Send claimable emails (awaited). Used after confirmDeath or when the vault is already claimable. */
const notifyBeneficiaryClaimable = async (entry, vaultIdHex) => {
    if (!entry?.beneficiaryEmails?.length) {
        return { sent: 0, skipped: true, reason: "no_beneficiary_emails" };
    }

    const sends = entry.beneficiaryEmails.map((email, i) =>
        sendBeneficiaryClaimable(email, resolveBeneficiaryTagName(entry, vaultIdHex, i))
    );
    await Promise.all(sends);
    console.log(`Beneficiary claimable emails sent: ${sends.length} for vault ${vaultIdHex}`);
    return { sent: sends.length, success: true };
};

const markNotifiedEvent = async (entry, key) => {
    const notifiedEvents = { ...(entry.notifiedEvents || {}), [key]: new Date().toISOString() };
    entry.notifiedEvents = notifiedEvents;
    entry.markModified("notifiedEvents");
    await entry.save();
};

/**
 * Idempotent beneficiary notification — safe to call from the confirmDeath relay hook.
 */
const ensureBeneficiaryClaimableEmails = async (entry, vaultIdHex) => {
    if (entry.notifiedEvents?.beneficiaryClaimable) {
        return { skipped: true, reason: "already_notified" };
    }
    const result = await notifyBeneficiaryClaimable(entry, vaultIdHex);
    if (result.success) {
        await markNotifiedEvent(entry, "beneficiaryClaimable");
    }
    return result;
};

module.exports = {
    resolveBeneficiaryTagName,
    notifyBeneficiaryClaimable,
    ensureBeneficiaryClaimableEmails,
};
