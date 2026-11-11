const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const config = require("../../../Core/config");
const { signToken, TOKEN_TYPES } = require("../../../Core/jwt-claims");
const moment = require("moment");
const IPFSModule = require("../../IPFS/modules/ipfs.module");
const zelfProofModule = require("../../ZelfProof/modules/zelf-proof.module");
const { generateMnemonic } = require("../../Wallet/modules/helpers");
const axios = require("axios");
const ClientModule = require("../../Client/modules/client.module");
const Mailgun = require("../../../Core/mailgun");
const fs = require("fs");
const path = require("path");
const sharp = require("sharp");

/**
 * Get staff members for a client
 * @param {Object} params
 * @param {Object} authUser
 * @returns {Array}
 */
const get = async (params = {}, authUser = {}) => {
    // Get all staff members for the authenticated client
    const staffRecords = await IPFSModule.get({
        key: "staffOwnerEmail",
        value: authUser.email,
    });

    return staffRecords;
};

/**
 * Send invitation email
 */
const _sendInvitationEmail = async ({ staffEmail, staffName, ownerName, company, inviteLink, role }) => {
    try {
        const emailResult = await Mailgun.sendCustomEmail(
            staffEmail,
            "staff_invitation",
            {
                recipientName: staffName,
                staffName,
                ownerName,
                companyName: company,
                inviteLink,
                role,
                subject: `You've been invited to join ${company}`,
                greeting: `Hello ${staffName},`,
                sincerely: "Best regards,",
                projectName: "Zelf",
            },
            "en",
        );
    } catch (emailError) {
        console.error("Error sending invitation email:", emailError);
    }
};

/**
 * Generate invitation JWT for staff onboarding
 * @param {Object} data
 * @param {Object} authUser
 * @returns {Object}
 */
const generateInvitation = async (data, authUser) => {
    let { staffEmail, staffPhone, staffCountryCode, staffName, role, faceBase64, masterPassword, isResend } = data;

    // Verify the client owner by decrypting their zelfProof
    const clientAccount = await ClientModule.get({ email: authUser.email });

    if (!clientAccount) throw new Error("404:client_not_found");

    const accountJSON = await axios.get(clientAccount.url);

    // Decrypt to verify identity and extract zkProof
    // Decrypt to verify identity and extract zkProof
    let decryptedAccount;
    try {
        decryptedAccount = await zelfProofModule.decrypt({
            zelfProof: accountJSON.data.zelfProof,
            faceBase64,
            verifierKey: config.zelfEncrypt.serverKey,
            password: masterPassword || undefined,
        });
    } catch (error) {
        if (error.message?.includes("LIVENESS")) {
            throw new Error(`400:${error.message}`);
        }
        throw error;
    }

    if (!decryptedAccount) throw new Error("409:verification_failed");

    // Extract zkProof from metadata
    const zkProof = decryptedAccount.metadata.zkProof;
    const apiKey = decryptedAccount.metadata.apiKey;

    // Check if staff already exists
    const company = clientAccount.publicData.accountCompany || "Zelf Company";

    const ownerName =
        accountJSON.data.name || accountJSON.data.publicData?.name || authUser.name || authUser.fullName || clientAccount.publicData.name || "Admin";

    // Check if staff already exists
    const ipfsRecords = await IPFSModule.get({
        key: "staffEmail",
        value: staffEmail,
    });

    if (ipfsRecords.length === 0 && !staffPhone) {
        throw new Error("400:missing_staff_phone");
    }

    const existingStaff = ipfsRecords[0];

    if (ipfsRecords.length > 0) {
        let existingJSON = {};

        try {
            // Fetch full JSON if we have a record
            if (existingStaff.url) {
                const response = await axios.get(existingStaff.url);
                existingJSON = response.data || {};
            }
        } catch (e) {
            console.warn("Failed to fetch existing record JSON:", e.message);
        }

        const recoveredData = _processExistingInvitation(ipfsRecords, existingJSON, { staffPhone, staffCountryCode, staffName, role }, isResend);

        if (recoveredData.staffPhone) staffPhone = recoveredData.staffPhone;
        if (recoveredData.staffCountryCode) staffCountryCode = recoveredData.staffCountryCode;
        if (recoveredData.staffName) staffName = recoveredData.staffName;
        if (recoveredData.role) role = recoveredData.role;
    }

    // Generate invitation JWT (expires in 1 hour)
    const invitationToken = signToken(
        {
            type: "staff_invitation",
            ownerEmail: authUser.email,
            ownerCompany: company,
            staffEmail,
            staffPhone,
            staffCountryCode,
            staffName,
            role,
            zkProof,
            apiKey,
            exp: moment().add(1, "hour").unix(),
        },
        config.JWT_SECRET,
        { typ: TOKEN_TYPES.staffInvitation }
    );

    // Store pending invitation
    const invitationData = {
        ownerEmail: authUser.email,
        staffEmail,
        staffPhone,
        staffCountryCode,
        staffName,
        role,
        status: "pending",
        createdAt: new Date().toISOString(),
        expiresAt: moment().add(1, "hour").toISOString(),
    };

    const jsonData = JSON.stringify(invitationData, null, 2);

    const base64Data = Buffer.from(jsonData).toString("base64");

    await IPFSModule.insert(
        {
            base64: base64Data,
            metadata: {
                invitationType: "staff_invitation",
                staffOwnerEmail: authUser.email,
                staffEmail,
                staffPhone,
                staffCountryCode,
                staffName,
                staffRole: role,
                invitationStatus: "pending",
            },
            name: `${staffEmail}.invitation`,
            pinIt: true,
        },
        { pro: true },
    );

    // Send Invitation Email
    const inviteLink = `${config.stripe.frontendUrl}/auth/accept-invite?token=${invitationToken}`;

    await _sendInvitationEmail({
        staffEmail,
        staffName,
        ownerName,
        company,
        inviteLink,
        role,
    });

    // Cleanup pending invitation
    const pendingInvitation = ipfsRecords.find((r) => r.invitationStatus === "pending");

    if (pendingInvitation) {
        await IPFSModule.unPinFiles([pendingInvitation.id]).catch((e) => console.warn("Failed to unpin pending invitation:", e.message));
    }

    return {
        invitationToken,
        expiresAt: invitationData.expiresAt,
        staffEmail,
        staffName,
        role,
    };
};

