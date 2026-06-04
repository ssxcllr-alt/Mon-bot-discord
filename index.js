const { 
    Client, GatewayIntentBits, Partials, REST, Routes, 
    SlashCommandBuilder, EmbedBuilder, AuditLogEvent, PermissionsBitField 
} = require('discord.js');
const express = require('express');
const fs = require('fs');
const path = './config.json';

// ==========================================
// ⚙️ GESTION DYNAMIQUE DE LA CONFIGURATION
// ==========================================
let config = {
    token: process.env.TOKEN || "TON_TOKEN_ICI", 
    clientId: process.env.CLIENT_ID || "TON_CLIENT_ID_ICI",   
    guildId: process.env.GUILD_ID || "TON_SERVEUR_ID_ICI",   
    rolesProtect: [], 
    rolesSupreme: [], 
    rankLimitCount: 5, 
    actionLimitCount: 3, 
    whitelistedIds: [], 
    whitelistedRoles: [],
    renderUrl: "https://hhh-eyls.onrender.com"
};

// Charge la configuration si le fichier existe
function loadConfig() {
    if (fs.existsSync(path)) {
        const data = fs.readFileSync(path);
        const parsed = JSON.parse(data);
        config = { ...config, ...parsed }; // Fusionne pour garder le token/ID si non présents dans le JSON
    } else {
        saveConfig();
    }
}

// Sauvegarde la configuration
function saveConfig() {
    // On ne sauvegarde pas le token dans le fichier JSON par sécurité s'il vient de process.env
    const configToSave = { ...config };
    delete configToSave.token;
    fs.writeFileSync(path, JSON.stringify(configToSave, null, 4));
}

loadConfig();

// ==========================================
// 🧠 SYSTÈME DE STOCKAGE (Mémoire RAM)
// ==========================================
const rankUsage = new Map(); 
const protectAttempts = new Map(); 
const modActions = new Map(); 
const blacklist = new Map(); 

