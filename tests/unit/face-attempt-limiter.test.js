/**
 * Concurrent face-check opens share one attempt row. The unique index must not surface as a 500.
 */
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const { assertFaceAttemptAllowed } = require("../../Repositories/Face/modules/face-attempt-limiter.module");
const FaceAttemptState = require("../../Repositories/Face/models/face-attempt-state.model");

describe("face attempt limiter", () => {
    let memory;
    const previous = process.env.FACE_ATTEMPT_LIMITER_ENABLED;

    beforeAll(async () => {
        process.env.FACE_ATTEMPT_LIMITER_ENABLED = "true";
        memory = await MongoMemoryServer.create();
        await mongoose.connect(memory.getUri());
        await FaceAttemptState.init();
    }, 180000);

    afterAll(async () => {
        if (previous === undefined) delete process.env.FACE_ATTEMPT_LIMITER_ENABLED;
        else process.env.FACE_ATTEMPT_LIMITER_ENABLED = previous;
        await mongoose.disconnect();
        if (memory) await memory.stop();
    });

    beforeEach(async () => {
        await FaceAttemptState.deleteMany({});
    });

    test("parallel first checks for one identity insert a single row", async () => {
        const results = await Promise.all(
            Array.from({ length: 8 }, () => assertFaceAttemptAllowed({ identityKey: "retrieve:myname.zelf", deviceKey: "session-1" })),
        );
        expect(results.every((row) => row.locked !== true && row.failureCount === 0)).toBe(true);
        expect(await FaceAttemptState.countDocuments({ scope: "identity", key: "retrieve:myname.zelf" })).toBe(1);
    });
});