/**
 * Create staff account from invitation
 * @param {Object} data
 * @returns {Object}
 */
const validateInvitation = async (token) => {
    try {
        const decoded = jwt.verify(token, config.JWT_SECRET);
        if (decoded.type !== "staff_invitation") {
            throw new Error("401:invalid_invitation_type");
        }

        // Check if already registered (optional check for UX)
        const existingStaff = await IPFSModule.get({
            key: "staffEmail",
            value: decoded.staffEmail,
        });

        let isAlreadyRegistered = false;

        if (existingStaff.length > 0) {
            const activeRecord = existingStaff.find((r) => r.accountType === "staff" || r.accountType === "staff_account");
            if (activeRecord) isAlreadyRegistered = true;
        }

        return {
            ...decoded,
            isAlreadyRegistered,
        };
    } catch (error) {
        throw new Error("401:invalid_or_expired_invitation");
    }
};

const createFromInvitation = async (data) => {
    const { invitationToken, masterPassword, faceBase64 } = data;

    // Verify and decode invitation token
    let invitation;
    try {
        invitation = jwt.verify(invitationToken, config.JWT_SECRET);
    } catch (error) {
        throw new Error("401:invalid_or_expired_invitation");
    }

    if (invitation.type !== "staff_invitation") throw new Error("401:invalid_invitation_type");

    // Check if staff already exists (ACTIVE account)
    const existingStaff = await IPFSModule.get({
        key: "staffEmail",
        value: invitation.staffEmail,
    });

    const activeStaff = existingStaff.find((r) => r.accountType === "staff" || r.accountType === "staff_account");

    if (activeStaff) throw new Error("403:staff_already_exists");

    // Create zelfProof for staff member using the zkProof from owner
    let zelfProof;
    try {
        const encryptionResult = await zelfProofModule.encrypt({
            publicData: {
                email: invitation.staffEmail,
                phone: invitation.staffPhone,
                company: invitation.ownerCompany,
                role: invitation.role,
            },
            faceBase64,
            metadata: {
                apiKey: invitation.apiKey, // Shared API key from owner
                zkProof: invitation.zkProof, // Shared zkProof from owner
                mnemonic: generateMnemonic(12),
                ownerEmail: invitation.ownerEmail,
                staffRole: invitation.role,
            },
            password: masterPassword,
            identifier: invitation.staffEmail,
            requireLiveness: true,
            tolerance: "REGULAR",
            verifierKey: config.zelfEncrypt.serverKey,
        });

        zelfProof = encryptionResult.zelfProof;
    } catch (error) {
        if (error.message?.includes("LIVENESS")) {
            throw new Error(`400:${error.message}`);
        }
        throw error;
    }

    // Create staff data structure
    const staffData = {
        email: invitation.staffEmail,
        phone: invitation.staffPhone,
        name: invitation.staffName,
        company: invitation.ownerCompany,
        role: invitation.role,
        ownerEmail: invitation.ownerEmail,
        zelfProof,
        createdAt: new Date().toISOString(),
        version: "1.0.0",
        hasPassword: "true",
        accountType: "staff",
    };

    const jsonData = JSON.stringify(staffData, null, 2);
    const base64Data = Buffer.from(jsonData).toString("base64");

    // Store staff account in IPFS
    const staffAccount = await IPFSModule.insert(
        {
            base64: base64Data,
            metadata: {
                staffEmail: invitation.staffEmail,
                staffPhone: invitation.staffPhone,
                staffCountryCode: invitation.staffCountryCode,
                staffOwnerEmail: invitation.ownerEmail,
                staffRole: invitation.role,
                accountType: "staff_account",
                staffName: invitation.staffName,
            },
            name: `${invitation.staffEmail}.staff`,
            pinIt: true,
        },
        { pro: true },
    );

    staffAccount.publicData = staffAccount.keyvalues;

    delete staffAccount.keyvalues;

    // Send Welcome Email
    try {
        const emailResult = await Mailgun.sendCustomEmail(
            invitation.staffEmail,
            "staff_welcome",
            {
                recipientName: invitation.staffName,
                staffName: invitation.staffName,
                companyName: invitation.ownerCompany,
                role: invitation.role,
                dashboardLink: `${config.stripe.frontendUrl}/dashboard`,
                subject: `Welcome to ${invitation.ownerCompany}!`,
                greeting: `Hello ${invitation.staffName},`,
                sincerely: "Best regards,",
                projectName: "Zelf",
            },
            "en",
        );
    } catch (emailError) {
        console.error("Error sending welcome email:", emailError);
    }

    // Cleanup all invitations
    const invitationsToDelete = existingStaff.filter((r) => r.invitationStatus === "pending" || r.name?.endsWith(".invitation"));

    if (invitationsToDelete.length > 0) {
        await IPFSModule.unPinFiles(invitationsToDelete.map((r) => r.id)).catch((e) => console.warn("Failed to unpin invitations:", e.message));
    }

    return {
        zelfProof,
        staffAccount,
        ipfsHash: staffAccount.cid,
        token: signToken(
            {
                email: invitation.staffEmail,
                role: invitation.role,
                ownerEmail: invitation.ownerEmail,
                accountType: "staff",
                exp: moment().add(30, "day").unix(),
            },
            config.JWT_SECRET,
            { typ: TOKEN_TYPES.staff }
        ),
    };
};