// ==========================================
// 🌐 SERVEUR EXPRESS & KEEP-ALIVE RENDER
// ==========================================
const app = express();
app.get('/', (req, res) => res.send('Maledike Bot est en ligne !'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Serveur web sur port ${PORT}`));

setInterval(() => {
    fetch(config.renderUrl)
        .then(() => console.log("[KEEP-ALIVE] Ping OK."))
        .catch(() => console.log("[KEEP-ALIVE] Échec ping."));
}, 60000);

// ==========================================
// 🤖 INITIALISATION DU CLIENT
// ==========================================
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildModeration, GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent, GatewayIntentBits.GuildVoiceStates
    ],
    partials: [Partials.Message, Partials.Channel, Partials.Reaction]
});

// ==========================================
// 🛠️ COMMANDES SLASH (Avec gestion de la config)
// ==========================================
const commands = [
    new SlashCommandBuilder()
        .setName('rank')
        .setDescription('Attribue un rôle à un utilisateur')
        .addUserOption(opt => opt.setName('user').setDescription('La cible').setRequired(true))
        .addRoleOption(opt => opt.setName('role').setDescription('Le rôle').setRequired(true)),
    new SlashCommandBuilder()
        .setName('derank')
        .setDescription('Retire un rôle ou derank totalement un utilisateur')
        .addUserOption(opt => opt.setName('user').setDescription('La cible').setRequired(true))
        .addRoleOption(opt => opt.setName('role').setDescription('Le rôle (Optionnel si derank total)').setRequired(false))
        .addStringOption(opt => opt.setName('raison').setDescription('Raison du derank').setRequired(false)),
    new SlashCommandBuilder()
        .setName('config')
        .setDescription('Modifie la configuration du bot (Admin)')
        .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator)
        .addSubcommand(sub => sub.setName('add_protect').setDescription('Ajoute un rôle Protect').addRoleOption(opt => opt.setName('role').setDescription('Le rôle').setRequired(true)))
        .addSubcommand(sub => sub.setName('rem_protect').setDescription('Retire un rôle Protect').addRoleOption(opt => opt.setName('role').setDescription('Le rôle').setRequired(true)))
        .addSubcommand(sub => sub.setName('add_supreme').setDescription('Ajoute un rôle Suprême').addRoleOption(opt => opt.setName('role').setDescription('Le rôle').setRequired(true)))
        .addSubcommand(sub => sub.setName('rem_supreme').setDescription('Retire un rôle Suprême').addRoleOption(opt => opt.setName('role').setDescription('Le rôle').setRequired(true)))
        .addSubcommand(sub => sub.setName('add_wl_user').setDescription('Whitelist un User (?bl)').addUserOption(opt => opt.setName('user').setDescription('User').setRequired(true)))
        .addSubcommand(sub => sub.setName('add_wl_role').setDescription('Whitelist un Rôle (?bl)').addRoleOption(opt => opt.setName('role').setDescription('Rôle').setRequired(true)))
        .addSubcommand(sub => sub.setName('view').setDescription('Voir la configuration actuelle'))
];

client.once('ready', async () => {
    console.log(`✅ Connecté: ${client.user.tag}`);
    const rest = new REST({ version: '10' }).setToken(config.token);
    try {
        await rest.put(Routes.applicationGuildCommands(config.clientId, config.guildId), { body: commands });
        console.log('✅ Commandes Slash chargées.');
    } catch (err) { console.error(err); }
});

// ==========================================
// ⚔️ ANTI-ABUS (Audit Logs)
// ==========================================
client.on('guildAuditLogEntryCreate', async auditLog => {
    const { action, executorId } = auditLog;
    if (!executorId || executorId === client.user.id) return;

    const watchedActions = [
        AuditLogEvent.MemberBanAdd, AuditLogEvent.MemberKick,
        AuditLogEvent.MemberUpdate, AuditLogEvent.MemberDisconnect,
        AuditLogEvent.MemberRoleUpdate
    ];

    if (watchedActions.includes(action)) {
        const now = Date.now();
        if (!modActions.has(executorId)) modActions.set(executorId, []);
        
        const timestamps = modActions.get(executorId);
        timestamps.push(now);
        
        const recentActions = timestamps.filter(t => now - t < 300000); // 5 minutes
        modActions.set(executorId, recentActions);

        if (recentActions.length > config.actionLimitCount) {
            try {
                const guild = client.guilds.cache.get(config.guildId);
                const abuser = await guild.members.fetch(executorId);
                await abuser.roles.set([]); 
                modActions.delete(executorId); 

                const embed = new EmbedBuilder().setColor('Red').setTitle('⚠️ ANTI-ABUS').setDescription(`<@${executorId}> a été **totalement derank** (trop d'actions de modération en <5min).`);
                const channel = guild.systemChannel || guild.channels.cache.find(c => c.isTextBased());
                if (channel) channel.send({ embeds: [embed] });
                abuser.send("Vous avez été derank de Maledike pour abus de permissions.").catch(()=>{});
            } catch (err) {}
        }
    }
});

// ==========================================
// 🛡️ ANTI-BLACKLIST REJOIN
// ==========================================
client.on('guildMemberAdd', async member => {
    if (blacklist.has(member.id)) {
        const data = blacklist.get(member.id);
        try { await member.send(`Vous êtes BLACKLISTÉ de Maledike.\nRaison : ${data.reason}`); } catch (e) {}
        await member.kick("Blacklisté");
    }
});

