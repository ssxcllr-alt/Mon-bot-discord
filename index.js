);
const { Client, GatewayIntentBits, Collection, PermissionsBitField } = require('discord.js');
const fs = require('fs');
const DataSaver = require('./dataSaver');
const GiveawayHandler = require('./commands/giveaway/giveawayHandler');

// 👇 REMPLACE par TON ID Discord (Mode Développeur ON → Clic droit → Copier ID)
const OWNERS = ['1422102360246980792'];                    // Toi + amis owners
const PRINCIPAL_OWNER = '1422102360246980792';             // TOI SEUL (!owners)

const client = new Client({ 
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildVoiceStates
    ],
    rest: {
        timeout: 30000, // 30 seconds timeout
        userAgent: 'DiscordBot (https://discord.js.org)'
    }
});

// Fonctions de sauvegarde automatique
client.saveData = () => dataSaver.saveAllData(client);

// Intercepter les modifications des données pour sauvegarder automatiquement
const originalSet = Map.prototype.set;
Map.prototype.set = function(key, value) {
    const result = originalSet.call(this, key, value);
    // Sauvegarder si c'est la config, les préfixes ou les permissions
    if (this === client.config || this === client.prefixes || this === client.permissions) {
        setTimeout(() => client.saveData(), 1000); // Délai pour éviter les sauvegardes excessives
    }
    return result;
};

// Intercepter les modifications des tableaux pour sauvegarder automatiquement
const originalPush = Array.prototype.push;
Array.prototype.push = function(...items) {
    const result = originalPush.apply(this, items);
    // Sauvegarder si c'est la blacklist ou whitelist
    if (this === client.blacklist || this === client.whitelist) {
        setTimeout(() => client.saveData(), 1000);
    }
    return result;
};

const originalFilter = Array.prototype.filter;
Array.prototype.filter = function(...args) {
    const result = originalFilter.apply(this, args);
    // Sauvegarder si c'est la blacklist ou whitelist et que le résultat est différent
    if ((this === client.blacklist || this === client.whitelist) && result.length !== this.length) {
        setTimeout(() => client.saveData(), 1000);
    }
    return result;
};

client.prefixCommands = new Collection();
const dataSaver = new DataSaver();

// CHARGEMENT AUTOMATIQUE TOUTES commandes
const prefixPath = './commandprefix';
const commandFolders = fs.readdirSync(prefixPath).filter(folder => fs.statSync(`./commandprefix/${folder}`).isDirectory());
    
for (const folder of commandFolders) {
    const commandFiles = fs.readdirSync(`./commandprefix/${folder}`).filter(file => file.endsWith('.js'));
        
    for (const file of commandFiles) {
        const command = require(`./commandprefix/${folder}/${file}`);
        client.prefixCommands.set(command.name, command);
    }
}

// Charger les commandes dans le dossier commands
const commandsFolders = fs.readdirSync('./commands').filter(folder => fs.statSync(`./commands/${folder}`).isDirectory());
    
for (const folder of commandsFolders) {
    const commandFiles = fs.readdirSync(`./commands/${folder}`).filter(file => file.endsWith('.js'));
        
    for (const file of commandFiles) {
        const command = require(`./commands/${folder}/${file}`);
        client.prefixCommands.set(command.name, command);
    }
}

console.log(`Commandes chargées: ${client.prefixCommands.size} commandes`); // Debug

// Initialiser les Maps avant de charger les données
client.welcomeMessages = new Map();
client.boostConfig = new Map();


// Charger les données sauvegardées
dataSaver.loadAllData(client);

// Fusionner les owners codés en dur avec les owners sauvegardés
const hardcodedOwners = ['1422102360246980792']; // Owners par défaut (vous)
client.owners = [...new Set([...hardcodedOwners, ...(client.owners || [])])]; // Éviter les doublons

console.log('Données chargées:');
console.log(`- Blacklist: ${client.blacklist.length} utilisateurs`);
console.log(`- Whitelist: ${client.whitelist.length} utilisateurs`);
console.log(`- Préfixes: ${Object.keys(client.prefixes).length} serveurs`);
console.log(`- Config: ${Object.keys(client.config).length} serveurs`);
console.log(`- Owners: ${client.owners.length} utilisateurs`);

// Fonction pour mettre à jour la whitelist anti-raid avec les owners
client.updateAntiRaidWhitelist = function() {
    if (!client.antiraid || !client.antiraid.globalWhitelist) return;
    
    // Ajouter seulement les owners globaux à la whitelist globale
    if (client.owners && Array.isArray(client.owners)) {
        client.owners.forEach(ownerId => {
            if (!client.antiraid.globalWhitelist.includes(ownerId)) {
                client.antiraid.globalWhitelist.push(ownerId);
            }
        });
    }
    
    // NE PAS ajouter les server owners à la whitelist globale
    // Ils seront vérifiés par serveur dans la logique anti-raid
};

// Mettre à jour la whitelist au démarrage
client.updateAntiRaidWhitelist();

// Fonction pour vérifier si un utilisateur est owner (principal ou serveur)
client.isOwner = function(userId, guildId = null) {
    // Vérifier si c'est un owner global
    if (OWNERS.includes(userId)) {
        return true;
    }
    
    // Vérifier si c'est un owner du serveur
    if (guildId && this.serverOwners) {
        const serverOwners = this.serverOwners.get(guildId) || [];
        return serverOwners.includes(userId);
    }
    
    return false;
};

