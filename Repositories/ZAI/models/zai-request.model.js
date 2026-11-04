const mongoose = require("mongoose");

/**
 * One zAI question handed to Angela's webhook. The waiting SSE handler (any process) polls this
 * document for the answer; GET /api/zai/result/:requestId reads it after a dropped stream.
 * Only the redacted answer and server-built cards are stored, never the question or tool context.
 */
const ZaiRequestSchema = new mongoose.Schema(
    {
        requestId: { type: String, required: true, unique: true },
        zelfName: { type: String, required: true, index: true },
        status: { type: String, enum: ["pending", "answered", "failed"], default: "pending" },
        text: { type: String, default: "" },
        filtered: { type: Boolean, default: false },
        cards: { type: Array, default: [] },
        rulesVersion: { type: String, default: "" },
        replyDeadline: { type: Date, required: true },
        answeredAt: { type: Date, default: null },
        expiresAt: { type: Date, required: true },
    },
    { timestamps: true }
);

ZaiRequestSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.models.ZaiRequest || mongoose.model("ZaiRequest", ZaiRequestSchema, "zai_requests");