/**
 * Authenticate staff member
 * @param {Object} data
 * @returns {Object}
 */
const auth = async (data) => {
    const { email, faceBase64, masterPassword } = data;

    const staffRecords = await IPFSModule.get({ key: "staffEmail", value: email });

    if (!staffRecords.length) throw new Error("404:staff_not_found");

    const staffAccount = staffRecords[0];

    const accountJSON = await axios.get(staffAccount.url);

    if (!accountJSON.data?.zelfProof) throw new Error("409:account_doesnt_contain_zelf_proof");

    const decryptedAccount = await zelfProofModule.decrypt({
        zelfProof: accountJSON.data.zelfProof,
        faceBase64,
        verifierKey: config.zelfEncrypt.serverKey,
        password: masterPassword,
        identifier: email,
    });

    if (!decryptedAccount) throw new Error("409:error_decrypting_zelf_account");

    return {
        zelfProof: accountJSON.data.zelfProof,
        staffAccount,
        ipfsHash: staffAccount.cid,
        zkProof: decryptedAccount.metadata.zkProof,
        apiKey: decryptedAccount.metadata.apiKey,
        role: decryptedAccount.metadata.staffRole,
        ownerEmail: decryptedAccount.metadata.ownerEmail,
        token: signToken(
            {
                email,
                role: decryptedAccount.metadata.staffRole,
                ownerEmail: decryptedAccount.metadata.ownerEmail,
                accountType: "staff",
                exp: moment().add(30, "day").unix(),
            },
            config.JWT_SECRET,
            { typ: TOKEN_TYPES.staff }
        ),
    };
};

