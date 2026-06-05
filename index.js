require('dotenv').config();
const {
    Client,
    GatewayIntentBits,
    Partials,
    REST,
    Routes,
    SlashCommandBuilder,
    EmbedBuilder,
    PermissionFlagsBits
} = require('discord.js');
const express = require('express');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

// ============================================================
// VARIABLES D'ENVIRONNEMENT REQUISES (.env ou Render)
// DISCORD_TOKEN        — Token du bot
// DISCORD_CLIENT_ID   — ID de l'application
// DISCORD_GUILD_ID    — ID du serveur
// ============================================================

const DATA_DIR = './data';
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

function loadJSON(file, defaultVal = {}) {
    const filePath = path.join(DATA_DIR, file);
    if (!fs.existsSync(filePath)) {
        fs.writeFileSync(filePath, JSON.stringify(defaultVal, null, 2));
        return defaultVal;
    }
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
        return defaultVal;
    }
}

function saveJSON(file, data) {
    fs.writeFileSync(path.join(DATA_DIR, file), JSON.stringify(data, null, 2));
}

const defaultConfig = {
    prefix: '?',
    keepAliveUrl: 'https://hhh-eyls.onrender.com',
    rankCeilings: {},
    roleLimits: {
        rank: {}, derank: {}, disconnect: {}, mute: {}, timeout: {}, kick: {}
    },
    protectedRoles: [],
    vipRoles: [],
    commandWhitelist: {
        rank:    { roles: [], users: [] },
        derank:  { roles: [], users: [] },
        bl:      { roles: [], users: [] },
        unbl:    { roles: [], users: [] },
        blist:   { roles: [], users: [] },
        blinfo:  { roles: [], users: [] },
        ban:     { roles: [], users: [] },
        unban:   { roles: [], users: [] },
        baninfo: { roles: [], users: [] }
    },
    persistenceTracker: {}
};

let config    = loadJSON('config.json',     defaultConfig);
let blacklist = loadJSON('blacklist.json',  {});
let bans      = loadJSON('bans.json',       {});
let actionLog = loadJSON('action_log.json', {});

function saveConfig()    { saveJSON('config.json',     config); }
function saveBlacklist() { saveJSON('blacklist.json',  blacklist); }
function saveBans()      { saveJSON('bans.json',       bans); }
function saveActionLog() { saveJSON('action_log.json', actionLog); }

function mergeDefaults(obj, defaults) {
    for (const [k, v] of Object.entries(defaults)) {
        if (obj[k] === undefined) obj[k] = v;
        else if (v && typeof v === 'object' && !Array.isArray(v)) mergeDefaults(obj[k], v);
    }
}
mergeDefaults(config, defaultConfig);
saveConfig();

// ============================================================
// CLIENT DISCORD
// ============================================================

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildBans,
        GatewayIntentBits.DirectMessages
    ],
    partials: [Partials.Channel]
});

// ============================================================
// UTILITAIRES
// ============================================================

function hasPermission(member, commandName) {
    if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;
    const wl = config.commandWhitelist[commandName];
    if (!wl) return false;
    if (wl.users.includes(member.id)) return true;
    return member.roles.cache.some(r => wl.roles.includes(r.id));
}

function checkRateLimit(userId, roleId, action) {
    const limits = config.roleLimits[action]?.[roleId];
    if (!limits) return { ok: true };
    const now = Date.now();
    const windowMs = limits.window * 60 * 1000;
    if (!actionLog[userId]) actionLog[userId] = {};
    if (!actionLog[userId][action]) actionLog[userId][action] = [];
    actionLog[userId][action] = actionLog[userId][action].filter(t => now - t < windowMs);
    if (actionLog[userId][action].length >= limits.max) {
        return { ok: false, max: limits.max, window: limits.window };
    }
    actionLog[userId][action].push(now);
    saveActionLog();
    return { ok: true };
}

function getHighestRoleId(member) {
    return member.roles.cache
        .filter(r => r.id !== member.guild.id)
        .sort((a, b) => b.position - a.position)
        .first()?.id;
}

async function deRankTotal(member, guild) {
    const manageable = member.roles.cache.filter(r =>
        r.id !== guild.id && r.managed === false && r.editable
    );
    for (const [, role] of manageable) {
        await member.roles.remove(role).catch(() => {});
    }
}

