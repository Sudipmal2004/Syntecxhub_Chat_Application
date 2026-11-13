const mongoose = require('mongoose');

const { Schema } = mongoose;

const conversationSchema = new Schema(
  {
    participants: [{ type: Schema.Types.ObjectId, ref: 'User', required: true }],
    conversationType: { type: String, enum: ['private', 'group'], required: true, default: 'private' },
    groupName: { type: String, trim: true, maxlength: 50 },
    groupAdmin: { type: Schema.Types.ObjectId, ref: 'User' },
    // Public groups appear in room discovery and can be joined by anyone.
    isPublic: { type: Boolean, default: false },
    // Private chats only: the two participant ids, sorted and joined. A unique index on
    // this key guarantees two users can never end up with duplicate private conversations.
    participantsKey: { type: String },
    lastMessage: { type: Schema.Types.ObjectId, ref: 'Message' },
  },
  { timestamps: true } // createdAt + updatedAt (updatedAt is bumped on every new message)
);

conversationSchema.index({ participants: 1, updatedAt: -1 });
// Sparse: group conversations have no participantsKey and are simply not indexed.
conversationSchema.index({ participantsKey: 1 }, { unique: true, sparse: true });
conversationSchema.index({ conversationType: 1, isPublic: 1, updatedAt: -1 });

conversationSchema.pre('validate', function checkShape() {
  if (this.conversationType === 'private') {
    if (this.participants.length !== 2) this.invalidate('participants', 'A private conversation needs exactly 2 participants');
  } else {
    if (!this.groupName) this.invalidate('groupName', 'Group name is required');
    if (!this.groupAdmin) this.invalidate('groupAdmin', 'Group admin is required');
  }
});

conversationSchema.statics.makePrivateKey = function makePrivateKey(idA, idB) {
  return [String(idA), String(idB)].sort().join(':');
};

conversationSchema.set('toJSON', {
  transform(doc, ret) {
    ret.id = String(ret._id);
    delete ret._id;
    delete ret.__v;
    delete ret.participantsKey;
    return ret;
  },
});

module.exports = mongoose.models.Conversation || mongoose.model('Conversation', conversationSchema);