/**
 * Update staff role
 * @param {Object} data
 * @param {Object} authUser
 * @returns {Object}
 */
const updateRole = async (data, authUser) => {
    const { staffEmail, newRole, faceBase64, masterPassword } = data;

    // Verify client owner
    const clientAccount = await ClientModule.get({ email: authUser.email });
    if (!clientAccount) throw new Error("404:client_not_found");

    const clientJSON = await axios.get(clientAccount.url);

    const decryptedClient = await zelfProofModule.decrypt({
        zelfProof: clientJSON.data.zelfProof,
        faceBase64,
        verifierKey: config.zelfEncrypt.serverKey,
        password: masterPassword,
    });

    if (!decryptedClient) throw new Error("409:verification_failed");

    // Get staff account
    const staffRecords = await IPFSModule.get({ key: "staffEmail", value: staffEmail });
    if (!staffRecords.length) throw new Error("404:staff_not_found");

    const staffAccount = staffRecords[0];
    const staffJSON = await axios.get(staffAccount.url);

    // Update role in staff data
    const updatedStaffData = {
        ...staffJSON.data,
        role: newRole,
    };

    const jsonData = JSON.stringify(updatedStaffData, null, 2);
    const base64Data = Buffer.from(jsonData).toString("base64");

    // Unpin old record
    await IPFSModule.unPinFiles([staffAccount.id]);

    // Create new record
    const newStaffRecord = await IPFSModule.insert(
        {
            base64: base64Data,
            metadata: {
                ...staffAccount.publicData,
                staffRole: newRole,
            },
            name: `${staffEmail}.staff`,
            pinIt: true,
        },
        { pro: true },
    );

    return {
        message: "Staff role updated successfully",
        staffEmail,
        newRole,
        ipfsHash: newStaffRecord.IpfsHash,
    };
};

/**
 * Remove staff member
 * @param {Object} data
 * @param {Object} authUser
 * @returns {Object}
 */
const remove = async (data, authUser) => {
    const { staffEmail, faceBase64, masterPassword } = data;

    // Verify client owner
    const clientAccount = await ClientModule.get({ email: authUser.email });
    if (!clientAccount) throw new Error("404:client_not_found");

    const clientJSON = await axios.get(clientAccount.url);

    const decryptedClient = await zelfProofModule.decrypt({
        zelfProof: clientJSON.data.zelfProof,
        faceBase64,
        verifierKey: config.zelfEncrypt.serverKey,
        password: masterPassword,
    });

    if (!decryptedClient) throw new Error("409:verification_failed");

    // Get and delete staff account
    const staffRecords = await IPFSModule.get({ key: "staffEmail", value: staffEmail });
    if (!staffRecords.length) throw new Error("404:staff_not_found");

    const staffAccount = staffRecords[0];
    await IPFSModule.unPinFiles([staffAccount.id]);

    return {
        message: "Staff member removed successfully",
        staffEmail,
    };
};

