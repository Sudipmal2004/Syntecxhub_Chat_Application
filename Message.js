const mongoose = require('mongoose');

const { Schema } = mongoose;

const messageSchema = new Schema(
  {
    sender: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    conversation: { type: Schema.Types.ObjectId, ref: 'Conversation', required: true },
    content: { type: String, required: [true, 'Message content is required'], maxlength: [2000, 'Message must be at most 2000 characters'] },
    // "system" messages announce events such as "Priya joined the room".
    messageType: { type: String, enum: ['text', 'system'], default: 'text' },
    // Users who have read the message (the sender is added on creation).
    readBy: [{ type: Schema.Types.ObjectId, ref: 'User' }],
    // Users whose client has received the message (drives the delivery ticks).
    deliveredTo: [{ type: Schema.Types.ObjectId, ref: 'User' }],
    // Soft delete: the row stays so conversation history and cursors remain consistent.
    isDeleted: { type: Boolean, default: false },
    deletedAt: { type: Date },
    // Client-generated id that makes retried sends idempotent.
    clientId: { type: String, maxlength: 64 },
    // "<senderId>:<clientId>" - unique per sender, only present when the client supplied a clientId.
    clientKey: { type: String, maxlength: 100 },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

// History queries: newest-first cursor pagination inside one conversation.
messageSchema.index({ conversation: 1, _id: -1 });
messageSchema.index({ conversation: 1, createdAt: -1 });
messageSchema.index({ sender: 1 });
// Prevents duplicate rows when a client retries a send it never got an acknowledgement for.
messageSchema.index({ clientKey: 1 }, { unique: true, sparse: true });

messageSchema.set('toJSON', {
  transform(doc, ret) {
    ret.id = String(ret._id);
    delete ret._id;
    delete ret.__v;
    delete ret.clientKey;
    return ret;
  },
});

module.exports = mongoose.models.Message || mongoose.model('Message', messageSchema);