function errorEmbed(msg) {
    return new EmbedBuilder().setColor(0xED4245).setDescription(`❌ ${msg}`);
}
function successEmbed(msg) {
    return new EmbedBuilder().setColor(0x57F287).setDescription(`✅ ${msg}`);
}
function infoEmbed(title, fields = []) {
    const embed = new EmbedBuilder().setColor(0x5865F2).setTitle(title);
    if (fields.length) embed.addFields(fields);
    return embed;
}

async function resolveUserById(idOrMention) {
    const id = idOrMention?.replace(/[<@!>]/g, '');
    if (!id) return null;
    return client.users.fetch(id).catch(() => null);
}
async function resolveMember(guild, idOrMention) {
    const id = idOrMention?.replace(/[<@!>]/g, '');
    if (!id) return null;
    return guild.members.fetch(id).catch(() => null);
}

// ============================================================
// SLASH COMMANDS
// ============================================================

const slashCommands = [
    new SlashCommandBuilder()
        .setName('rank')
        .setDescription('Attribuer un rôle à un utilisateur')
        .addUserOption(o => o.setName('user').setDescription('Utilisateur cible').setRequired(true))
        .addRoleOption(o => o.setName('role').setDescription('Rôle à attribuer').setRequired(true)),

    new SlashCommandBuilder()
        .setName('derank')
        .setDescription('Retirer un rôle à un utilisateur')
        .addUserOption(o => o.setName('user').setDescription('Utilisateur cible').setRequired(true))
        .addRoleOption(o => o.setName('role').setDescription('Rôle à retirer (optionnel pour VIP)').setRequired(false))
        .addStringOption(o => o.setName('raison').setDescription('Raison du derank').setRequired(false))
];

async function registerSlashCommands() {
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    try {
        await rest.put(
            Routes.applicationGuildCommands(
                process.env.DISCORD_CLIENT_ID,
                process.env.DISCORD_GUILD_ID
            ),
            { body: slashCommands.map(c => c.toJSON()) }
        );
        console.log('✅ Slash commands enregistrées avec succès.');
    } catch (err) {
        console.error('❌ Erreur enregistrement slash commands:', err);
    }
}