/**
 * Handle existing invitation logic (resend or conflict)
 * @param {Array} existingStaff
 * @param {Object} currentData - { staffPhone, staffName, role }
 * @param {boolean} isResend - Explicit flag from frontend
 * @returns {Promise<Object>} - Returns the recovered data object
 */
/**
 * Handle existing invitation logic (resend or conflict)
 * @param {Array} ipfsRecords
 * @param {Object} existingJSON - Full JSON fetched from IPFS
 * @param {Object} currentData - { staffPhone, staffName, role }
 * @param {boolean} isResend - Explicit flag from frontend
 * @returns {Object} - Returns the recovered data object (synchronous now as we fetched data already)
 */
const _processExistingInvitation = (ipfsRecords, existingJSON, currentData, isResend = false) => {
    // Filter for PENDING invitations specifically
    let pendingRecord = ipfsRecords.find((record) => record.invitationStatus === "pending");

    if (!pendingRecord && isResend) {
        // If explicit resend, find any record that is NOT a full account
        pendingRecord = ipfsRecords.find((record) => {
            const isFullAccount = record.accountType === "staff" || record.accountType === "staff_account";
            return !isFullAccount;
        });
    }

    // If the user exists but has NO pending invitation/record we can overwrite, it means they are active.
    if (!pendingRecord) throw new Error("403:staff_already_exists");

    let recoveredData = { ...currentData };

    // ONLY recover data from existing JSON if missing in current request
    // Do NOT overwrite values that the frontend explicitly sent
    if (!recoveredData.staffPhone && existingJSON.staffPhone) {
        recoveredData.staffPhone = existingJSON.staffPhone;
    }
    if (!recoveredData.staffName && (existingJSON.staffName || existingJSON.name)) {
        recoveredData.staffName = existingJSON.staffName || existingJSON.name;
    }

    if (!recoveredData.role && (existingJSON.role || existingJSON.staffRole)) {
        recoveredData.role = existingJSON.role || existingJSON.staffRole;
    }

    // Final validation
    if (!recoveredData.staffPhone) throw new Error("400:missing_staff_phone_for_resend");
    if (!recoveredData.staffName) throw new Error("400:missing_staff_name_for_resend");
    if (!recoveredData.role) throw new Error("400:missing_role_for_resend");

    // Unpin old records
    const recordsToRemove = ipfsRecords.filter(
        (r) => r.invitationStatus === "pending" || (isResend && r.accountType !== "staff" && r.accountType !== "staff_account"),
    );

    if (recordsToRemove.length > 0) {
        IPFSModule.unPinFiles(recordsToRemove.map((r) => r.id)).catch((err) => console.error("Error unpinning old files:", err));
    }

    return recoveredData;
};

/**
 * Save Passkey Metadata to IPFS
 * @param {Object} data { email, phone, passkey }
 */
const savePasskey = async ({ email, phone, passkey }) => {
    const identifiers = [];
    if (email) identifiers.push({ key: "passKeysEmail", value: email });
    if (phone) identifiers.push({ key: "passKeysPhone", value: phone });

    if (identifiers.length === 0) throw new Error("400:missing_identifier");

    const jsonData = JSON.stringify(passkey, null, 2);
    const base64 = Buffer.from(jsonData).toString("base64");

    const promises = identifiers.map(async (item) => {
        // Unpin existing
        const existing = await IPFSModule.get({ key: item.key, value: item.value });
        if (existing.length) {
            await IPFSModule.unPinFiles(existing.map((r) => r.id)).catch((e) => console.warn(e));
        }

        // Insert
        await IPFSModule.insert(
            {
                base64,
                metadata: {
                    [item.key]: item.value, // dynamically set key (passKeysEmail or passKeysPhone)
                    app: "zelf-passkey",
                },
                name: `${item.value}.passkey`, // sanitize phone if needed? IPFS allows +, but maybe better to clean?
                // for simplicity keeping value as is.
                pinIt: true,
            },
            { pro: true },
        );
    });

    await Promise.all(promises);

    return { success: true };
};

/**
 * Get Passkey Metadata from IPFS
 * @param {string} identifier
 */