// Fonction pour obtenir le préfixe
client.getPrefix = (guildId) => {
    return guildId ? (client.prefixes[guildId] || '!') : '!';
};

// Fonction pour envoyer un message qui s'auto-supprime après 3 secondes
client.autoDeleteMessage = async (channel, content, options = {}) => {
    try {
        const message = await channel.send(content, options);
        setTimeout(async () => {
            try {
                await message.delete();
            } catch (error) {
                // Ignorer si le message est déjà supprimé
            }
        }, 3000);
        return message;
    } catch (error) {
        console.error('Erreur envoi message auto-supprimé:', error);
    }
};

// Ajouter la fonction de logs au client
client.sendLog = async function(guild, action, moderator, target, reason) {
    const logChannelId = this.config?.[guild.id]?.modLogs;
    if (!logChannelId) return;
    
    const logChannel = guild.channels.cache.get(logChannelId);
    if (!logChannel) return;
    
    const { EmbedBuilder } = require('discord.js');
    
    const embed = new EmbedBuilder()
        .setTitle(`Modération - ${action}`)
        .setColor('#000000')
        .addFields(
            { name: 'Modérateur', value: `${moderator.user.tag} (${moderator.id})`, inline: true },
            { name: 'Cible', value: target ? `${target.user.tag} (${target.id})` : 'N/A', inline: true },
            { name: 'Raison', value: reason || 'Non spécifiée', inline: false }
        )
        .setTimestamp();
    
    try {
        await logChannel.send({ embeds: [embed] });
    } catch (error) {
        console.error('Erreur envoi logs:', error);
    }
};

// Fonction pour les logs de toutes les commandes
client.sendCommandLog = async function(guild, command, user, args) {
    const logChannelId = this.config?.[guild.id]?.logs;
    if (!logChannelId) return;
    
    const logChannel = guild.channels.cache.get(logChannelId);
    if (!logChannel) return;
    
    const { EmbedBuilder } = require('discord.js');
    
    // Vérifier si c'est une commande de modération
    const modCommands = ['ban', 'kick', 'mute', 'unmute', 'clear', 'lock', 'unlock', 'addrole', 'delrole', 'nick', 'unban', 'derank', 'renew'];
    const isModCommand = modCommands.includes(command.name);
    
    // Créer un embed différent pour les commandes de modération
    const embed = new EmbedBuilder()
        .setTitle(`Modération - ${command.name.toUpperCase()}`)
        .setColor(isModCommand ? '#ff6600' : '#0099ff')
        .addFields(
            { name: 'Utilisateur', value: `${user.tag} (${user.id})`, inline: true },
            { name: 'Commande', value: `\`${this.getPrefix(guild.id)}${command.name}\``, inline: true },
            { name: 'Arguments', value: args.length > 0 ? `\`${args.join(' ')}\`` : 'Aucun', inline: false }
        )
        .setTimestamp();
    
    // Ajouter des informations supplémentaires pour les commandes de modération
    if (isModCommand) {
        embed.addFields(
            { name: 'Type', value: 'Commande de modération', inline: true },
            { name: 'Description', value: command.description || 'Aucune description', inline: false }
        );
    } else {
        embed.addFields(
            { name: 'Description', value: command.description || 'Aucune description', inline: false }
        );
    }
    
    try {
        await logChannel.send({ embeds: [embed] });
    } catch (error) {
        console.error('Erreur envoi logs commande:', error);
    }
};

// CHARGEMENT AUTOMATIQUE TOUTES commandes
// (déplacé ici pour être exécuté après l'initialisation de client.prefixCommands)
// Le code original a été déplacé plus haut

client.on('ready', async () => {
    console.log(`${client.user.tag} en ligne ! (${client.guilds.cache.size} serveurs)`);
    console.log(`Prefix par défaut: ! | Owners: ${OWNERS.length}`);
    
    // Initialisation du système anti-raid
    client.antiraid = {
        enabled: false,
        antiLink: {
            enabled: true,
            action: 'delete',
            whitelist: []
        },
        antiToken: {
            enabled: true,
            maxAccountAge: 7 * 24 * 60 * 60 * 1000, // 7 jours
            action: 'kick',
            whitelist: []
        },
        antiBan: {
            enabled: true,
            maxBans: 3,
            timeWindow: 10000, // 10 secondes
            action: 'lockdown',
            whitelist: []
        },
        globalWhitelist: [],
        banHistory: []
    };
    
    // Initialisation du système de giveaways
    client.giveawayHandler = new GiveawayHandler(client);
    client.giveaways = new Map();
    client.giveawayParticipants = new Map();
    
    // Initialisation du système de bienvenue
    // client.welcomeMessages = new Map(); // Déjà initialisé plus haut
    
    // Initialisation du système de boost
    // client.boostConfig = new Map(); // Déjà initialisé plus haut
    
    // Vérifier et recréer les salons logs si nécessaire
    for (const [guildId, config] of Object.entries(client.config)) {
        const guild = client.guilds.cache.get(guildId);
        if (!guild) continue;
        
        let needsUpdate = false;
        
        // Vérifier chaque salon de logs
        const logTypes = ['modLogs', 'vocalLogs', 'roleLogs', 'chatLogs'];
        const logNames = ['logs-modération', 'logs-vocaux', 'logs-rôles', 'logs-chat'];
        
        for (let i = 0; i < logTypes.length; i++) {
            const logType = logTypes[i];
            const logName = logNames[i];
            const channelId = config[logType];
            
            if (!channelId) continue;
            
            const channel = guild.channels.cache.get(channelId);
            if (!channel) {
                console.log(`Salon ${logName} introuvable dans ${guild.name}, suppression de la configuration...`);
                delete config[logType];
                needsUpdate = true;
            }
        }
        
        if (needsUpdate) {
            dataSaver.saveData('config', client.config);
            console.log(`Configuration mise à jour pour ${guild.name}`);
        }
    }
    
    // Sauvegarder les données toutes les 5 minutes
    setInterval(() => {
        dataSaver.saveAllData(client);
        console.log('Données sauvegardées automatiquement');
    }, 300000);
});