// ==========================================
// 💬 GESTION DES COMMANDES SLASH
// ==========================================
client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;
    const { commandName, member, options } = interaction;

    // --- COMMANDE CONFIGURATION ---
    if (commandName === 'config') {
        const sub = options.getSubcommand();
        const role = options.getRole('role');
        const user = options.getUser('user');

        if (sub === 'add_protect') {
            if (!config.rolesProtect.includes(role.id)) config.rolesProtect.push(role.id);
            saveConfig();
            return interaction.reply(`✅ Le rôle ${role.name} est maintenant protégé.`);
        }
        if (sub === 'rem_protect') {
            config.rolesProtect = config.rolesProtect.filter(id => id !== role.id);
            saveConfig();
            return interaction.reply(`✅ Le rôle ${role.name} n'est plus protégé.`);
        }
        if (sub === 'add_supreme') {
            if (!config.rolesSupreme.includes(role.id)) config.rolesSupreme.push(role.id);
            saveConfig();
            return interaction.reply(`✅ Le rôle ${role.name} est maintenant Suprême.`);
        }
        if (sub === 'rem_supreme') {
            config.rolesSupreme = config.rolesSupreme.filter(id => id !== role.id);
            saveConfig();
            return interaction.reply(`✅ Le rôle ${role.name} n'est plus Suprême.`);
        }
        if (sub === 'add_wl_user') {
            if (!config.whitelistedIds.includes(user.id)) config.whitelistedIds.push(user.id);
            saveConfig();
            return interaction.reply(`✅ L'utilisateur ${user.username} peut utiliser ?bl.`);
        }
        if (sub === 'add_wl_role') {
            if (!config.whitelistedRoles.includes(role.id)) config.whitelistedRoles.push(role.id);
            saveConfig();
            return interaction.reply(`✅ Le rôle ${role.name} permet d'utiliser ?bl.`);
        }
        if (sub === 'view') {
            const embed = new EmbedBuilder()
                .setTitle("⚙️ Configuration Maledike")
                .addFields(
                    { name: "Rôles Protect", value: config.rolesProtect.map(id => `<@&${id}>`).join(', ') || "Aucun" },
                    { name: "Rôles Suprêmes", value: config.rolesSupreme.map(id => `<@&${id}>`).join(', ') || "Aucun" },
                    { name: "Whitelist User (?bl)", value: config.whitelistedIds.map(id => `<@${id}>`).join(', ') || "Aucun" },
                    { name: "Whitelist Role (?bl)", value: config.whitelistedRoles.map(id => `<@&${id}>`).join(', ') || "Aucun" }
                );
            return interaction.reply({ embeds: [embed] });
        }
    }

    // --- COMMANDE RANK ---
    if (commandName === 'rank') {
        const targetMember = options.getMember('user');
        const roleToGive = options.getRole('role');
        if (!targetMember) return interaction.reply({ content: "Utilisateur introuvable.", ephemeral: true });

        if (roleToGive.position >= member.roles.highest.position && member.id !== interaction.guild.ownerId) {
            return interaction.reply({ content: "Impossible d'attribuer un rôle égal/supérieur au vôtre.", ephemeral: true });
        }

        if (config.rolesProtect.includes(roleToGive.id)) {
            let attempts = protectAttempts.get(member.id) || 0;
            attempts++;
            protectAttempts.set(member.id, attempts);

            if (attempts >= 2) {
                await member.roles.set([]);
                protectAttempts.delete(member.id);
                member.send("Derank total pour avoir forcé un rôle Protect.").catch(()=>{});
                return interaction.reply({ content: `<@${member.id}> a été derank pour avoir forcé l'attribution d'un rôle intouchable.` });
            }
            return interaction.reply({ embeds: [new EmbedBuilder().setColor('Orange').setDescription(`<@${member.id}> Vous n’avez pas l’autorisation d’attribuer un rôle protect.`)] });
        }

        const now = Date.now();
        if (!rankUsage.has(member.id)) rankUsage.set(member.id, []);
        const usages = rankUsage.get(member.id).filter(t => now - t < 300000);
        
        if (usages.length >= config.rankLimitCount) {
            return interaction.reply({ content: `Limite de rank atteinte.`, ephemeral: true });
        }

        try {
            await targetMember.roles.add(roleToGive);
            usages.push(now);
            rankUsage.set(member.id, usages);
            interaction.reply({ content: `✅ ${roleToGive.name} ajouté à <@${targetMember.id}>.` });
        } catch (error) {
            interaction.reply({ content: "Erreur de permissions (Mon rôle est trop bas).", ephemeral: true });
        }
    }

    // --- COMMANDE DERANK ---
    if (commandName === 'derank') {
        const targetMember = options.getMember('user');
        const roleToRemove = options.getRole('role');
        const raison = options.getString('raison');
        if (!targetMember) return interaction.reply({ content: "Utilisateur introuvable.", ephemeral: true });

        const isSupreme = member.roles.cache.some(r => config.rolesSupreme.includes(r.id)) || member.id === interaction.guild.ownerId;

        if (isSupreme && !roleToRemove) {
            try {
                await targetMember.roles.set([]);
                return interaction.reply({ content: `💥 <@${targetMember.id}> a été totalement derank par <@${member.id}>.` });
            } catch (err) { return interaction.reply({ content: "Erreur de permissions.", ephemeral: true }); }
        }

        if (!roleToRemove) return interaction.reply({ content: "Spécifiez un rôle ou ayez les permissions Suprêmes.", ephemeral: true });
        if (!raison) return interaction.reply({ content: "Raison obligatoire.", ephemeral: true });
        if (roleToRemove.position >= member.roles.highest.position && !isSupreme) return interaction.reply({ content: "Impossible.", ephemeral: true });

        try {
            await targetMember.roles.remove(roleToRemove);
            interaction.reply({ content: `✅ ${roleToRemove.name} retiré à <@${targetMember.id}>. Raison: *${raison}*` });
        } catch (err) { interaction.reply({ content: "Erreur.", ephemeral: true }); }
    }
});

