const FacePow = require("./face-pow.module");
const FaceNonce = require("./face-nonce.module");
const FaceAttemptLimiter = require("./face-attempt-limiter.module");
const FaceReplay = require("./face-replay.module");
const { pickWhitelistedBody } = require("./face-body-whitelist.module");
const { ZELFPROOF_CLIENT_ERROR_STATUS } = require("../../ZelfProof/modules/zelf-proof.module");
const config = require("../../../Core/config");

const powEnforcement = () => String(config.faceSecurity?.pow?.enforcement || "log").toLowerCase();
const nonceEnforcement = () => String(config.faceSecurity?.nonce?.enforcement || "log").toLowerCase();

const buildIdentifier = (body, ctx) => {
    if (body?.zelfProof) {
        return `zelfProof:${String(body.zelfProof).slice(0, 64)}`;
    }
    const domain = body?.domain || ctx.state?.extractedDomain;
    const tagName = body?.tagName;
    if (tagName && domain) {
        return `${String(tagName).toLowerCase()}@${String(domain).toLowerCase()}`;
    }
    if (body?.identifier) return String(body.identifier);
    if (body?.zelfName) return `${String(body.zelfName).toLowerCase()}@${String(domain || "zelf").toLowerCase()}`;
    if (body?.id) return `record:${body.id}`;
    if (body?.owner) return `wallet:${String(body.owner).toLowerCase()}`;
    if (body?.email) return `email:${String(body.email).toLowerCase()}`;
    if (body?.staffEmail) return `staff:${String(body.staffEmail).toLowerCase()}`;
    if (body?.lawyerEmail) return `lawyer:${String(body.lawyerEmail).toLowerCase()}`;
    return "unknown";
};

const sessionKeyFromUser = (authUser) => {
    if (!authUser) return "anonymous";
    return String(authUser.session || authUser.identifier || authUser.ip || "anonymous");
};

const respondPowRequired = (ctx, challenge) => {
    ctx.status = 428;
    ctx.body = {
        message: "Proof of work required",
        code: "pow_required",
        pow: challenge,
    };
};

const respondClientError = (ctx, status, code, extra = {}) => {
    ctx.status = status;
    ctx.body = {
        message: code.replace(/_/g, " "),
        code,
        ...extra,
    };
};

const isFaceFailureResponse = (ctx) => {
    const status = ctx.status;
    if (!status || status < 400) return false;
    const code = ctx.body?.code;
    if (code === "ERR_VERIFICATION_FAILED" || code === "ERR_INVALID_PASSWORD") return true;
    if (status === 401 || status === 422) return true;
    if (code && Object.keys(ZELFPROOF_CLIENT_ERROR_STATUS).includes(code)) {
        return code !== "ERR_PASSWORD_REQUIRED";
    }
    const msg = String(ctx.body?.message || "").toUpperCase();
    return msg.includes("LIVENESS") || msg.includes("FACE") || msg.includes("VERIFICATION");
};

/**
 * Issue nonce (+ optional PoW) for POST /api/face/nonce
 */
const issueFaceNonce = async ({ action, identifier, sessionKey, failureCount = 0 }) => {
    const nonceResult = await FaceNonce.createNonce({ action, identifier, sessionKey });
    const payload = { ...nonceResult };

    const powAfter = config.faceSecurity?.attemptLimiter?.powAfterFailures || 2;
    if (failureCount >= powAfter) {
        payload.pow = await FacePow.issueChallenge({ action, identifier, failureCount });
    }

    return payload;
};

/**
 * Pre-handler checks: lockout, PoW, nonce, replay, body whitelist.
 */