// Système de bienvenue
client.on('guildMemberAdd', async (member) => {
    console.log(`=== NOUVEAU MEMBRE DÉTECTÉ ===`);
    console.log(`Utilisateur: ${member.user.tag} (${member.id})`);
    console.log(`Serveur: ${member.guild.name} (${member.guild.id})`);
    console.log(`Timestamp: ${new Date().toISOString()}`);
    
    // Vérifier si un message de bienvenue est configuré
    const welcomeData = client.welcomeMessages?.get(member.guild.id);
    console.log(`Welcome data: ${welcomeData ? 'Oui' : 'Non'}`);
    
    try {
        // Système d'autorole
        const autoroleRoleId = client.autorole?.[member.guild.id];
        if (autoroleRoleId) {
            const role = member.guild.roles.cache.get(autoroleRoleId);
            if (role) {
                try {
                    await member.roles.add(role);
                    console.log(`Autorole attribué: ${role.name} à ${member.user.tag}`);
                } catch (error) {
                    console.error('Erreur attribution autorole:', error);
                }
            } else {
                console.log(`Rôle autorole introuvable: ${autoroleRoleId}`);
                delete client.autorole[member.guild.id];
                client.saveData();
            }
        }
        
        // Envoyer le message de bienvenue seulement si configuré
        if (welcomeData) {
            const channel = member.guild.channels.cache.get(welcomeData.channelId);
            if (channel) {
                // Remplacer les variables
                let messageContent = welcomeData.message || '';
                if (messageContent) {
                    messageContent = messageContent
                        .replace(/{user}/g, member.toString())
                        .replace(/{username}/g, member.user.username)
                        .replace(/{server}/g, member.guild.name)
                        .replace(/{memberCount}/g, member.guild.memberCount.toString())
                        .replace(/{avatar}/g, member.user.displayAvatarURL());
                }
                
                await channel.send(messageContent);
                console.log(`Message de bienvenue envoyé dans ${channel.name}`);
            }
        }
        
        // Système de ghost ping automatique pour les nouveaux membres
        console.log(`Vérification ghost ping...`);
        let ghostPingChannels = client.ghostPingConfig?.[member.guild.id] || [];
        console.log(`Ghost ping config brute:`, JSON.stringify(client.ghostPingConfig?.[member.guild.id]));
        console.log(`Ghost ping channels:`, ghostPingChannels);
        
        // Convertir en tableau si c'est une chaîne (ancienne config)
        if (typeof ghostPingChannels === 'string') {
            ghostPingChannels = [ghostPingChannels];
            client.ghostPingConfig[member.guild.id] = ghostPingChannels;
            console.log(`Conversion ancienne config en tableau:`, ghostPingChannels);
        }
        
        console.log(`Nombre de salons pour ghost ping: ${ghostPingChannels.length}`);
        
        if (ghostPingChannels.length > 0) {
            console.log(`=== ENVOI GHOST PINGS ===`);
            console.log(`Ghost ping dans ${ghostPingChannels.length} salon(s) pour ${member.user.tag}`);
            
            // Envoyer dans tous les salons configurés
            for (const channelId of ghostPingChannels) {
                const ghostPingChannel = member.guild.channels.cache.get(channelId);
                
                if (ghostPingChannel) {
                    try {
                        console.log(`-> Envoi du ghost ping pour ${member.user.tag} dans ${ghostPingChannel.name} (${channelId})`);
                        
                        // Envoyer juste la mention de l'utilisateur
                        const pingMessage = await ghostPingChannel.send(`${member}`);
                        console.log(`-> Message envoyé dans ${ghostPingChannel.name}, ID: ${pingMessage.id}`);
                        
                        // Supprimer immédiatement (0.5 secondes)
                        setTimeout(async () => {
                            try {
                                await pingMessage.delete();
                                console.log(`-> Message ghost ping supprimé dans ${ghostPingChannel.name}`);
                            } catch (error) {
                                console.log(`-> Message déjà supprimé dans ${ghostPingChannel.name}`);
                            }
                        }, 500);
                        
                    } catch (error) {
                        console.error(`-> Erreur ghost ping dans ${ghostPingChannel.name}:`, error);
                    }
                } else {
                    console.log(`-> Salon ${channelId} introuvable pour le ghost ping`);
                }
            }
        } else {
            console.log(`Aucun salon configuré pour le ghost ping sur ce serveur`);
        }
        
    } catch (error) {
        console.error('Erreur globale guildMemberAdd:', error);
    }
});

