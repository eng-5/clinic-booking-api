// src/schemas/resetSchema.js
const { z } = require('zod');

// Ids and providers are kept exactly as sent (no trimming): they are identifiers, and a
// slot id the caller sends must be the one they can book later.
const slotSchema = z.object({
    id: z.string().min(1).max(200),
    provider: z.string().min(1).max(200),
    // ISO 8601 with a time. Zod also rejects impossible dates such as 2026-02-30.
    start: z.iso.datetime({ offset: true }),
    end: z.iso.datetime({ offset: true }),
});

const resetBodySchema = z.object({
    slots: z.array(slotSchema).superRefine((slots, ctx) => {
        const seen = new Set();
        for (const [index, slot] of slots.entries()) {
            if (seen.has(slot.id)) {
                ctx.addIssue({
                    code: 'custom',
                    path: [index, 'id'],
                    message: `duplicate slot id: ${slot.id}`,
                });
            }
            seen.add(slot.id);
        }
    }),
});

module.exports = { resetBodySchema };