// ==========================================
// 📩 COMMANDES PREFIX (?bl, ?unbl, ?blinfo)
// ==========================================
client.on('messageCreate', async message => {
    if (message.author.bot || !message.content.startsWith('?')) return;

    const args = message.content.slice(1).trim().split(/ +/);
    const command = args.shift().toLowerCase();

    const isWhitelisted = config.whitelistedIds.includes(message.author.id) || 
                          message.member.roles.cache.some(r => config.whitelistedRoles.includes(r.id)) ||
                          message.author.id === message.guild.ownerId;
    
    if (!isWhitelisted) return;

    if (command === 'bl') {
        const targetId = args[0]?.replace(/[<@!>]/g, '');
        const reason = args.slice(1).join(' ') || "Aucune raison";
        if (!targetId) return message.reply("Mentionnez l'ID.");
        
        blacklist.set(targetId, { mod: message.author.id, reason, date: new Date() });
        const targetMember = message.guild.members.cache.get(targetId);
        if (targetMember) {
            targetMember.send(`BLACKLISTÉ. Raison : ${reason}`).catch(()=>{});
            await targetMember.kick(reason).catch(()=>{});
        }
        message.reply({ embeds: [new EmbedBuilder().setColor('DarkButNotBlack').setDescription(`⛓️ <@${targetId}> blacklisté.`)] });
    }

    if (command === 'unbl') {
        const targetId = args[0]?.replace(/[<@!>]/g, '');
        if (!targetId) return;
        blacklist.delete(targetId);
        message.reply(`✅ <@${targetId}> retiré de la blacklist.`);
    }

    if (command === 'blinfo') {
        const targetId = args[0]?.replace(/[<@!>]/g, '');
        if (!targetId) return;
        const info = blacklist.get(targetId);
        
        let modDisplay = info ? `<@${info.mod}>` : "❌ (Bot Externe)";
        let reasonDisplay = info ? info.reason : "Action système";
        let dateDisplay = info ? info.date.toLocaleString('fr-FR') : "Date inconnue";

        if (!info) {
            try {
                const banInfo = await message.guild.bans.fetch(targetId);
                reasonDisplay = banInfo.reason || "Banni sans raison";
            } catch (e) { return message.reply("Aucune information trouvée."); }
        }

        const embed = new EmbedBuilder()
            .setTitle(`Info Blacklist`)
            .addFields(
                { name: 'Cible', value: `<@${targetId}>`, inline: true },
                { name: 'Modérateur', value: modDisplay, inline: true },
                { name: 'Raison', value: reasonDisplay, inline: false },
                { name: 'Date', value: dateDisplay, inline: false }
            );
        message.reply({ embeds: [embed] });
    }
});

client.login(config.token);