// Système anti-raid - Anti-Link
client.on('messageCreate', async (message) => {
    if (!client.antiraid || !client.antiraid.enabled) return;
    if (message.author.bot) return;
    
    // Vérifier whitelist globale
    if (client.antiraid.globalWhitelist.includes(message.author.id)) return;
    
    // Vérifier si c'est un server owner (immunité seulement sur ce serveur)
    if (client.isOwner(message.author.id, message.guild.id)) return;
    
    // Anti-Link (avec exception pour les GIF)
    if (client.antiraid.antiLink.enabled) {
        const linkRegex = /(https?:\/\/[^\s]+|www\.[^\s]+|discord\.(gg|io|me|com)\/[^\s]+)/gi;
        const gifRegex = /(https?:\/\/(?:www\.)?(?:giphy\.com|gph\.is|tenor\.com|i\.imgur\.com|media\.giphy\.com)\/[^\s]+|(https?:\/\/[^\s]*\.(gif|GIF)[^\s]*))/gi;
        
        // Vérifier si c'est un lien mais pas un GIF
        if (linkRegex.test(message.content) && !gifRegex.test(message.content)) {
            console.log(`ANTI-LINK: Lien détecté de ${message.author.tag}`);
            
            try {
                switch (client.antiraid.antiLink.action) {
                    case 'delete':
                        try {
                            await message.delete();
                        } catch (error) {
                            if (error.code === 10008) {
                                console.log(`Message déjà supprimé ou introuvable dans anti-link`);
                            } else {
                                console.error('Erreur suppression message anti-link:', error);
                            }
                        }
                        await message.channel.send(`${message.author}, les liens ne sont pas autorisés ici.`).then(msg => 
                            setTimeout(() => msg.delete(), 5000)
                        );
                        break;
                    case 'warn':
                        await message.reply(`⚠️ Les liens sont interdits ici.`);
                        try {
                            await message.delete();
                        } catch (error) {
                            if (error.code === 10008) {
                                console.log(`Message déjà supprimé ou introuvable dans anti-link warn`);
                            } else {
                                console.error('Erreur suppression message anti-link warn:', error);
                            }
                        }
                        break;
                    case 'kick':
                        await message.member.kick('Anti-Link - Lien détecté');
                        try {
                            await message.delete();
                        } catch (error) {
                            if (error.code === 10008) {
                                console.log(`Message déjà supprimé ou introuvable dans anti-link kick`);
                            } else {
                                console.error('Erreur suppression message anti-link kick:', error);
                            }
                        }
                        break;
                }
            } catch (error) {
                console.error('Erreur anti-link:', error);
            }
            return;
        }
    }
});

// Système anti-raid - Anti-Token (comptes récents)
client.on('guildMemberAdd', async (member) => {
    if (!client.antiraid || !client.antiraid.enabled) return;
    if (!client.antiraid.antiToken.enabled) return;
    
    // Vérifier whitelist globale
    if (client.antiraid.globalWhitelist.includes(member.id)) return;
    
    // Vérifier si c'est un server owner (immunité seulement sur ce serveur)
    if (client.isOwner(member.id, member.guild.id)) return;
    
    const now = Date.now();
    const accountAge = now - member.user.createdTimestamp;
    
    if (accountAge < client.antiraid.antiToken.maxAccountAge) {
        const days = Math.floor(accountAge / (24 * 60 * 60 * 1000));
        console.log(`ANTI-TOKEN: Compte récent détecté - ${member.user.tag} (${days} jours)`);
        
        try {
            switch (client.antiraid.antiToken.action) {
                case 'kick':
                    await member.kick(`Anti-Token - Compte trop récent (${days} jours)`);
                    break;
                case 'ban':
                    await member.ban({ reason: `Anti-Token - Compte trop récent (${days} jours)` });
                    break;
            }
            
            // Logger dans les logs de modération
            const logChannelId = client.config?.[member.guild.id]?.modLogs;
            if (logChannelId) {
                const logChannel = member.guild.channels.cache.get(logChannelId);
                if (logChannel) {
                    const { EmbedBuilder } = require('discord.js');
                    const embed = new EmbedBuilder()
                        .setTitle('ANTI-TOKEN - Compte récent détecté')
                        .setColor('#000000')
                        .addFields(
                            { name: 'Utilisateur', value: `${member.user.tag} (${member.id})`, inline: true },
                            { name: 'Âge du compte', value: `${days} jours`, inline: true },
                            { name: 'Action', value: client.antiraid.antiToken.action, inline: true }
                        )
                        .setTimestamp();
                    
                    await logChannel.send({ embeds: [embed] });
                }
            }
        } catch (error) {
            console.error('Erreur anti-token:', error);
        }
    }
});

