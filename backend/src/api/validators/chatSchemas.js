const { z } = require('zod');

const chatBodySchema = z.object({
  message: z.string().min(1).max(10000),
  conversationId: z.string().uuid().optional(),
});

module.exports = { chatBodySchema };
