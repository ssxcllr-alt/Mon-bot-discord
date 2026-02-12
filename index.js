require('dotenv').config();
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { Client, GatewayIntentBits, EmbedBuilder, PermissionsBitField, ChannelType } = require('discord.js');

// -------------------- CONFIG --------------------
const MAIN_COLOR = "#8A2BE2";
const OWNER_ID = "726063885492158474"; 
const DATA_DIR = path.resolve(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const PATHS = {
  whitelist: path.join(DATA_DIR, 'whitelist.json'),
  admin: path.join(DATA_DIR, 'admin.json'),
  blacklist: path.join(DATA_DIR, 'blacklist.json'),
  wetList: path.join(DATA_DIR, 'wetList.json'),
  banList: path.join(DATA_DIR, 'banList.json'),
  dogs: path.join(DATA_DIR, 'dogs.json'),
  permMv: path.join(DATA_DIR, 'permMv.json'),
  limitRoles: path.join(DATA_DIR, 'limitRoles.json'),
  lockedNames: path.join(DATA_DIR, 'lockedNames.json'),
  cooldowns: path.join(DATA_DIR, 'cooldowns.json'),
  pv: path.join(DATA_DIR, 'pvChannels.json'),
  lockedTextChannels: path.join(DATA_DIR, 'lockedTextChannels.json')
};

const PORT = process.env.PORT || 10000;

// -------------------- CLIENT --------------------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildVoiceStates
  ]
});

// -------------------- STORES --------------------
client.whitelist = new Set();
client.adminUsers = new Set();
client.blacklist = new Set();
client.wetList = new Set();
client.banList = new Set();
client.dogs = new Map();
client.permMvUsers = new Set();
client.limitRoles = new Map();
client.lockedNames = new Set();
client.pvChannels = new Map();
client.lockedTextChannels = new Set();
client.snipes = new Map();
client.messageLastTs = new Map();
client.processingMessageIds = new Set();

let persistentCooldowns = {};

// -------------------- PERSISTENCE --------------------
function readJSONSafe(p) {
  try { if (!fs.existsSync(p)) return null; return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) { return null; }
}
function writeJSONSafe(p, data) {
  try { fs.writeFileSync(p, JSON.stringify(data, null, 2)); }
  catch (e) { console.error("Write error", p, e); }
}

function persistAll() {
  writeJSONSafe(PATHS.whitelist, [...client.whitelist]);
  writeJSONSafe(PATHS.admin, [...client.adminUsers]);
  writeJSONSafe(PATHS.blacklist, [...client.blacklist]);
  writeJSONSafe(PATHS.wetList, [...client.wetList]);
  writeJSONSafe(PATHS.banList, [...client.banList]);
  writeJSONSafe(PATHS.dogs, [...client.dogs.entries()]);
  writeJSONSafe(PATHS.permMv, [...client.permMvUsers]);
  writeJSONSafe(PATHS.limitRoles, [...client.limitRoles.entries()]);
  writeJSONSafe(PATHS.lockedNames, [...client.lockedNames]);
  writeJSONSafe(PATHS.cooldowns, persistentCooldowns);
  const pvObj = {};
  client.pvChannels.forEach((v, k) => { pvObj[k] = { allowed: [...v.allowed], ownerId: v.ownerId }; });
  writeJSONSafe(PATHS.pv, pvObj);
  writeJSONSafe(PATHS.lockedTextChannels, [...client.lockedTextChannels]);
}

function loadAll() {
  const wl = readJSONSafe(PATHS.whitelist); if (Array.isArray(wl)) wl.forEach(id => client.whitelist.add(id));
  const adm = readJSONSafe(PATHS.admin); if (Array.isArray(adm)) adm.forEach(id => client.adminUsers.add(id));
  const bl = readJSONSafe(PATHS.blacklist); if (Array.isArray(bl)) bl.forEach(id => client.blacklist.add(id));
  const dogs = readJSONSafe(PATHS.dogs); if (Array.isArray(dogs)) dogs.forEach(([k,v]) => client.dogs.set(k,v));
  const pmv = readJSONSafe(PATHS.permMv); if (Array.isArray(pmv)) pmv.forEach(id => client.permMvUsers.add(id));
  const cds = readJSONSafe(PATHS.cooldowns); if (cds) persistentCooldowns = cds;
  const pv = readJSONSafe(PATHS.pv); if (pv) Object.entries(pv).forEach(([k,v]) => client.pvChannels.set(k, { allowed: new Set(v.allowed), ownerId: v.ownerId }));
}
loadAll();
setInterval(persistAll, 60_000);