// Système anti-raid - Anti-Ban Massif
client.on('guildBanAdd', async (ban) => {
    if (!client.antiraid || !client.antiraid.enabled) return;
    if (!client.antiraid.antiBan.enabled) return;
    
    const guild = ban.guild;
    const now = Date.now();
    
    // Ajouter le ban à l'historique
    client.antiraid.banHistory.push({ timestamp: now, guildId: guild.id });
    
    // Nettoyer les anciens bans
    client.antiraid.banHistory = client.antiraid.banHistory.filter(ban => 
        now - ban.timestamp < client.antiraid.antiBan.timeWindow
    );
    
    // Vérifier si le seuil est dépassé
    const recentBans = client.antiraid.banHistory.filter(ban => ban.guildId === guild.id);
    if (recentBans.length >= client.antiraid.antiBan.maxBans) {
        console.log(`ANTI-BAN: ${recentBans.length} bans en ${client.antiraid.antiBan.timeWindow/1000} secondes`);
        
        try {
            // Logger l'alerte
            const logChannelId = client.config?.[guild.id]?.modLogs;
            if (logChannelId) {
                const logChannel = guild.channels.cache.get(logChannelId);
                if (logChannel) {
                    const { EmbedBuilder } = require('discord.js');
                    const embed = new EmbedBuilder()
                        .setTitle('ALERT ANTI-BAN MASSIF')
                        .setColor('#000000')
                        .addFields(
                            { name: 'Nombre de bans', value: `${recentBans.length}`, inline: true },
                            { name: 'Période', value: `${client.antiraid.antiBan.timeWindow/1000} secondes`, inline: true },
                            { name: 'Action', value: client.antiraid.antiBan.action, inline: false }
                        )
                        .setTimestamp();
                    
                    await logChannel.send({ embeds: [embed] });
                }
            }
            
            // Action selon la configuration
            if (client.antiraid.antiBan.action === 'lockdown') {
                // Notifier les administrateurs
                const owner = await guild.fetchOwner();
                if (owner) {
                    await owner.send(`🚨ALERTE ANTI-RAID: ${recentBans.length} bans détectés en ${client.antiraid.antiBan.timeWindow/1000}s sur ${guild.name}!`);
                }
                
                // Optionnel: créer un salon d'alerte
                try {
                    const alertChannel = await guild.channels.create({
                        name: '⚠️-alerte-anti-raid',
                        type: 0, // GUILD_TEXT
                        permissionOverwrites: [
                            {
                                id: guild.id,
                                deny: ['SendMessages']
                            },
                            {
                                id: client.user.id,
                                allow: ['SendMessages']
                            }
                        ]
                    });
                    
                    await alertChannel.send(`🚨 **ALERTE ANTI-RAID** 🚨\n\n${recentBans.length} bans ont été détectés en ${client.antiraid.antiBan.timeWindow/1000} secondes.\n\nVeuillez vérifier l'activité des modérateurs.`);
                } catch (error) {
                    console.error('Erreur création salon alerte:', error);
                }
            }
        } catch (error) {
            console.error('Erreur anti-ban:', error);
        }
    }
});

// Sauvegarder les données avant l'arrêt
process.on('SIGINT', () => {
    console.log('Arrêt du bot - Sauvegarde des données...');
    dataSaver.saveAllData(client);
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('Arrêt du bot - Sauvegarde des données...');
    dataSaver.saveAllData(client);
    process.exit(0);
});

// Logs vocaux
client.on('voiceStateUpdate', (oldState, newState) => {
    const guild = oldState.guild || newState.guild;
    const config = client.config?.[guild.id];
    
    if (!config?.vocalLogs) return;
    
    const logChannel = guild.channels.cache.get(config.vocalLogs);
    if (!logChannel) return;
    
    const { EmbedBuilder } = require('discord.js');
    const member = newState.member;
    
    // Rejoint un vocal
    if (!oldState.channelId && newState.channelId) {
        const embed = new EmbedBuilder()
            .setTitle('Rejoint un vocal')
            .setColor('#000000')
            .addFields(
                { name: 'Membre', value: `${member.user.tag} (${member.id})`, inline: true },
                { name: 'Salon', value: `<#${newState.channelId}>`, inline: true }
            )
            .setTimestamp();
        logChannel.send({ embeds: [embed] });
    }
    
    // Quitte un vocal
    else if (oldState.channelId && !newState.channelId) {
        const embed = new EmbedBuilder()
            .setTitle('Quitte un vocal')
            .setColor('#000000')
            .addFields(
                { name: 'Membre', value: `${member.user.tag} (${member.id})`, inline: true },
                { name: 'Salon', value: `<#${oldState.channelId}>`, inline: true }
            )
            .setTimestamp();
        logChannel.send({ embeds: [embed] });
    }
    
    // Change de salon vocal
    else if (oldState.channelId && newState.channelId && oldState.channelId !== newState.channelId) {
        const embed = new EmbedBuilder()
            .setTitle('Change de vocal')
            .setColor('#000000')
            .addFields(
                { name: 'Membre', value: `${member.user.tag} (${member.id})`, inline: true },
                { name: 'De', value: `<#${oldState.channelId}>`, inline: true },
                { name: 'Vers', value: `<#${newState.channelId}>`, inline: true }
            )
            .setTimestamp();
        logChannel.send({ embeds: [embed] });
    }
    
    // Mute/Unmute micro
    else if (oldState.selfMute !== newState.selfMute) {
        const embed = new EmbedBuilder()
            .setTitle(newState.selfMute ? 'Micro muet' : 'Micro activé')
            .setColor(newState.selfMute ? '#ff9900' : '#00ff00')
            .addFields(
                { name: 'Membre', value: `${member.user.tag} (${member.id})`, inline: true },
                { name: 'Salon', value: `<#${newState.channelId}>`, inline: true }
            )
            .setTimestamp();
        logChannel.send({ embeds: [embed] });
    }
    
    // Mute/Unmute casque
    else if (oldState.selfDeaf !== newState.selfDeaf) {
        const embed = new EmbedBuilder()
            .setTitle(newState.selfDeaf ? 'Casque muet' : 'Casque activé')
            .setColor(newState.selfDeaf ? '#ff9900' : '#00ff00')
            .addFields(
                { name: 'Membre', value: `${member.user.tag} (${member.id})`, inline: true },
                { name: 'Salon', value: `<#${newState.channelId}>`, inline: true }
            )
            .setTimestamp();
        logChannel.send({ embeds: [embed] });
    }
});