const runFaceSecurityPre = async (ctx, action) => {
    const authUser = ctx.state.user || {};
    const rawBody = ctx.request.body || {};
    const { body, rejected } = pickWhitelistedBody(rawBody, action);

    if (rejected.length) {
        console.info("[face-security] stripped body keys", {
            action,
            rejected,
            path: ctx.path,
        });
    }

    ctx.request.body = body;

    const hasFace = body.faceBase64 != null && String(body.faceBase64).trim() !== "";
    if (!hasFace) {
        return true;
    }

    const identifier = buildIdentifier(body, ctx);
    const sessionKey = sessionKeyFromUser(authUser);
    const ip = ctx.request.ip;

    ctx.state.faceSecurity = {
        action,
        identifier,
        sessionKey,
        ip,
    };

    const { failureCount, powRequired } = await FaceAttemptLimiter.assertFaceAttemptAllowed({
        identityKey: `${action}:${identifier}`,
        ip,
        deviceKey: sessionKey,
    });

    const powPayload = body.pow;
    if (powRequired) {
        if (!powPayload?.challengeId || powPayload.solution === undefined) {
            const challenge = await FacePow.issueChallenge({ action, identifier, failureCount });
            if (powEnforcement() === "require") {
                respondPowRequired(ctx, challenge);
                return false;
            }
            console.info("[face-security] pow missing (log mode)", { action, identifier, path: ctx.path });
        } else {
            const verified = await FacePow.verifySolution({
                challengeId: powPayload.challengeId,
                salt: powPayload.salt,
                difficulty: powPayload.difficulty,
                expiresAt: powPayload.expiresAt,
                signature: powPayload.signature,
                solution: powPayload.solution,
                identifier,
                action,
            });
            if (!verified.ok) {
                const challenge = await FacePow.issueChallenge({ action, identifier, failureCount });
                if (powEnforcement() === "require") {
                    if (verified.code === "face_pow_invalid") {
                        respondClientError(ctx, 409, "face_pow_invalid", { pow: challenge });
                    } else {
                        respondPowRequired(ctx, challenge);
                    }
                    return false;
                }
                console.info("[face-security] pow invalid (log mode)", { action, identifier, path: ctx.path });
            }
        }
    }

    const faceNonce = body.faceNonce;
    if (!faceNonce) {
        if (nonceEnforcement() === "require") {
            respondClientError(ctx, 409, "face_nonce_missing");
            return false;
        }
        console.info("[face-security] faceNonce missing (log mode)", { action, identifier, path: ctx.path });
    } else {
        const consumed = await FaceNonce.consumeNonce({
            nonce: faceNonce,
            action,
            identifier,
            sessionKey,
        });
        if (!consumed.ok) {
            if (nonceEnforcement() === "require") {
                respondClientError(ctx, 409, consumed.code || "face_nonce_invalid");
                return false;
            }
            console.info("[face-security] faceNonce not consumed (log mode)", {
                action,
                identifier,
                code: consumed.code,
            });
        }
    }

    if (body.faceBase64) {
        await FaceReplay.checkNotReplay({
            faceBase64: body.faceBase64,
            identifier,
            action,
        });
    }

    return true;
};

const runFaceSecurityPost = async (ctx) => {
    const meta = ctx.state.faceSecurity;
    if (!meta) return;

    const identityKey = `${meta.action}:${meta.identifier}`;
    try {
        if (isFaceFailureResponse(ctx)) {
            await FaceAttemptLimiter.recordFailedAttempt({
                identityKey,
                ip: meta.ip,
                deviceKey: meta.sessionKey,
            });
            console.warn("[face-security] face attempt failed", {
                action: meta.action,
                identifier: meta.identifier,
                status: ctx.status,
                code: ctx.body?.code,
            });
        } else if (ctx.status && ctx.status < 400) {
            await FaceAttemptLimiter.recordSuccessfulAttempt({
                identityKey,
                deviceKey: meta.sessionKey,
            });
            if (ctx.request.body?.faceBase64) {
                await FaceReplay.recordReplay({
                    faceBase64: ctx.request.body.faceBase64,
                    identifier: meta.identifier,
                    action: meta.action,
                });
            }
        }
    } catch (err) {
        console.error("[face-security] post-hook error", err?.message || err);
    }
};

module.exports = {
    buildIdentifier,
    sessionKeyFromUser,
    issueFaceNonce,
    runFaceSecurityPre,
    runFaceSecurityPost,
    isFaceFailureResponse,
};
