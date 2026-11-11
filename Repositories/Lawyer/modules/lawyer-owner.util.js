const OWNER_REQUIRED = "OWNER_REQUIRED";

const requirePreferencesOwner = (authUser) => {
    const owner = authUser?.email;
    if (typeof owner !== "string" || !owner.trim() || owner.trim() === "undefined") {
        const error = new Error(OWNER_REQUIRED);
        error.status = 401;
        error.code = OWNER_REQUIRED;
        throw error;
    }

    return owner.trim();
};

module.exports = {
    OWNER_REQUIRED,
    requirePreferencesOwner,
};