// Logs de rôles et gestion des pseudos lockés
client.on('guildMemberUpdate', (oldMember, newMember) => {
    const guild = newMember.guild;
    
    // Gestion des pseudos lockés
    if (oldMember.nickname !== newMember.nickname && client.lockedNames && client.lockedNames.has(newMember.id)) {
        const lockData = client.lockedNames.get(newMember.id);
        
        // Remettre le pseudo locké de manière asynchrone
        newMember.setNickname(lockData.lockedName).catch(error => {
            console.error('Erreur restauration pseudo lock:', error);
        });
        
        // Envoyer un log dans les logs de modération
        const logChannelId = client.config?.[guild.id]?.modLogs;
        if (logChannelId) {
            const logChannel = guild.channels.cache.get(logChannelId);
            if (logChannel) {
                const { EmbedBuilder } = require('discord.js');
                const embed = new EmbedBuilder()
                    .setTitle('Pseudo verrouillé - Changement détecté')
                    .setColor('#000000')
                    .addFields(
                        { name: 'Utilisateur', value: `${newMember.user.tag} (${newMember.id})`, inline: true },
                        { name: 'Tentative de pseudo', value: oldMember.nickname || newMember.user.username, inline: true },
                        { name: 'Pseudo remis', value: lockData.lockedName, inline: true },
                        { name: 'Lock par', value: `<@${lockData.moderatorId}>`, inline: false }
                    )
                    .setTimestamp();
                
                logChannel.send({ embeds: [embed] }).catch(error => {
                    console.error('Erreur log pseudo lock:', error);
                });
            }
        }
    }
    
    // Logs de rôles (ancien code)
    const config = client.config?.[guild.id];
    if (!config?.roleLogs) return;
    
    const logChannel = guild.channels.cache.get(config.roleLogs);
    if (!logChannel) return;
    
    const { EmbedBuilder } = require('discord.js');
    
    // Rôles ajoutés
    const addedRoles = newMember.roles.cache.filter(role => !oldMember.roles.cache.has(role.id));
    if (addedRoles.size > 0) {
        const embed = new EmbedBuilder()
            .setTitle('Role(s) ajoute(s)')
            .setColor('#000000')
            .addFields(
                { name: 'Membre', value: `${newMember.user.tag} (${newMember.id})`, inline: true },
                { name: 'Role(s)', value: addedRoles.map(r => r.name).join(', '), inline: false }
            )
            .setTimestamp();
        logChannel.send({ embeds: [embed] });
    }
    
    // Rôles retirés
    const removedRoles = oldMember.roles.cache.filter(role => !newMember.roles.cache.has(role.id));
    if (removedRoles.size > 0) {
        const embed = new EmbedBuilder()
            .setTitle('Role(s) retire(s)')
            .setColor('#000000')
            .addFields(
                { name: 'Membre', value: `${newMember.user.tag} (${newMember.id})`, inline: true },
                { name: 'Role(s)', value: removedRoles.map(r => r.name).join(', '), inline: false }
            )
            .setTimestamp();
        logChannel.send({ embeds: [embed] });
    }
});

// Logs de chat (messages supprimés) + Snipe
client.on('messageDelete', (message) => {
    if (message.author.bot) return;
    if (message.content.length === 0 && !message.attachments.first()) return;
    
    const guild = message.guild;
    
    // Système de snipe - stocker le message supprimé
    client.snipes = client.snipes || new Map();
    const guildSnipes = client.snipes.get(guild.id) || [];
    
    // Ajouter le message supprimé au début de la liste
    guildSnipes.unshift({
        content: message.content,
        author: message.author,
        channelId: message.channelId,
        deletedAt: Date.now(),
        attachments: message.attachments
    });
    
    // Garder seulement les 10 derniers messages
    if (guildSnipes.length > 10) {
        guildSnipes.pop();
    }
    
    client.snipes.set(guild.id, guildSnipes);
    
    // Logs de chat (si configuré)
    const config = client.config?.[guild.id];
    if (!config?.chatLogs) return;
    
    const logChannel = guild.channels.cache.get(config.chatLogs);
    if (!logChannel) return;
    
    const { EmbedBuilder } = require('discord.js');
    
    const embed = new EmbedBuilder()
        .setTitle('Message supprime')
        .setColor('#000000')
        .addFields(
            { name: 'Auteur', value: `${message.author.tag} (${message.author.id})`, inline: true },
            { name: 'Salon', value: `<#${message.channelId}>`, inline: true },
            { name: 'Contenu', value: message.content.length > 1024 ? message.content.substring(0, 1021) + '...' : message.content, inline: false }
        )
        .setTimestamp();
    
    logChannel.send({ embeds: [embed] });
});

// Charger le gestionnaire de tickets
const ticketHandler = require('./handlers/ticketHandler');