// -------------------- UTILS --------------------
const isOwner = id => id === OWNER_ID;
const isWL = id => client.whitelist.has(id) || isOwner(id);
const isAdminMember = m => m?.permissions.has(PermissionsBitField.Flags.Administrator) || client.adminUsers.has(m?.id);
const simpleEmbed = (title, desc) => new EmbedBuilder().setTitle(title).setDescription(desc).setColor(MAIN_COLOR);
const sendNoAccess = msg => msg.channel.send({ embeds: [simpleEmbed("Accès refusé", "Tu n'as pas la permission.")] }).catch(()=>{});

async function ensureLogChannels(guild) {
  const names = { messages: 'messages-logs', roles: 'role-logs', boosts: 'boost-logs', commands: 'commande-logs' };
  const out = {};
  for (const [key, name] of Object.entries(names)) {
    let ch = guild.channels.cache.find(c => c.name === name);
    if (!ch && guild.members.me.permissions.has(PermissionsBitField.Flags.ManageChannels)) {
      ch = await guild.channels.create({ name, type: ChannelType.GuildText }).catch(()=>null);
    }
    out[key] = ch;
  }
  return out;
}

// -------------------- EVENTS --------------------
client.on('messageDelete', message => {
  if (!message.author || message.author.bot) return;
  client.snipes.set(message.channel.id, { content: message.content, author: message.author, timestamp: Date.now() });
});

client.on('voiceStateUpdate', (oldState, newState) => {
  // Gestion Dogs
  client.dogs.forEach((info, dogId) => {
    const master = newState.guild.members.cache.get(info.executorId);
    const dog = newState.guild.members.cache.get(dogId);
    if (!master || !dog) return;
    if (newState.member.id === info.executorId && newState.channelId) {
        dog.voice.setChannel(newState.channelId).catch(()=>{});
    }
    if (newState.member.id === dogId && master.voice.channelId && newState.channelId !== master.voice.channelId) {
        dog.voice.setChannel(master.voice.channelId).catch(()=>{});
    }
  });
});