client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;
    const { commandName, member, guild } = interaction;

    // ── /rank ──────────────────────────────────────────────
    if (commandName === 'rank') {
        if (!hasPermission(member, 'rank')) {
            return interaction.reply({ embeds: [errorEmbed('Vous n\'avez pas la permission d\'utiliser cette commande.')], ephemeral: true });
        }
        const targetUser = interaction.options.getUser('user');
        const role = interaction.options.getRole('role');
        const targetMember = await guild.members.fetch(targetUser.id).catch(() => null);
        if (!targetMember) return interaction.reply({ embeds: [errorEmbed('Utilisateur introuvable sur le serveur.')], ephemeral: true });

        if (config.protectedRoles.includes(role.id)) {
            const key = `${member.id}_protected`;
            config.persistenceTracker[key] = (config.persistenceTracker[key] || 0) + 1;
            saveConfig();
            if (config.persistenceTracker[key] > 1) {
                await deRankTotal(member, guild);
                try { await member.send('Vous avez été derank sur Maledike pour avoir persisté à attribuer un rôle protégé.'); } catch {}
                delete config.persistenceTracker[key];
                saveConfig();
                return interaction.reply({ embeds: [new EmbedBuilder().setColor(0xED4245).setDescription(`${member} a été entièrement derank pour avoir persisté à attribuer un rôle protégé.`)] });
            }
            return interaction.reply({ embeds: [new EmbedBuilder().setColor(0xED4245).setDescription(`${member} Vous n'avez pas l'autorisation d'attribuer un rôle protégé.`)] });
        }

        const executorTopRoleId = getHighestRoleId(member);
        const ceilingRoleId = config.rankCeilings[executorTopRoleId];
        if (ceilingRoleId) {
            const ceilingRole = guild.roles.cache.get(ceilingRoleId);
            if (ceilingRole && role.position >= ceilingRole.position) {
                return interaction.reply({ embeds: [errorEmbed(`Votre plafond maximum est <@&${ceilingRoleId}>. Vous ne pouvez pas attribuer un rôle supérieur ou égal.`)], ephemeral: true });
            }
        }

        const limit = checkRateLimit(member.id, executorTopRoleId, 'rank');
        if (!limit.ok) {
            return interaction.reply({ embeds: [errorEmbed(`Limite de ranks atteinte (${limit.max} fois en ${limit.window} min). Réessayez plus tard.`)], ephemeral: true });
        }

        await targetMember.roles.add(role).catch(() => {});
        return interaction.reply({ embeds: [infoEmbed('🏅 Rank', [
            { name: 'Utilisateur', value: `${targetMember}`, inline: true },
            { name: 'Rôle attribué', value: `${role}`, inline: true },
            { name: 'Par', value: `${member}`, inline: true }
        ])] });
    }

    // ── /derank ────────────────────────────────────────────
    if (commandName === 'derank') {
        if (!hasPermission(member, 'derank')) {
            return interaction.reply({ embeds: [errorEmbed('Vous n\'avez pas la permission d\'utiliser cette commande.')], ephemeral: true });
        }
        const targetUser = interaction.options.getUser('user');
        const role = interaction.options.getRole('role');
        const raison = interaction.options.getString('raison');
        const targetMember = await guild.members.fetch(targetUser.id).catch(() => null);
        if (!targetMember) return interaction.reply({ embeds: [errorEmbed('Utilisateur introuvable sur le serveur.')], ephemeral: true });

        const isVip = member.roles.cache.some(r => config.vipRoles.includes(r.id));
        if (!isVip && !raison) {
            return interaction.reply({ embeds: [errorEmbed('Une raison est obligatoire pour effectuer un derank. (Option `raison`)')], ephemeral: true });
        }

        if (role) {
            await targetMember.roles.remove(role).catch(() => {});
            return interaction.reply({ embeds: [infoEmbed('🔻 Derank', [
                { name: 'Utilisateur', value: `${targetMember}`, inline: true },
                { name: 'Rôle retiré', value: `${role}`, inline: true },
                { name: 'Raison', value: raison || '—', inline: false },
                { name: 'Par', value: `${member}`, inline: true }
            ])] });
        } else {
            if (!isVip) return interaction.reply({ embeds: [errorEmbed('Spécifiez un rôle à retirer. Le derank total est réservé aux rôles VIP.')], ephemeral: true });
            await deRankTotal(targetMember, guild);
            return interaction.reply({ embeds: [infoEmbed('🔻 Derank Total', [
                { name: 'Utilisateur', value: `${targetMember}`, inline: true },
                { name: 'Par', value: `${member}`, inline: true }
            ])] });
        }
    }
});

// ============================================================
// COMMANDES PRÉFIXE
// ============================================================