// Gestionnaire d'interactions
client.on('interactionCreate', async (interaction) => {
    // Gérer les interactions de tickets
    await ticketHandler.handleTicketInteraction(interaction, client);
    
    // Gérer les interactions de giveaways
    if (interaction.isModalSubmit() && interaction.customId === 'giveaway_config') {
        const giveawayData = {
            title: interaction.fields.getTextInputValue('giveaway_title'),
            description: interaction.fields.getTextInputValue('giveaway_description'),
            duration: interaction.fields.getTextInputValue('giveaway_duration'),
            winners: interaction.fields.getTextInputValue('giveaway_winners'),
            channelId: interaction.channel.id
        };
        
        // Sélectionner le salon pour le giveaway
        const channelSelect = new StringSelectMenuBuilder()
            .setCustomId('gw_channel_select')
            .setPlaceholder('Choisis le salon pour le giveaway')
            .addOptions(
                interaction.guild.channels.cache
                    .filter(channel => channel.type === 0 && channel.permissionsFor(interaction.guild.members.me).has('SendMessages'))
                    .map(channel => ({
                        label: channel.name,
                        value: channel.id,
                        description: `Envoyer dans #${channel.name}`
                    }))
                    .slice(0, 25)
            );

        const row = new ActionRowBuilder().addComponents(channelSelect);
        
        await interaction.reply({
            content: 'Choisis le salon où envoyer le giveaway :',
            components: [row],
            ephemeral: true
        });
        
        // Stocker les données temporairement
        if (!client.tempGiveawayData) client.tempGiveawayData = new Map();
        client.tempGiveawayData.set(interaction.user.id, giveawayData);
    }
    
    // Gérer le bouton de configuration
    if (interaction.isButton() && interaction.customId === 'gw_start_setup') {
        await interaction.reply({
            content: 'Envoie maintenant ton giveaway dans ce format:\n\n`titre | description | durée | gagnants`\n\nExemple: `Nitro Classic | Un mois de Nitro Classic | 1h | 1`',
            ephemeral: true
        });
        
        // Stocker l'attente de configuration
        if (!client.giveawaySetup) client.giveawaySetup = new Set();
        client.giveawaySetup.add(interaction.user.id);
    }
    
    // Gérer la sélection du salon
    if (interaction.isStringSelectMenu() && interaction.customId === 'gw_channel_select') {
        const giveawayData = client.tempGiveawayData.get(interaction.user.id);
        if (!giveawayData) {
            return await interaction.reply({ content: 'Données du giveaway introuvables', ephemeral: true });
        }
        
        giveawayData.channelId = interaction.values[0];
        
        // Créer le giveaway
        await client.giveawayHandler.startGiveaway(interaction, giveawayData);
        
        // Nettoyer les données temporaires
        client.tempGiveawayData.delete(interaction.user.id);
    }
    
    // Gérer les boutons de participation
    if (interaction.isButton() && interaction.customId.startsWith('gw_participate_')) {
        const messageId = interaction.customId.replace('gw_participate_', '');
        await client.giveawayHandler.handleParticipation(interaction, messageId);
    }
    
    // Gérer les boutons modifier
    if (interaction.isButton() && interaction.customId.startsWith('gw_modify_')) {
        const messageId = interaction.customId.replace('gw_modify_', '');
        await client.giveawayHandler.handleModify(interaction, messageId);
    }
    
    // Gérer les boutons terminer
    if (interaction.isButton() && interaction.customId.startsWith('gw_end_')) {
        const messageId = interaction.customId.replace('gw_end_', '');
        await client.giveawayHandler.endGiveaway(messageId);
    }
    
    // Gérer les boutons d'édition
    if (interaction.isButton() && interaction.customId.startsWith('gw_edit_')) {
        const parts = interaction.customId.split('_');
        const editType = parts[2];
        const messageId = parts[3];
        await client.giveawayHandler.handleEdit(interaction, messageId, editType);
    }
});

// Système de remerciement pour les boosts
client.on('guildMemberUpdate', async (oldMember, newMember) => {
    // Vérifier si le membre a boosté
    if (!oldMember.premiumSince && newMember.premiumSince) {
        // Le membre vient de booster
        const boostConfig = client.boostConfig?.get(newMember.guild.id);
        
        if (boostConfig && boostConfig.enabled) {
            try {
                const channel = newMember.guild.channels.cache.get(boostConfig.channelId);
                if (channel) {
                    const message = boostConfig.message.replace('{user}', newMember.toString());
                    await channel.send(message);
                    console.log(`Message de boost envoyé pour ${newMember.user.tag} dans ${newMember.guild.name}`);
                } else {
                    console.log(`Salon de boost introuvable pour ${newMember.guild.name}`);
                }
            } catch (error) {
                console.error('Erreur envoi message de boost:', error);
            }
        }
    }
});