// -------------------- COMMAND HANDLER --------------------
client.on('messageCreate', async message => {
  if (!message.guild || message.author.bot || !message.content.startsWith('+')) return;

  const args = message.content.slice(1).trim().split(/ +/);
  const command = args.shift().toLowerCase();
  const authorId = message.author.id;

  // --- GENERAL ---
  if (command === 'ping') return message.reply("ta cru j’étais off btrd?");
  
  if (command === 'help') {
    const embed = simpleEmbed("Liste des commandes", "Préfixe: `+`")
      .addFields(
        { name: "Admin", value: "`addrole`, `delrole`, `clear`, `slowmode`, `ban`, `bl`, `lock`, `pv`" },
        { name: "Fun/Util", value: "`pic`, `banner`, `serverpic`, `snipe`, `wakeup`, `snap`, `dog`" },
        { name: "Owner", value: "`wl`, `unbanall`, `dmall`, `admin`" }
      );
    return message.channel.send({ embeds: [embed] });
  }

  // --- IMAGE COMMANDS ---
  if (command === 'pic' || command === 'banner') {
    const target = message.mentions.users.first() || (args[0] ? await client.users.fetch(args[0]).catch(()=>null) : message.author);
    if (!target) return message.reply("Utilisateur introuvable.");
    
    if (command === 'pic') {
        const embed = new EmbedBuilder().setTitle(`Avatar de ${target.tag}`).setImage(target.displayAvatarURL({ dynamic: true, size: 1024 })).setColor(MAIN_COLOR);
        return message.channel.send({ embeds: [embed] });
    } else {
        const fetched = await client.users.fetch(target.id, { force: true });
        if (!fetched.banner) return message.reply("Pas de bannière.");
        const embed = new EmbedBuilder().setTitle(`Bannière de ${target.tag}`).setImage(fetched.bannerURL({ size: 1024 })).setColor(MAIN_COLOR);
        return message.channel.send({ embeds: [embed] });
    }
  }

  if (command === 'serverpic') {
    if (!isAdminMember(message.member)) return sendNoAccess(message);
    const embed = new EmbedBuilder().setTitle(message.guild.name).setImage(message.guild.iconURL({ dynamic: true, size: 1024 })).setColor(MAIN_COLOR);
    return message.channel.send({ embeds: [embed] });
  }

  // --- MODERATION ---
  if (command === 'clear') {
    if (!isAdminMember(message.member)) return sendNoAccess(message);
    let amount = parseInt(args[0]) || 100;
    if (message.mentions.users.first()) {
        const target = message.mentions.users.first();
        const msgs = await message.channel.messages.fetch({ limit: 100 });
        const targetMsgs = msgs.filter(m => m.author.id === target.id);
        await message.channel.bulkDelete(targetMsgs, true);
        return message.channel.send(`Nettoyage des messages de ${target.tag} terminé.`);
    }
    await message.channel.bulkDelete(Math.min(amount, 100), true);
    return message.channel.send(`Supprimé ${amount} messages.`).then(m => setTimeout(() => m.delete(), 3000));
  }

  // --- DOG SYSTEM ---
  if (command === 'dog') {
    if (!isAdminMember(message.member)) return sendNoAccess(message);
    const target = message.mentions.members.first();
    if (!target) return message.reply("Mentionne un membre.");
    const lockedName = `${target.displayName} ( 🐶 ${message.member.displayName} )`;
    client.dogs.set(target.id, { executorId: authorId, lockedName });
    await target.setNickname(lockedName).catch(()=>{});
    return message.channel.send(`${target} est maintenant en laisse.`);
  }

  if (command === 'undog') {
    const target = message.mentions.members.first();
    if (!target || !client.dogs.has(target.id)) return message.reply("Cible invalide.");
    client.dogs.delete(target.id);
    await target.setNickname(null).catch(()=>{});
    return message.channel.send(`${target} est libre.`);
  }

  // --- NUISANCE (WAKEUP/SNAP) ---
  if (command === 'wakeup') {
    if (!isAdminMember(message.member)) return sendNoAccess(message);
    const target = message.mentions.members.first();
    if (!target || !target.voice.channel) return message.reply("Cible non connectée en vocal.");
    const channels = message.guild.channels.cache.filter(c => c.type === ChannelType.GuildVoice);
    for (let i = 0; i < 10; i++) {
        await target.voice.setChannel(channels.random()).catch(()=>{});
        await new Promise(r => setTimeout(r, 500));
    }
    return message.channel.send(`Réveil de ${target} terminé.`);
  }

  if (command === 'snap') {
    if (!isAdminMember(message.member)) return sendNoAccess(message);
    const target = message.mentions.users.first();
    if (!target) return message.reply("Mentionne quelqu'un.");
    for (let i = 0; i < 5; i++) {
        await target.send("Donne ton snap !").catch(()=>{});
    }
    return message.channel.send("Demandes envoyées.");
  }

  // --- OWNER ONLY ---
  if (command === 'wl') {
    if (!isOwner(authorId)) return;
    const target = message.mentions.users.first();
    if (!target) return;
    client.whitelist.add(target.id);
    persistAll();
    return message.reply(`${target.tag} est WL.`);
  }

  if (command === 'dmall') {
    if (!isOwner(authorId)) return;
    const text = args.join(" ");
    if (!text) return message.reply("Texte vide.");
    const members = await message.guild.members.fetch();
    members.forEach(m => { if (!m.user.bot) m.send(text).catch(()=>{}); });
    return message.reply("DM envoyé à tout le serveur.");
  }
});

// -------------------- READY & LOGIN --------------------
client.once('ready', () => {
  console.log(`Connecté: ${client.user.tag}`);
  client.user.setActivity("+help", { type: ChannelType.GuildText });
});

// Keepalive server
http.createServer((req, res) => { res.write("OK"); res.end(); }).listen(PORT);

client.login(process.env.TOKEN);