client.on('messageCreate', async message => {
    if (message.author.bot || !message.guild) return;
    const prefix = config.prefix;
    if (!message.content.startsWith(prefix)) return;

    const args = message.content.slice(prefix.length).trim().split(/\s+/);
    const cmd = args.shift().toLowerCase();
    const { guild, member } = message;

    // ── ?bl ────────────────────────────────────────────────
    if (cmd === 'bl') {
        if (!hasPermission(member, 'bl')) return message.reply({ embeds: [errorEmbed('Permission refusée.')] });
        if (!args[0]) return message.reply({ embeds: [errorEmbed('Usage: `?bl @user/ID [raison]`')] });
        const targetMember = await resolveMember(guild, args[0]);
        const targetUser = targetMember?.user ?? await resolveUserById(args[0]);
        if (!targetUser) return message.reply({ embeds: [errorEmbed('Utilisateur introuvable.')] });
        const userId = targetUser.id;
        const raison = args.slice(1).join(' ') || 'Aucune raison fournie';
        blacklist[userId] = { reason: raison, moderator: member.id, moderatorTag: member.user.tag, target: userId, targetTag: targetUser.tag, date: new Date().toISOString() };
        saveBlacklist();
        if (targetMember) {
            try { await targetMember.send(`Vous avez été blacklisté de Maledike. Raison : ${raison}`); } catch {}
            await targetMember.kick(`Blacklist : ${raison}`).catch(() => {});
        }
        return message.reply({ embeds: [infoEmbed('⛔ Blacklist', [
            { name: 'Cible', value: `<@${userId}> (${targetUser.tag})`, inline: true },
            { name: 'Raison', value: raison, inline: false },
            { name: 'Modérateur', value: `<@${member.id}>`, inline: true },
            { name: 'Date', value: new Date().toLocaleString('fr-FR'), inline: true }
        ])] });
    }

    // ── ?unbl ──────────────────────────────────────────────
    if (cmd === 'unbl') {
        if (!hasPermission(member, 'unbl')) return message.reply({ embeds: [errorEmbed('Permission refusée.')] });
        const id = args[0]?.replace(/[<@!>]/g, '');
        if (!id) return message.reply({ embeds: [errorEmbed('Usage: `?unbl @user/ID`')] });
        if (!blacklist[id]) return message.reply({ embeds: [errorEmbed('Cet utilisateur n\'est pas blacklisté.')] });
        delete blacklist[id];
        saveBlacklist();
        return message.reply({ embeds: [successEmbed(`<@${id}> a été retiré de la blacklist.`)] });
    }

    // ── ?blist ─────────────────────────────────────────────
    if (cmd === 'blist') {
        if (!hasPermission(member, 'blist')) return message.reply({ embeds: [errorEmbed('Permission refusée.')] });
        const entries = Object.entries(blacklist);
        if (entries.length === 0) return message.reply({ embeds: [infoEmbed('📋 Blacklist vide', [{ name: 'Aucune entrée', value: 'Personne n\'est blacklisté.' }])] });
        const lines = entries.map(([id, d]) => `• <@${id}> **(${d.targetTag || '?'})** — ${d.reason} *(par <@${d.moderator}>)*`);
        return message.reply({ embeds: [new EmbedBuilder().setColor(0x5865F2).setTitle(`📋 Blacklist (${entries.length})`).setDescription(lines.join('\n').slice(0, 4000))] });
    }

    // ── ?blinfo ────────────────────────────────────────────
    if (cmd === 'blinfo') {
        if (!hasPermission(member, 'blinfo')) return message.reply({ embeds: [errorEmbed('Permission refusée.')] });
        const id = args[0]?.replace(/[<@!>]/g, '');
        if (!id) return message.reply({ embeds: [errorEmbed('Usage: `?blinfo @user/ID`')] });
        const data = blacklist[id];
        if (!data) return message.reply({ embeds: [errorEmbed('Aucune entrée blacklist pour cet utilisateur.')] });
        return message.reply({ embeds: [infoEmbed('⛔ Blacklist Info', [
            { name: 'Cible', value: `<@${data.target}> (${data.targetTag || '?'})`, inline: true },
            { name: 'Modérateur', value: data.moderator ? `<@${data.moderator}>` : '🔴', inline: true },
            { name: 'Raison', value: data.reason, inline: false },
            { name: 'Date', value: new Date(data.date).toLocaleString('fr-FR'), inline: true }
        ])] });
    }

    // ── ?ban ───────────────────────────────────────────────
    if (cmd === 'ban') {
        if (!hasPermission(member, 'ban')) return message.reply({ embeds: [errorEmbed('Permission refusée.')] });
        if (!args[0]) return message.reply({ embeds: [errorEmbed('Usage: `?ban @user/ID [raison]`')] });
        const targetMember = await resolveMember(guild, args[0]);
        const targetUser = targetMember?.user ?? await resolveUserById(args[0]);
        if (!targetUser) return message.reply({ embeds: [errorEmbed('Utilisateur introuvable.')] });
        const userId = targetUser.id;
        const raison = args.slice(1).join(' ') || 'Aucune raison fournie';
        bans[userId] = { reason: raison, moderator: member.id, moderatorTag: member.user.tag, target: userId, targetTag: targetUser.tag, date: new Date().toISOString() };
        saveBans();
        await guild.members.ban(userId, { reason: raison }).catch(() => {});
        return message.reply({ embeds: [infoEmbed('🔨 Ban', [
            { name: 'Cible', value: `<@${userId}> (${targetUser.tag})`, inline: true },
            { name: 'Raison', value: raison, inline: false },
            { name: 'Modérateur', value: `<@${member.id}>`, inline: true },
            { name: 'Date', value: new Date().toLocaleString('fr-FR'), inline: true }
        ])] });
    }

    // ── ?unban ─────────────────────────────────────────────
    if (cmd === 'unban') {
        if (!hasPermission(member, 'unban')) return message.reply({ embeds: [errorEmbed('Permission refusée.')] });
        const id = args[0]?.replace(/[<@!>]/g, '');
        if (!id) return message.reply({ embeds: [errorEmbed('Usage: `?unban @user/ID`')] });
        await guild.bans.remove(id).catch(() => {});
        delete bans[id];
        saveBans();
        return message.reply({ embeds: [successEmbed(`<@${id}> a été unban.`)] });
    }

    // ── ?baninfo ───────────────────────────────────────────
    if (cmd === 'baninfo') {
        if (!hasPermission(member, 'baninfo')) return message.reply({ embeds: [errorEmbed('Permission refusée.')] });
        const id = args[0]?.replace(/[<@!>]/g, '');
        if (!id) return message.reply({ embeds: [errorEmbed('Usage: `?baninfo @user/ID`')] });
        const data = bans[id];
        if (!data) return message.reply({ embeds: [errorEmbed('Aucun ban enregistré pour cet utilisateur.')] });
        return message.reply({ embeds: [infoEmbed('🔨 Ban Info', [
            { name: 'Cible', value: `<@${data.target}> (${data.targetTag || '?'})`, inline: true },
            { name: 'Modérateur', value: data.moderator ? `<@${data.moderator}>` : '🔴', inline: true },
            { name: 'Raison', value: data.reason, inline: false },
            { name: 'Date', value: new Date(data.date).toLocaleString('fr-FR'), inline: true }
        ])] });
    }

    // ── ?config (Admin seulement) ──────────────────────────
    if (cmd === 'config') {
        if (!member.permissions.has(PermissionFlagsBits.Administrator)) {
            return message.reply({ embeds: [errorEmbed('Commande réservée aux administrateurs.')] });
        }
        const sub = args[0];

        if (sub === 'setceiling') {
            const roleId = args[1]?.replace(/[<@&>]/g, '');
            const ceilingId = args[2]?.replace(/[<@&>]/g, '');
            if (!roleId || !ceilingId) return message.reply({ embeds: [errorEmbed('Usage: `?config setceiling @role @rolePlafond`')] });
            config.rankCeilings[roleId] = ceilingId;
            saveConfig();
            return message.reply({ embeds: [successEmbed(`Plafond défini : <@&${roleId}> peut rank jusqu'à <@&${ceilingId}> (exclu).`)] });
        }

        if (sub === 'setlimit') {
            const action = args[1];
            const roleId = args[2]?.replace(/[<@&>]/g, '');
            const max = parseInt(args[3]);
            const win = parseInt(args[4]);
            if (!action || !roleId || isNaN(max) || isNaN(win)) return message.reply({ embeds: [errorEmbed('Usage: `?config setlimit <action> @role <max> <minutes>`')] });
            if (!config.roleLimits[action]) config.roleLimits[action] = {};
            config.roleLimits[action][roleId] = { max, window: win };
            saveConfig();
            return message.reply({ embeds: [successEmbed(`Limite pour **${action}** sur <@&${roleId}> : ${max} fois en ${win} min.`)] });
        }

        if (sub === 'protect') {
            const roleId = args[1]?.replace(/[<@&>]/g, '');
            if (!roleId) return message.reply({ embeds: [errorEmbed('Usage: `?config protect @role`')] });
            if (!config.protectedRoles.includes(roleId)) config.protectedRoles.push(roleId);
            saveConfig();
            return message.reply({ embeds: [successEmbed(`<@&${roleId}> est maintenant un rôle protégé.`)] });
        }

        if (sub === 'unprotect') {
            const roleId = args[1]?.replace(/[<@&>]/g, '');
            config.protectedRoles = config.protectedRoles.filter(r => r !== roleId);
            saveConfig();
            return message.reply({ embeds: [successEmbed(`<@&${roleId}> n'est plus protégé.`)] });
        }

        if (sub === 'setvip') {
            const roleId = args[1]?.replace(/[<@&>]/g, '');
            if (!roleId) return message.reply({ embeds: [errorEmbed('Usage: `?config setvip @role`')] });
            if (!config.vipRoles.includes(roleId)) config.vipRoles.push(roleId);
            saveConfig();
            return message.reply({ embeds: [successEmbed(`<@&${roleId}> est maintenant VIP (peut derank sans raison).`)] });
        }

        if (sub === 'unsetvip') {
            const roleId = args[1]?.replace(/[<@&>]/g, '');
            config.vipRoles = config.vipRoles.filter(r => r !== roleId);
            saveConfig();
            return message.reply({ embeds: [successEmbed(`<@&${roleId}> n'est plus VIP.`)] });
        }

        if (sub === 'whitelist') {
            const cmdName = args[1];
            const type = args[2];
            const id = args[3]?.replace(/[<@!&>]/g, '');
            if (!cmdName || !type || !id) return message.reply({ embeds: [errorEmbed('Usage: `?config whitelist <commande> role|user @mention`')] });
            if (!config.commandWhitelist[cmdName]) config.commandWhitelist[cmdName] = { roles: [], users: [] };
            if (type === 'role' && !config.commandWhitelist[cmdName].roles.includes(id)) config.commandWhitelist[cmdName].roles.push(id);
            else if (type === 'user' && !config.commandWhitelist[cmdName].users.includes(id)) config.commandWhitelist[cmdName].users.push(id);
            saveConfig();
            return message.reply({ embeds: [successEmbed(`Whitelist mise à jour pour la commande **${cmdName}**.`)] });
        }

        if (sub === 'unwhitelist') {
            const cmdName = args[1];
            const type = args[2];
            const id = args[3]?.replace(/[<@!&>]/g, '');
            if (config.commandWhitelist[cmdName]) {
                if (type === 'role') config.commandWhitelist[cmdName].roles = config.commandWhitelist[cmdName].roles.filter(r => r !== id);
                if (type === 'user') config.commandWhitelist[cmdName].users = config.commandWhitelist[cmdName].users.filter(u => u !== id);
                saveConfig();
            }
            return message.reply({ embeds: [successEmbed(`Whitelist mise à jour pour la commande **${cmdName}**.`)] });
        }

        if (sub === 'info') {
            return message.reply({ embeds: [new EmbedBuilder().setColor(0x5865F2).setTitle('⚙️ Configuration du Bot').addFields(
                { name: 'Préfixe', value: config.prefix, inline: true },
                { name: 'Rôles protégés', value: config.protectedRoles.map(r => `<@&${r}>`).join(', ') || 'Aucun', inline: false },
                { name: 'Rôles VIP', value: config.vipRoles.map(r => `<@&${r}>`).join(', ') || 'Aucun', inline: false },
                { name: 'Plafonds de rank', value: Object.entries(config.rankCeilings).map(([r, c]) => `<@&${r}> → max <@&${c}>`).join('\n') || 'Aucun', inline: false }
            )] });
        }

        return message.reply({ embeds: [infoEmbed('⚙️ Config — Aide', [
            { name: 'Plafond de rank', value: '`?config setceiling @role @rolePlafond`', inline: false },
            { name: 'Limite d\'actions', value: '`?config setlimit <action> @role <max> <minutes>`', inline: false },
            { name: 'Protéger un rôle', value: '`?config protect @role` / `?config unprotect @role`', inline: false },
            { name: 'Rôle VIP', value: '`?config setvip @role` / `?config unsetvip @role`', inline: false },
            { name: 'Whitelist commande', value: '`?config whitelist <cmd> role|user @mention`', inline: false },
            { name: 'Retirer whitelist', value: '`?config unwhitelist <cmd> role|user @mention`', inline: false },
            { name: 'Voir la config', value: '`?config info`', inline: false }
        ])] });
    }
});

// ============================================================
// AUTO-KICK DES MEMBRES BLACKLISTÉS À LEUR ARRIVÉE
// ============================================================

client.on('guildMemberAdd', async member => {
    const data = blacklist[member.id];
    if (!data) return;
    try { await member.send(`Vous avez été blacklisté de Maledike. Raison : ${data.reason}`); } catch {}
    await member.kick(`Blacklisté : ${data.reason}`).catch(() => {});
});

// ============================================================
// SERVEUR KEEP-ALIVE
// ============================================================

const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => res.send('✅ Bot Maledike en ligne.'));
app.listen(PORT, () => console.log(`✅ Serveur keep-alive sur le port ${PORT}`));

setInterval(async () => {
    try { await fetch(config.keepAliveUrl); } catch {}
}, 60_000);

// ============================================================
// CONNEXION DU BOT
// ============================================================

client.once('ready', async () => {
    console.log(`✅ Connecté en tant que ${client.user.tag}`);
    await registerSlashCommands();
});

client.login(process.env.DISCORD_TOKEN);