const getPasskey = async (identifier) => {
    // Try email key first
    let records = [];
    if (identifier.includes("@")) records = await IPFSModule.get({ key: "passKeysEmail", value: identifier });
    else records = await IPFSModule.get({ key: "passKeysPhone", value: identifier });

    if (!records.length) return null;

    try {
        const response = await axios.get(records[0].url);

        return response.data;
    } catch (e) {
        console.error("Failed to fetch passkey data:", e);
        return null;
    }
};

/**
 * Get Passkey IPFS Details (hash and URL)
 * @param {string} identifier
 * @param {string} keyType - "passKeysEmail" or "passKeysPhone"
 */
const getPasskeyIpfsDetails = async (identifier, keyType) => {
    const records = await IPFSModule.get({ key: keyType, value: identifier });

    if (!records.length) {
        throw new Error("404:passkey_not_found_in_ipfs");
    }

    const record = records[0];

    return {
        ipfsHash: record.IpfsHash || record.ipfsHash,
        ipfsUrl: record.url,
        pinned: record.pinned || true,
        createdAt: record.createdAt,
    };
};

/**
 * Delete Passkey from IPFS
 * @param {Object} data { email, phone, identifier }
 */
const deletePasskey = async (jwtUser) => {
    const email = jwtUser.email || jwtUser.staffEmail;

    const phone = jwtUser.phone || jwtUser.staffPhone;

    const identifiers = [];

    if (email) identifiers.push({ key: "passKeysEmail", value: email });

    if (phone) identifiers.push({ key: "passKeysPhone", value: phone });

    if (identifiers.length === 0) throw new Error("400:missing_identifier");

    const promises = identifiers.map(async (item) => {
        // Get existing records
        const existing = await IPFSModule.get({ key: item.key, value: item.value });
        if (existing.length) {
            // Unpin all matching records
            await IPFSModule.unPinFiles(existing.map((r) => r.id)).catch((e) => console.warn(e));
        }
    });

    await Promise.all(promises);

    return { success: true };
};

/**
 * Update staff profile
 * @param {Object} data { staffName, staffEmail, staffPhone, staffCountryCode, staffPhoto }
 * @param {Object} authUser
 * @returns {Object}
 */
