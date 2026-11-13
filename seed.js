/* Fills the database with demo users, conversations and backdated messages.
   Usage: npm run seed          (all demo accounts use the password  Demo@1234)
   Safe to run more than once: it only creates what is missing. */

const mongoose = require('mongoose');
const config = require('../config/env');
const { connectDB } = require('../config/db');
const User = require('../models/User');
const Conversation = require('../models/Conversation');
const Message = require('../models/Message');

const PASSWORD = 'Demo@1234';
const USERS = [
  { username: 'alex_morgan', email: 'alex@example.com', bio: 'Product designer. Coffee first, Figma second.' },
  { username: 'priya_sharma', email: 'priya@example.com', bio: 'Frontend engineer who loves tidy CSS.' },
  { username: 'rahul_verma', email: 'rahul@example.com', bio: 'Backend developer - Node, Mongo, caffeine.' },
  { username: 'ananya_iyer', email: 'ananya@example.com', bio: 'QA lead. I break things politely.' },
  { username: 'kabir_singh', email: 'kabir@example.com', bio: 'Weekend trekker and part-time DevOps.' },
  { username: 'meera_nair', email: 'meera@example.com', bio: 'Technical writer.' },
];

const minutesAgo = (m) => new Date(Date.now() - m * 60 * 1000);

async function ensureUser(spec) {
  let user = await User.findOne({ email: spec.email });
  if (!user) user = await User.create({ ...spec, password: PASSWORD });
  return user;
}

async function ensurePrivate(a, b) {
  const key = Conversation.makePrivateKey(a._id, b._id);
  return (await Conversation.findOne({ participantsKey: key })) || Conversation.create({ participants: [a._id, b._id], conversationType: 'private', participantsKey: key });
}

/** script: [senderUser, text, minutesAgo, readByEveryone] */
async function addMessages(conversation, script, members) {
  if (await Message.exists({ conversation: conversation._id })) return;
  let last;
  for (const [sender, content, ago, read] of script) {
    last = await Message.create({
      sender: sender._id,
      conversation: conversation._id,
      content,
      messageType: 'text',
      createdAt: minutesAgo(ago),
      readBy: read ? members.map((m) => m._id) : [sender._id],
      deliveredTo: members.map((m) => m._id),
    });
  }
  await Conversation.updateOne({ _id: conversation._id }, { $set: { lastMessage: last._id, updatedAt: last.createdAt } }, { timestamps: false });
}

async function seed() {
  const created = [];
  for (const spec of USERS) created.push(await ensureUser(spec));
  const [alex, priya, rahul, ananya, kabir, meera] = created;

  const day = 24 * 60;
  const withPriya = await ensurePrivate(alex, priya);
  await addMessages(withPriya, [
    [priya, 'Hey Alex! Did you get a chance to look at the new onboarding screens?', day + 190, true],
    [alex, 'Yes - the progress indicator is lovely. Could we make the purple a touch lighter?', day + 184, true],
    [priya, 'Done, pushing the tweak now.', day + 180, true],
    [alex, 'Perfect. Are we still on for the design review this afternoon?', 95, true],
    [priya, 'Absolutely, 3 PM works for me. I will share the prototype link beforehand.', 91, true],
    [alex, 'Great, see you there!', 88, true],
  ], [alex, priya]);

  const withRahul = await ensurePrivate(alex, rahul);
  await addMessages(withRahul, [
    [rahul, 'The message history endpoint now supports cursor pagination.', 300, true],
    [alex, 'Nice - the infinite scroll feels instant now.', 296, true],
    [rahul, 'Deploying the Socket.IO fix tonight. Reconnects should be seamless.', 240, true],
  ], [alex, rahul]);

  const withAnanya = await ensurePrivate(alex, ananya);
  await addMessages(withAnanya, [
    [alex, 'Can you re-test the profile upload flow when you have a minute?', 70, true],
    [ananya, 'Tested on mobile and desktop - all green.', 41, false],
    [ananya, 'One small thing: the avatar crop looks off on Safari. Screenshot attached in the ticket.', 38, false],
    [ananya, 'Let me know when it is fixed and I will verify.', 37, false],
  ], [alex, ananya]);

  let phoenix = await Conversation.findOne({ conversationType: 'group', groupName: 'Project Phoenix' });
  if (!phoenix) {
    phoenix = await Conversation.create({ participants: [alex._id, priya._id, rahul._id, ananya._id], conversationType: 'group', groupName: 'Project Phoenix', groupAdmin: alex._id, isPublic: true });
  }
  await addMessages(phoenix, [
    [alex, 'Alex created the room "Project Phoenix"', day + 400, true],
    [rahul, 'API docs are published in the wiki. Please skim before Thursday.', 280, true],
    [priya, 'Dark mode tokens are merged. Thanks for the review, Ananya!', 205, true],
    [ananya, 'Regression suite finished: 212 passed, 0 failed.', 150, true],
    [alex, 'Fantastic work, team. Release candidate goes out tomorrow morning.', 120, true],
    [rahul, 'I will keep an eye on the logs during rollout.', 22, false],
    [priya, 'Pizza on me if the deploy is clean.', 12, false],
  ], [alex, priya, rahul, ananya]);
  // The first line is a system message announcing the room.
  await Message.updateOne({ conversation: phoenix._id, content: /created the room/ }, { $set: { messageType: 'system' } });

  let hikers = await Conversation.findOne({ conversationType: 'group', groupName: 'Weekend Hikers' });
  if (!hikers) {
    hikers = await Conversation.create({ participants: [kabir._id, meera._id], conversationType: 'group', groupName: 'Weekend Hikers', groupAdmin: kabir._id, isPublic: true });
    await Conversation.create({ participants: [kabir._id, priya._id, rahul._id], conversationType: 'group', groupName: 'Open Source Club', groupAdmin: kabir._id, isPublic: true });
  }
  return { password: PASSWORD, users: USERS.map((u) => u.email) };
}

module.exports = { seed, PASSWORD };

if (require.main === module) {
  (async () => {
    await connectDB();
    const result = await seed();
    console.log(`\nSeeded demo data into ${config.mongoUri}`);
    console.log(`Log in with any of: ${result.users.join(', ')}\nPassword for all: ${result.password}\n`);
    await mongoose.disconnect();
  })().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
