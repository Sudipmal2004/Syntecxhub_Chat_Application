const mongoose = require('mongoose');
const bcrypt = require('bcrypt');
const config = require('../config/env');

const userSchema = new mongoose.Schema(
  {
    username: {
      type: String,
      required: [true, 'Username is required'],
      trim: true,
      minlength: [3, 'Username must be at least 3 characters'],
      maxlength: [30, 'Username must be at most 30 characters'],
      match: [/^[a-zA-Z0-9_.]+$/, 'Username may only contain letters, numbers, underscores and dots'],
    },
    // Lower-cased copy of username so uniqueness and search are case-insensitive.
    usernameKey: { type: String, unique: true, index: true, select: false },
    email: {
      type: String,
      required: [true, 'Email is required'],
      unique: true,
      lowercase: true,
      trim: true,
      maxlength: 254,
      match: [/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/, 'Please enter a valid email address'],
    },
    password: {
      type: String,
      required: [true, 'Password is required'],
      minlength: [8, 'Password must be at least 8 characters'],
      select: false, // never returned by queries unless explicitly requested
    },
    profilePicture: { type: String, default: '', maxlength: 300 },
    bio: { type: String, default: '', maxlength: 160 },
    status: { type: String, enum: ['online', 'offline'], default: 'offline' },
    lastSeen: { type: Date, default: Date.now },
    // Incremented on logout / password change to invalidate all previously issued JWTs.
    tokenVersion: { type: Number, default: 0, select: false },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

userSchema.index({ status: 1 });

userSchema.pre('validate', function setUsernameKey() {
  if (this.username) this.usernameKey = this.username.toLowerCase();
});

// Runs after validation, so the plain-text password is length-checked before being hashed.
userSchema.pre('save', async function hashPassword() {
  if (this.isModified('password')) {
    this.password = await bcrypt.hash(this.password, config.bcryptRounds);
  }
});

userSchema.methods.comparePassword = function comparePassword(candidate) {
  return bcrypt.compare(candidate, this.password);
};

userSchema.set('toJSON', {
  transform(doc, ret) {
    ret.id = String(ret._id);
    delete ret._id;
    delete ret.__v;
    delete ret.password;
    delete ret.usernameKey;
    delete ret.tokenVersion;
    return ret;
  },
});

module.exports = mongoose.models.User || mongoose.model('User', userSchema);