client.on('messageCreate', async (message) => {
    if (message.author.bot) return;
    
    // Répondre au ping du bot
    if (message.mentions.has(client.user) && !message.content.includes('@here') && !message.content.includes('@everyone')) {
        // Vérifier si c'est un ping direct du bot (pas une réponse à un message)
        if (message.reference === null && message.content.trim().startsWith(`<@${client.user.id}>`) || message.content.trim().startsWith(`<@!${client.user.id}>`)) {
            const prefix = client.getPrefix(message.guild.id);
            await message.reply(`Mon prefix sur ce serveur est : \`${prefix}\``);
            return;
        }
    }
    
    // Gérer les messages de configuration giveaway
    if (client.giveawaySetup && client.giveawaySetup.has(message.author.id)) {
        const parts = message.content.split('|').map(p => p.trim());
        
        if (parts.length === 5) {
            const [title, description, duration, winners, channelMention] = parts;
            
            // Extraire l'ID du salon depuis la mention
            const channelId = channelMention.match(/<#(\d+)>/)?.[1];
            if (!channelId) {
                await message.reply('Salon invalide ! Utilise une mention comme #general');
                return;
            }
            
            // Vérifier si le bot peut envoyer des messages dans ce salon
            const channel = message.guild.channels.cache.get(channelId);
            if (!channel || !channel.permissionsFor(message.guild.members.me).has('SendMessages')) {
                await message.reply('Je ne peux pas envoyer de messages dans ce salon !');
                return;
            }
            
            const giveawayData = {
                title: title,
                description: description,
                duration: duration,
                winners: winners,
                channelId: channelId
            };
            
            // Créer le giveaway directement
            await client.giveawayHandler.startGiveaway(
                { 
                    user: message.author,
                    member: message.member,
                    reply: async (options) => {
                        return message.reply(options.content);
                    }
                }, 
                giveawayData
            );
            
            // Retirer de l'attente
            client.giveawaySetup.delete(message.author.id);
            return;
        } else {
            await message.reply('Format incorrect ! Utilise: `titre | description | durée | gagnants | #salon`');
            return;
        }
    }
    
    // Gérer les messages d'édition de giveaway
    if (client.giveawayEditWaiting && client.giveawayEditWaiting.has(message.author.id)) {
        const result = await client.giveawayHandler.applyEdit(message.author.id, message.content);
        await message.reply(result);
        return;
    }
    
    // Gérer les messages de modification de giveaway (nouveau système)
    if (client.giveawayModifyWaiting && client.giveawayModifyWaiting.has(message.author.id)) {
        const messageId = client.giveawayModifyWaiting.get(message.author.id);
        const result = await client.giveawayHandler.processModifyCommand(message.author.id, messageId, message.content);
        await message.reply(result);
        return;
    }
    
    // LOG DE DÉBOGAGE
    console.log(`Message reçu: ${message.content} | Serveur: ${message.guild.name} (${message.guild.id}) | Auteur: ${message.author.tag}`);
    
    const prefix = client.getPrefix(message.guild.id);
    if (!message.content.startsWith(prefix)) return;
    
    const args = message.content.slice(prefix.length).trim().split(/ +/);
    const commandName = args.shift().toLowerCase();
    
    // LOG DE DÉBOGAGE
    console.log(`Commande détectée: ${commandName} | Args: ${args.join(' ')}`);
    
    const command = client.prefixCommands.get(commandName);
    if (!command) return;
    
    // LOG DE DÉBOGAGE
    console.log(`Commande trouvée: ${command.name}`);
    
    // Vérification blacklist
    if (client.blacklist && client.blacklist.includes(message.author.id)) {
        console.log('Utilisateur blacklisté');
        return message.reply('Tu es blacklisté du bot.');
    }
    
    // Vérification permissions Discord
    if (command.permissions && !message.member.permissions.has(command.permissions)) {
        console.log('Permissions Discord manquantes');
        return message.reply('Permissions Discord insuffisantes.');
    }
    
   
    
    // Vérifier si c'est une commande owner
    if (command.name === 'eval' || command.name === 'restart' || command.name === 'owner' || command.name === 'antiraid' || command.name === 'help' || command.name === 'backup' || command.name === 'restore' || command.name === 'deletebackup' || command.name === 'hide' || command.name === 'unhide') {
        if (!client.isOwner(message.author.id, message.guild.id)) {
            return message.reply('Commande owner uniquement.');
        }
    }
    
    try {
        console.log(`Exécution de la commande: ${command.name}`);
        await command.execute(message, args, client);
        console.log(`Commande ${command.name} exécutée avec succès`);
        
        // Envoyer les logs de commande (sauf si skipLogging est true)
        if (!command.skipLogging) {
            await client.sendCommandLog(message.guild, command, message.author, args);
        }
    } catch (error) {
        console.error(error);
        message.reply('Erreur lors de l\'exécution de la commande.');
    }
});

// Gestion des erreurs de connexion
client.on('disconnect', () => {
    console.log('Bot déconnecté, tentative de reconnexion...');
});

client.on('reconnecting', () => {
    console.log('Tentative de reconnexion en cours...');
});

client.on('error', (error) => {
    console.error('Erreur Discord.js:', error);
    if (error.code === 'UND_ERR_CONNECT_TIMEOUT') {
        console.log('Timeout de connexion - Nouvelle tentative dans 30 secondes...');
        setTimeout(() => {
            client.login(process.env.TOKEN);
        }, 30000);
    }
});

client.login(process.env.TOKEN).catch(err => {
    console.error('Erreur de connexion:', err.message);
    if (err.code === 'UND_ERR_CONNECT_TIMEOUT') {
        console.log('Timeout de connexion initial - Nouvelle tentative dans 30 secondes...');
        setTimeout(() => {
            console.log('Nouvelle tentative de connexion...');
            client.login(process.env.TOKEN);
        }, 30000);
    } else {
        console.log('Vérifie ton token Discord et ta connexion internet');
    }
});