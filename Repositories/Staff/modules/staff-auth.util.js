const STAFF_NOT_IN_CLIENT = "STAFF_NOT_IN_CLIENT";
const PASSKEY_OWNER_MISMATCH = "PASSKEY_OWNER_MISMATCH";

const codedError = (code, status) => {
    const error = new Error(code);
    error.status = status;
    error.code = code;
    return error;
};

const isStaffAccount = (authUser) => authUser?.accountType === "staff" || authUser?.accountType === "staff_account";

const callerClientEmail = (authUser) => {
    const email = isStaffAccount(authUser) ? authUser?.ownerEmail : authUser?.email;
    return typeof email === "string" ? email.trim() : "";
};

const callerIsClientAdmin = (authUser) => {
    if (!callerClientEmail(authUser)) return false;
    if (!isStaffAccount(authUser)) return true;
    return authUser?.role === "admin";
};

const assertStaffRoleChangeAllowed = (authUser, staffOwnerEmail) => {
    const clientEmail = callerClientEmail(authUser);
    const targetOwner = typeof staffOwnerEmail === "string" ? staffOwnerEmail.trim().toLowerCase() : "";

    if (!callerIsClientAdmin(authUser) || !clientEmail || targetOwner !== clientEmail.toLowerCase()) {
        throw codedError(STAFF_NOT_IN_CLIENT, 403);
    }

    return clientEmail;
};

const assertPasskeyOwner = (authUser, { email, phone } = {}) => {
    const sessionEmailRaw = authUser?.email || authUser?.staffEmail || "";
    const sessionPhoneRaw = authUser?.phone || authUser?.staffPhone || "";
    const sessionEmail = String(sessionEmailRaw).trim().toLowerCase();
    const sessionPhone = String(sessionPhoneRaw).trim();
    const requestedEmail = String(email || "").trim().toLowerCase();
    const requestedPhone = String(phone || "").trim();

    if (!sessionEmail && !sessionPhone) {
        throw codedError(PASSKEY_OWNER_MISMATCH, 403);
    }

    if (requestedEmail && requestedEmail !== sessionEmail) {
        throw codedError(PASSKEY_OWNER_MISMATCH, 403);
    }

    if (requestedPhone && requestedPhone !== sessionPhone) {
        throw codedError(PASSKEY_OWNER_MISMATCH, 403);
    }

    return {
        email: sessionEmail ? String(sessionEmailRaw).trim() : undefined,
        phone: sessionPhone || undefined,
    };
};

module.exports = {
    STAFF_NOT_IN_CLIENT,
    PASSKEY_OWNER_MISMATCH,
    callerClientEmail,
    callerIsClientAdmin,
    assertStaffRoleChangeAllowed,
    assertPasskeyOwner,
};