const updateProfile = async (data, authUser) => {
    if (authUser.accountType !== "staff_account") throw new Error("400:missing_staff_account");

    const { staffName, staffEmail, staffPhone, staffCountryCode, staffPhoto } = data;

    // Fetch current metadata from IPFS
    const ipfsRecords = await IPFSModule.get({
        key: "staffEmail",
        value: authUser.email,
    });

    if (!ipfsRecords || ipfsRecords.length === 0) throw new Error("Staff member not found");

    const currentRecord = ipfsRecords[0];
    const staffJSON = await axios.get(currentRecord.url);

    // proof of identity = decrypt the zelfProof inside the JSON
    const decryptedStaff = await zelfProofModule.decrypt({
        faceBase64: data.faceBase64,
        password: data.masterPassword || undefined,
        zelfProof: staffJSON.data.zelfProof,
        verifierKey: staffJSON.data.verifierKey || config.zelfEncrypt.serverKey,
    });

    if (!decryptedStaff) throw new Error("409:error_decrypting_zelf_account");

    // Prepare updated metadata
    const ipfsKeyPairValues = {
        ...currentRecord.keyvalues,
    };

    // Update fields if provided
    if (staffName) ipfsKeyPairValues.staffName = staffName;

    if (staffEmail && staffEmail !== currentRecord.keyvalues.staffEmail) {
        // update email in JSON
        staffJSON.data.email = staffEmail;
        // update IPFS key pair values
        ipfsKeyPairValues.staffEmail = staffEmail;
    }

    if (staffPhone && staffPhone !== currentRecord.keyvalues.staffPhone) {
        // update phone in JSON
        staffJSON.data.phone = staffPhone;
        // update IPFS key pair values
        ipfsKeyPairValues.staffPhone = staffPhone;
    }
    if (staffCountryCode && staffCountryCode !== currentRecord.keyvalues.staffCountryCode) {
        // update country code in JSON
        staffJSON.data.countryCode = staffCountryCode;
        // update IPFS key pair values
        ipfsKeyPairValues.staffCountryCode = staffCountryCode;
    }

    // Handle photo upload to IPFS if provided
    if (staffPhoto) {
        try {
            // staffPhoto should be base64 string
            const photoBuffer = Buffer.from(staffPhoto.replace(/^data:image\/\w+;base64,/, ""), "base64");

            // Compress and optimize image using sharp
            // - Resize to max 800x800 while maintaining aspect ratio
            // - Reduce quality to 85%
            // - Convert to JPEG for better compression
            const compressedPhotoBuffer = await sharp(photoBuffer)
                .resize(800, 800, {
                    fit: "inside",
                    withoutEnlargement: true,
                })
                .jpeg({
                    quality: 85,
                    progressive: true,
                })
                .toBuffer();

            // Convert buffer to base64 for IPFS upload
            const compressedPhotoBase64 = compressedPhotoBuffer.toString("base64");

            // Upload compressed photo to IPFS
            const photoIpfsHash = await IPFSModule.insert(
                {
                    base64: compressedPhotoBase64,
                    name: `staff-photo-${authUser.email}-${Date.now()}.jpg`,
                    metadata: {
                        type: "staff_profile_photo",
                        photoEmail: authUser.email,
                        uploadedAt: new Date().toISOString(),
                    },
                    pinIt: true, // Pin the photo for permanent storage
                },
                authUser,
            );

            // update IPFS key pair values
            ipfsKeyPairValues.staffPhoto = photoIpfsHash.id;

            ipfsKeyPairValues.staffPhotoUrl = photoIpfsHash.url;

            // update record json
            staffJSON.data.photoIpfsHash = photoIpfsHash;
            staffJSON.data.photoIpfsUrl = `https://ipfs.io/ipfs/${photoIpfsHash}`;
        } catch (error) {
            console.error("Error uploading photo to IPFS:", error);
            throw new Error("Failed to upload photo to IPFS");
        }
    }

    const base64Data = Buffer.from(JSON.stringify(staffJSON.data)).toString("base64");

    // Create new IPFS record with updated metadata
    const newStaffRecord = await IPFSModule.insert(
        {
            base64: base64Data,
            metadata: {
                staffEmail: ipfsKeyPairValues.staffEmail || currentRecord.keyvalues.staffEmail,
                staffPhone: ipfsKeyPairValues.staffPhone || currentRecord.keyvalues.staffPhone,
                staffCountryCode: ipfsKeyPairValues.staffCountryCode || currentRecord.keyvalues.staffCountryCode,
                staffOwnerEmail: ipfsKeyPairValues.staffOwnerEmail || currentRecord.keyvalues.staffOwnerEmail,
                staffRole: ipfsKeyPairValues.staffRole || currentRecord.keyvalues.staffRole,
                accountType: "staff_account",
                staffName: ipfsKeyPairValues.staffName || currentRecord.keyvalues.staffName,
                staffPhoto: ipfsKeyPairValues.staffPhoto,
                staffPhotoUrl: ipfsKeyPairValues.staffPhotoUrl,
            },
            name: `${ipfsKeyPairValues.staffEmail || currentRecord.keyvalues.staffEmail}.staff`,
            pinIt: true,
        },
        { pro: true },
    );

    // Delete the old IPFS record
    if (newStaffRecord.id) {
        await IPFSModule.unPinFiles([currentRecord.id]);
    }

    // Reconstruct the staff object for frontend session update
    const zelfAccount = {
        ...newStaffRecord,
        publicData: newStaffRecord.keyvalues,
        // Ensure other necessary fields are present if needed by frontend
    };

    return {
        success: true,
        zelfAccount,
        zelfProof: staffJSON.data.zelfProof,
    };
};

module.exports = {
    get,
    generateInvitation,
    validateInvitation,
    createFromInvitation,
    auth,
    updateRole,
    remove,
    savePasskey,
    getPasskey,
    getPasskeyIpfsDetails,
    deletePasskey,
    updateProfile,
};
