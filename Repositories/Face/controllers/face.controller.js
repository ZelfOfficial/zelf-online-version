const { errorHandler } = require("../../../Core/http-handler");
const FaceSecurity = require("../modules/face-security.module");
const FaceAttemptLimiter = require("../modules/face-attempt-limiter.module");

const issueNonce = async (ctx) => {
    try {
        const { action, identifier } = ctx.request.body;
        const sessionKey = FaceSecurity.sessionKeyFromUser(ctx.state.user);
        const identityKey = `${action}:${identifier}`;

        let failureCount = 0;
        try {
            const check = await FaceAttemptLimiter.assertFaceAttemptAllowed({
                identityKey,
                ip: ctx.request.ip,
                deviceKey: sessionKey,
            });
            failureCount = check.failureCount || 0;
        } catch (err) {
            if (err.clientCode === "face_locked") {
                const retryAfter = err.retryAfterSeconds || 60;
                ctx.status = 429;
                ctx.set("Retry-After", String(retryAfter));
                ctx.body = {
                    message: "Too many failed face attempts",
                    code: "face_locked",
                    retryAfter,
                };
                return;
            }
            throw err;
        }

        const data = await FaceSecurity.issueFaceNonce({
            action,
            identifier,
            sessionKey,
            failureCount,
        });

        ctx.body = { data };
    } catch (error) {
        const _exception = errorHandler(error, ctx);
        ctx.status = _exception.status;
        ctx.body = { message: _exception.message, code: _exception.code };
    }
};

module.exports = {
    issueNonce,
};
