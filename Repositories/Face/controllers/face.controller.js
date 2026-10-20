const { errorHandler } = require("../../../Core/http-handler");
const FaceSecurity = require("../modules/face-security.module");
const FaceAttemptLimiter = require("../modules/face-attempt-limiter.module");

const issueNonce = async (ctx) => {
    try {
        const { action, bindingIdentifier, sessionKey, identityKey } =
            FaceSecurity.resolveFaceNonceContext(ctx);

        if (!bindingIdentifier) {
            ctx.status = 409;
            ctx.body = {
                message: "Could not resolve face binding identity for this session",
                code: "face_identifier_unresolvable",
            };
            return;
        }

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

        const noncePayload = await FaceSecurity.issueFaceNonce({
            action,
            identifier: bindingIdentifier,
            sessionKey,
            failureCount,
        });

        ctx.body = {
            data: {
                ...noncePayload,
                bindingIdentifier,
            },
        };
    } catch (error) {
        const _exception = errorHandler(error, ctx);
        ctx.status = _exception.status;
        ctx.body = { message: _exception.message, code: _exception.code };
    }
};

module.exports = {
    issueNonce,
};
