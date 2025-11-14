const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  EmbedBuilder,
  GatewayIntentBits,
  ModalBuilder,
  Partials,
  PermissionsBitField,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');
const fetch = require('node-fetch');
const { config } = require('dotenv');

config();

const OWNER_ID = '1141085246226452643';
const VERIFIED_ROLE_NAME = 'Verificado';
const ACCEPT_KEYWORD = 'ACEPTO';
const TOS_RULES = [
  'No compartas contenido ilegal, malicioso o que infrinja derechos de autor.',
  'Mantén el respeto absoluto hacia otros miembros del servidor.',
  'Está prohibido el spam, flood o el uso de cuentas alternas para evadir sanciones.',
  'Aceptas que el equipo de moderación puede expulsarte si incumples estas normas.',
  'La participación en este servidor implica respetar estas TOS y las reglas locales.',
];

const DATA_DIR = path.join(__dirname, 'data');
const WARNINGS_PATH = path.join(DATA_DIR, 'warnings.json');
const BLACKLIST_PATH = path.join(DATA_DIR, 'blacklist.json');
const WALLETS_PATH = path.join(DATA_DIR, 'wallets.json');
const ACCESS_KEYS_PATH = path.join(DATA_DIR, 'accessKeys.json');

const BLOCKCHAIN_API_BASE = process.env.BLOCKCHAIN_API_BASE ?? 'https://api.blockcypher.com/v1/eth/main/';
const BLOCKCHAIN_API_TOKEN = process.env.BLOCKCHAIN_API_TOKEN ?? null;

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function ensureJsonFile(filePath, defaultContent) {
  ensureDataDir();
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, defaultContent, 'utf8');
  }
}

function readJson(filePath, fallback) {
  ensureJsonFile(filePath, JSON.stringify(fallback));
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (error) {
    console.warn(`No se pudo leer ${filePath}. Se restablece el archivo.`, error);
    fs.writeFileSync(filePath, JSON.stringify(fallback, null, 2), 'utf8');
    return fallback;
  }
}

function writeJson(filePath, data) {
  ensureJsonFile(filePath, JSON.stringify(data));
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

let warningsCache = null;
let blacklistCache = null;
let walletsCache = null;
let accessKeysCache = null;

function loadWarnings() {
  if (!warningsCache) {
    warningsCache = readJson(WARNINGS_PATH, {});
  }
  return warningsCache;
}

function saveWarnings(data) {
  warningsCache = data;
  writeJson(WARNINGS_PATH, warningsCache);
}

function loadBlacklist() {
  if (!blacklistCache) {
    blacklistCache = readJson(BLACKLIST_PATH, { users: [], guilds: [] });
  }
  if (!Array.isArray(blacklistCache.users)) blacklistCache.users = [];
  if (!Array.isArray(blacklistCache.guilds)) blacklistCache.guilds = [];
  return blacklistCache;
}

function saveBlacklist(data) {
  blacklistCache = data;
  writeJson(BLACKLIST_PATH, blacklistCache);
}

function loadWallets() {
  if (!walletsCache) {
    walletsCache = readJson(WALLETS_PATH, {});
  }
  return walletsCache;
}

function saveWallets(data) {
  walletsCache = data;
  writeJson(WALLETS_PATH, walletsCache);
}

function loadAccessKeys() {
  if (!accessKeysCache) {
    accessKeysCache = readJson(ACCESS_KEYS_PATH, {});
  }
  return accessKeysCache;
}

function saveAccessKeys(data) {
  accessKeysCache = data;
  writeJson(ACCESS_KEYS_PATH, accessKeysCache);
}

function isUserBlacklisted(userId) {
  const blacklist = loadBlacklist();
  return blacklist.users.includes(userId);
}

function isGuildBlacklisted(guildId) {
  const blacklist = loadBlacklist();
  return blacklist.guilds.includes(guildId);
}

function permissionEmbed(title, description, moderator, emoji = '🛡️') {
  const prefix = emoji ? `${emoji} ` : '';
  return new EmbedBuilder()
    .setTitle(`${prefix}${title}`.trim())
    .setDescription(description)
    .setColor(0x5865f2)
    .setFooter({ text: `Acción solicitada por ${moderator.displayName ?? moderator.username}` });
}

function statusEmbed({ emoji = 'ℹ️', title, description, color = 0x5865f2, footer }) {
  const embed = new EmbedBuilder().setColor(color);
  if (title) {
    const prefixed = emoji ? `${emoji} ${title}` : title;
    embed.setTitle(prefixed.trim());
  }
  if (description) {
    embed.setDescription(description);
  }
  if (footer) {
    embed.setFooter(footer);
  }
  return embed;
}

function canUseEphemeral(interaction) {
  return interaction.inGuild();
}

function buildReplyOptions(interaction, options) {
  if (typeof options.ephemeral === 'undefined') {
    return { ...options, ephemeral: canUseEphemeral(interaction) };
  }
  if (options.ephemeral && !canUseEphemeral(interaction)) {
    return { ...options, ephemeral: false };
  }
  return options;
}

async function safeReply(interaction, options) {
  await interaction.reply(buildReplyOptions(interaction, options));
}

async function safeDefer(interaction) {
  await interaction.deferReply({ ephemeral: canUseEphemeral(interaction) });
}

function formatNumber(value) {
  return new Intl.NumberFormat('es-ES').format(Number(value ?? 0));
}

async function fetchWalletSnapshot(walletAddress) {
  const base = BLOCKCHAIN_API_BASE.endsWith('/') ? BLOCKCHAIN_API_BASE : `${BLOCKCHAIN_API_BASE}/`;
  const url = new URL(`addrs/${walletAddress}`, base);
  url.searchParams.set('limit', '5');
  if (BLOCKCHAIN_API_TOKEN) {
    url.searchParams.set('token', BLOCKCHAIN_API_TOKEN);
  }

  const response = await fetch(url.href);
  if (!response.ok) {
    throw new Error(`API respondió ${response.status}`);
  }
  const payload = await response.json();
  const confirmed = Array.isArray(payload.txrefs) ? payload.txrefs : [];
  const pending = Array.isArray(payload.unconfirmed_txrefs) ? payload.unconfirmed_txrefs : [];
  return {
    walletAddress,
    balance: payload.balance ?? 0,
    finalBalance: payload.final_balance ?? payload.balance ?? 0,
    txs: [...confirmed, ...pending],
  };
}

function describeTransactions(txs) {
  if (!txs?.length) {
    return 'Sin movimientos recientes en esta wallet.';
  }
  return txs.slice(0, 5).map((tx) => {
    const isInbound = tx.tx_input_n === -1;
    const direction = isInbound ? 'Entrada' : 'Salida';
    const emoji = isInbound ? '⬆️' : '⬇️';
    const amount = formatNumber(tx.value ?? 0);
    const timestamp = tx.confirmed ? new Date(tx.confirmed).toLocaleString('es-ES', { timeZone: 'UTC' }) : 'Sin confirmar';
    return `${emoji} ${direction} • ${amount} unidades • ${timestamp}`;
  }).join('\n');
}

function walletEmbed(title, snapshot) {
  return new EmbedBuilder()
    .setTitle(`💰 ${title}`)
    .setColor(0x57f287)
    .setDescription(`Dirección: \`${snapshot.walletAddress}\``)
    .addFields(
      { name: 'Balance confirmado', value: `${formatNumber(snapshot.finalBalance)} unidades`, inline: true },
      { name: 'Movimientos recientes', value: describeTransactions(snapshot.txs), inline: false },
    );
}

async function askInDM(channel, userId, question, timeoutMs = 60000) {
  await channel.send(question);
  try {
    const collected = await channel.awaitMessages({
      filter: (message) => message.author.id === userId,
      max: 1,
      time: timeoutMs,
      errors: ['time'],
    });
    const answer = collected.first()?.content?.trim();
    return answer?.length ? answer : null;
  } catch (error) {
    return null;
  }
}

async function notifyOwner(client, content) {
  try {
    const owner = await client.users.fetch(OWNER_ID);
    await owner.send(content);
  } catch (error) {
    console.error('No se pudo notificar al propietario:', error);
  }
}

async function ensureVerifiedRole(guild) {
  const existing = guild.roles.cache.find((role) => role.name === VERIFIED_ROLE_NAME);
  if (existing) {
    return existing;
  }
  try {
    const role = await guild.roles.create({
      name: VERIFIED_ROLE_NAME,
      reason: 'Creación automática del sistema de verificación',
    });
    return role;
  } catch (error) {
    console.error(`No se pudo crear el rol ${VERIFIED_ROLE_NAME} en ${guild.name}`, error);
    throw error;
  }
}

function tosEmbed(guildName) {
  const description = TOS_RULES.map((rule, index) => `${index + 1}. ${rule}`).join('\n');
  return new EmbedBuilder()
    .setTitle(`🛂 Verificación requerida en ${guildName}`)
    .setDescription(description)
    .setColor(0xf4900c)
    .setFooter({ text: 'Pulsa "Aceptar" o "Rechazar" para continuar.' });
}

const pendingVerifications = new Map(); // `${guildId}:${userId}` -> true

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel],
});

const commandBuilders = [
  new SlashCommandBuilder()
    .setName('ban')
    .setDescription('Banea a un miembro del servidor')
    .addUserOption((option) =>
      option.setName('miembro').setDescription('Miembro a banear').setRequired(true),
    )
    .addStringOption((option) => option.setName('razon').setDescription('Motivo del baneo'))
    .setDMPermission(false),
  new SlashCommandBuilder()
    .setName('warn')
    .setDescription('Registra una advertencia para un miembro')
    .addUserOption((option) =>
      option.setName('miembro').setDescription('Miembro a advertir').setRequired(true),
    )
    .addStringOption((option) =>
      option.setName('razon').setDescription('Motivo de la advertencia').setRequired(true),
    )
    .setDMPermission(false),
  new SlashCommandBuilder()
    .setName('warnings')
    .setDescription('Consulta las advertencias de un miembro')
    .addUserOption((option) =>
      option.setName('miembro').setDescription('Miembro a consultar').setRequired(true),
    )
    .setDMPermission(false),
  new SlashCommandBuilder()
    .setName('blacklist')
    .setDescription('Gestiona la lista negra (solo propietario).')
    .addSubcommand((sub) =>
      sub
        .setName('add')
        .setDescription('Añade un usuario o servidor a la lista negra.')
        .addStringOption((opt) =>
          opt
            .setName('tipo')
            .setDescription('¿Usuario o servidor?')
            .setRequired(true)
            .addChoices(
              { name: 'Usuario', value: 'usuario' },
              { name: 'Servidor', value: 'servidor' },
            ),
        )
        .addStringOption((opt) =>
          opt.setName('id').setDescription('ID objetivo').setRequired(true),
        )
        .addStringOption((opt) => opt.setName('razon').setDescription('Motivo')),
    )
    .addSubcommand((sub) =>
      sub
        .setName('remove')
        .setDescription('Elimina un registro de la lista negra.')
        .addStringOption((opt) =>
          opt
            .setName('tipo')
            .setDescription('¿Usuario o servidor?')
            .setRequired(true)
            .addChoices(
              { name: 'Usuario', value: 'usuario' },
              { name: 'Servidor', value: 'servidor' },
            ),
        )
        .addStringOption((opt) =>
          opt.setName('id').setDescription('ID objetivo').setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('list')
        .setDescription('Muestra la lista negra actual.'),
    )
    .setDMPermission(false),
  new SlashCommandBuilder()
    .setName('setwallet')
    .setDescription('Guarda tu wallet para consultas rápidas desde cualquier chat.')
    .addStringOption((opt) =>
      opt
        .setName('direccion')
        .setDescription('Dirección pública de tu wallet')
        .setRequired(true),
    )
    .setDMPermission(true),
  new SlashCommandBuilder().setName('mywallet').setDescription('Consulta la wallet que guardaste.').setDMPermission(true),
  new SlashCommandBuilder()
    .setName('wallet')
    .setDescription('Consulta los movimientos de una wallet usando tu key autorizada.')
    .addStringOption((opt) =>
      opt.setName('key').setDescription('Key emitida por el administrador').setRequired(true),
    )
    .setDMPermission(true),
  new SlashCommandBuilder()
    .setName('daracceso')
    .setDescription('Inicia el asistente por DM para generar una key vinculada a un usuario.')
    .setDMPermission(true),
];

const commandDefinitions = commandBuilders.map((command) => command.toJSON());

client.once('ready', async () => {
  try {
    await client.application.commands.set(commandDefinitions);
    console.log(`Comandos registrados como ${client.user.tag}`);
  } catch (error) {
    console.error('No se pudieron registrar los comandos de aplicación.', error);
  }

  const blacklist = loadBlacklist();
  if (blacklist.users.length || blacklist.guilds.length) {
    await notifyOwner(
      client,
      `El bot se ha iniciado con ${blacklist.users.length} usuario(s) y ${blacklist.guilds.length} servidor(es) en lista negra.`,
    );
  }
});

function hasModerationPermission(interaction) {
  return interaction.memberPermissions?.has(PermissionsBitField.Flags.BanMembers) ?? false;
}

async function handleBan(interaction) {
  if (!hasModerationPermission(interaction)) {
    await interaction.reply({ content: 'No tienes permisos para usar este comando.', ephemeral: true });
    return;
  }

  const targetUser = interaction.options.getUser('miembro', true);
  if (targetUser.id === interaction.user.id) {
    await interaction.reply({ content: 'No puedes banearte a ti mismo.', ephemeral: true });
    return;
  }

  const reason = interaction.options.getString('razon') ?? undefined;
  try {
    await interaction.guild.members.ban(targetUser, { reason });
  } catch (error) {
    console.error('Error al banear usuario:', error);
    await interaction.reply({
      content: 'No tengo permisos para banear a ese usuario o ocurrió un error.',
      ephemeral: true,
    });
    return;
  }

  const embed = permissionEmbed(
    'Usuario baneado',
    `<@${targetUser.id}> ha sido baneado.${reason ? `\nRazón: ${reason}` : ''}`,
    interaction.user,
    '🚫',
  );
  await interaction.reply({ embeds: [embed] });
}

async function handleWarn(interaction) {
  if (!hasModerationPermission(interaction)) {
    await interaction.reply({ content: 'No tienes permisos para usar este comando.', ephemeral: true });
    return;
  }

  const targetUser = interaction.options.getUser('miembro', true);
  const reason = interaction.options.getString('razon', true);
  const warnings = loadWarnings();
  const guildId = interaction.guildId;

  if (!warnings[guildId]) {
    warnings[guildId] = {};
  }

  const userWarnings = warnings[guildId];
  userWarnings[targetUser.id] = (userWarnings[targetUser.id] ?? 0) + 1;
  saveWarnings(warnings);

  const count = userWarnings[targetUser.id];
  const embed = permissionEmbed(
    'Advertencia registrada',
    `<@${targetUser.id}> ahora tiene **${count}** advertencia(s).\nRazón: ${reason}`,
    interaction.user,
    '⚠️',
  );
  await interaction.reply({ embeds: [embed] });
}

async function handleWarnings(interaction) {
  const targetUser = interaction.options.getUser('miembro', true);
  const warnings = loadWarnings();
  const guildWarnings = warnings[interaction.guildId] ?? {};
  const count = guildWarnings[targetUser.id] ?? 0;

  const embed = new EmbedBuilder()
    .setTitle('📋 Historial de advertencias')
    .setDescription(`<@${targetUser.id}> tiene **${count}** advertencia(s).`)
    .setColor(0xf4900c)
    .setFooter({ text: `Consultado por ${interaction.user.displayName ?? interaction.user.username}` });

  await interaction.reply({ embeds: [embed], ephemeral: true });
}

async function handleBlacklist(interaction) {
  if (interaction.user.id !== OWNER_ID) {
    await safeReply(interaction, { content: 'Solo el propietario autorizado puede usar este comando.' });
    return;
  }

  const sub = interaction.options.getSubcommand();
  const blacklist = loadBlacklist();

  if (sub === 'list') {
    const embed = new EmbedBuilder()
      .setTitle('Lista negra actual')
      .addFields(
        {
          name: 'Usuarios',
          value: blacklist.users.length ? blacklist.users.map((id) => `- ${id}`).join('\n') : 'Sin usuarios en lista negra.',
        },
        {
          name: 'Servidores',
          value: blacklist.guilds.length ? blacklist.guilds.map((id) => `- ${id}`).join('\n') : 'Sin servidores en lista negra.',
        },
      )
      .setColor(0x2b2d31);
      await safeReply(interaction, { embeds: [embed] });
      return;
    }

  const type = interaction.options.getString('tipo');
  const id = interaction.options.getString('id');

  if (sub === 'add') {
    const reason = interaction.options.getString('razon') ?? 'Sin motivo especificado.';
    const collection = type === 'usuario' ? blacklist.users : blacklist.guilds;
    if (collection.includes(id)) {
      await safeReply(interaction, { content: 'Ya estaba en la lista negra.' });
      return;
    }
    collection.push(id);
    saveBlacklist(blacklist);
    await safeReply(interaction, { content: `ID ${id} añadido a la lista negra.` });
    await notifyOwner(client, `🔒 Se añadió ${type} ${id} a la lista negra. Motivo: ${reason}`);

    if (type === 'usuario') {
      for (const guild of client.guilds.cache.values()) {
        const member = await guild.members.fetch(id).catch(() => null);
        if (member) {
          await notifyOwner(client, `⚠️ ${member.user.tag} ya estaba en ${guild.name}.`);
        }
      }
    } else if (type === 'servidor' && client.guilds.cache.has(id)) {
      const guild = client.guilds.cache.get(id);
      await notifyOwner(client, `⚠️ El bot ya está en el servidor en lista negra: ${guild.name}`);
    }
    return;
  }

  if (sub === 'remove') {
    const collection = type === 'usuario' ? blacklist.users : blacklist.guilds;
    const index = collection.indexOf(id);
    if (index === -1) {
      await safeReply(interaction, { content: 'Ese ID no está en la lista negra.' });
      return;
    }
    collection.splice(index, 1);
    saveBlacklist(blacklist);
    await safeReply(interaction, { content: `ID ${id} eliminado de la lista negra.` });
    return;
  }
}

async function handleSetWallet(interaction) {
  const rawWallet = interaction.options.getString('direccion', true).trim();
  if (rawWallet.length < 4) {
    await safeReply(interaction, {
      embeds: [
        statusEmbed({
          emoji: '❌',
          title: 'Dirección inválida',
          description: 'La wallet que escribiste parece demasiado corta. Intenta de nuevo.',
          color: 0xed4245,
        }),
      ],
    });
    return;
  }

  const wallets = loadWallets();
  wallets[interaction.user.id] = rawWallet;
  saveWallets(wallets);
  await safeReply(interaction, {
    embeds: [
      statusEmbed({
        emoji: '💾',
        title: 'Wallet guardada',
        description: `La dirección \`${rawWallet}\` quedó registrada. Usa **/mywallet** en cualquier servidor o MD para consultarla.`,
        color: 0x57f287,
      }),
    ],
  });
}

async function handleMyWallet(interaction) {
  const wallets = loadWallets();
  const stored = wallets[interaction.user.id];
  if (!stored) {
    await safeReply(interaction, {
      embeds: [
        statusEmbed({
          emoji: '🪪',
          title: 'Sin wallet registrada',
          description: 'Primero debes ejecutar **/setwallet** para guardar tu dirección pública.',
          color: 0xf4900c,
        }),
      ],
    });
    return;
  }

  await safeDefer(interaction);
  try {
    const snapshot = await fetchWalletSnapshot(stored);
    await interaction.editReply({ embeds: [walletEmbed('Tu wallet registrada', snapshot)] });
  } catch (error) {
    console.error('Error consultando la wallet del usuario:', error);
    await interaction.editReply({
      embeds: [
        statusEmbed({
          emoji: '💥',
          title: 'Error al consultar',
          description: 'No pude consultar la blockchain ahora mismo. Inténtalo más tarde o avisa a un administrador.',
          color: 0xed4245,
        }),
      ],
    });
  }
}

async function handleWalletLookup(interaction) {
  const keyValue = interaction.options.getString('key', true).trim();
  const registry = loadAccessKeys();
  const entry = registry[keyValue];

  if (!entry) {
    await safeReply(interaction, {
      embeds: [
        statusEmbed({
          emoji: '🔑',
          title: 'Key inválida',
          description: 'La key que ingresaste no existe o ya fue revocada.',
          color: 0xed4245,
        }),
      ],
    });
    return;
  }

  if (entry.allowedUserId !== interaction.user.id) {
    await safeReply(interaction, {
      embeds: [
        statusEmbed({
          emoji: '🚷',
          title: 'No autorizado',
          description: 'Esta key está vinculada a otro usuario. No puedes usarla.',
          color: 0xed4245,
        }),
      ],
    });
    return;
  }

  await safeDefer(interaction);
  try {
    const snapshot = await fetchWalletSnapshot(entry.walletAddress);
    entry.redeemedBy = interaction.user.id;
    entry.redeemedAt = new Date().toISOString();
    saveAccessKeys(registry);
    const embed = walletEmbed('Wallet autorizada', snapshot).setFooter({
      text: `Key emitida por ${entry.createdBy === OWNER_ID ? 'el propietario' : `ID ${entry.createdBy}`}`,
    });
    await interaction.editReply({ embeds: [embed] });
  } catch (error) {
    console.error('Error consultando wallet autorizada:', error);
    await interaction.editReply({
      embeds: [
        statusEmbed({
          emoji: '💥',
          title: 'Error al consultar',
          description: 'No fue posible consultar la wallet asociada. Contacta al administrador.',
          color: 0xed4245,
        }),
      ],
    });
  }
}

async function handleAccessKeyWizard(interaction) {
  if (interaction.user.id !== OWNER_ID) {
    await safeReply(interaction, { content: 'Solo el propietario autorizado puede usar /daracceso.' });
    return;
  }

  const dm = await interaction.user.createDM().catch(() => null);
  if (!dm) {
    await safeReply(interaction, {
      content: 'No pude enviarte MD. Activa tus mensajes privados para continuar.',
    });
    return;
  }

  await safeReply(interaction, { content: 'Abrí un chat privado contigo para completar el asistente.' });
  await dm.send('🧩 Iniciando asistente para generar una key vinculada. Responde cada paso en menos de 60 segundos.');

  const targetId = await askInDM(dm, interaction.user.id, '1️⃣ Escribe la **ID del usuario** que podrá canjear la key:');
  if (!targetId) {
    await dm.send('❌ No recibí la ID a tiempo. Vuelve a usar /daracceso.');
    return;
  }

  const walletAddress = await askInDM(dm, interaction.user.id, '2️⃣ Proporciona la **wallet** que se asociará a esta key:');
  if (!walletAddress) {
    await dm.send('❌ No recibí la wallet. Proceso cancelado.');
    return;
  }

  const noteAnswer = await askInDM(
    dm,
    interaction.user.id,
    '3️⃣ Añade una nota o escribe "ninguna" si no aplica:',
  );
  const sanitizedNote = noteAnswer?.trim();
  const hasNote = Boolean(sanitizedNote) && sanitizedNote.toLowerCase() !== 'ninguna';

  const registry = loadAccessKeys();
  const keyValue = crypto.randomBytes(10).toString('hex');
  registry[keyValue] = {
    allowedUserId: targetId,
    walletAddress,
    createdBy: interaction.user.id,
    createdAt: new Date().toISOString(),
    note: hasNote ? sanitizedNote : undefined,
  };
  saveAccessKeys(registry);

  const noteLine = hasNote ? `\n• Nota: ${sanitizedNote}` : '';
  await dm.send(
    `✅ Key generada: \`${keyValue}\`\n• Destinatario permitido: <@${targetId}>\n• Wallet: \`${walletAddress}\`${noteLine}`,
  );
  await dm.send('Comparte la key de forma privada. Solo el usuario indicado podrá usar /wallet con ella.');
}

client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === 'ban') return handleBan(interaction);
      if (interaction.commandName === 'warn') return handleWarn(interaction);
      if (interaction.commandName === 'warnings') return handleWarnings(interaction);
      if (interaction.commandName === 'blacklist') return handleBlacklist(interaction);
      if (interaction.commandName === 'setwallet') return handleSetWallet(interaction);
      if (interaction.commandName === 'mywallet') return handleMyWallet(interaction);
      if (interaction.commandName === 'wallet') return handleWalletLookup(interaction);
      if (interaction.commandName === 'daracceso') return handleAccessKeyWizard(interaction);
    }

    if (interaction.isButton()) {
      if (interaction.customId.startsWith('tos_accept:')) {
        const guildId = interaction.customId.split(':')[1];
        const modal = new ModalBuilder()
          .setCustomId(`tos_accept_modal:${guildId}`)
          .setTitle('Confirmación de TOS')
          .addComponents(
            new ActionRowBuilder().addComponents(
              new TextInputBuilder()
                .setCustomId('tos_keyword')
                .setLabel(`Escribe "${ACCEPT_KEYWORD}" para continuar`)
                .setRequired(true)
                .setMinLength(ACCEPT_KEYWORD.length)
                .setStyle(TextInputStyle.Short),
            ),
          );
        await interaction.showModal(modal);
        return;
      }

      if (interaction.customId.startsWith('tos_reject:')) {
        const guildId = interaction.customId.split(':')[1];
        const guild = client.guilds.cache.get(guildId);
        if (!guild) {
          await interaction.reply({ content: 'No pude encontrar el servidor original.', ephemeral: false });
          return;
        }
        const member = await guild.members.fetch(interaction.user.id).catch(() => null);
        pendingVerifications.delete(`${guildId}:${interaction.user.id}`);
        if (member) {
          await interaction.reply({ content: 'Has rechazado las TOS. Serás expulsado del servidor.', ephemeral: false });
          await member.kick('Rechazó las TOS en la verificación.');
        } else {
          await interaction.reply({ content: 'Ya no formas parte del servidor.', ephemeral: false });
        }
        return;
      }
    }

    if (interaction.isModalSubmit() && interaction.customId.startsWith('tos_accept_modal:')) {
      const guildId = interaction.customId.split(':')[1];
      const keyword = interaction.fields.getTextInputValue('tos_keyword').trim().toUpperCase();
      if (keyword !== ACCEPT_KEYWORD) {
        await interaction.reply({ content: 'La palabra clave no es correcta. Inténtalo de nuevo.', ephemeral: true });
        return;
      }

      const guild = client.guilds.cache.get(guildId);
      if (!guild) {
        await interaction.reply({ content: 'No pude encontrar el servidor original.', ephemeral: true });
        return;
      }

      const member = await guild.members.fetch(interaction.user.id).catch(() => null);
      if (!member) {
        await interaction.reply({ content: 'Ya no formas parte del servidor.', ephemeral: true });
        return;
      }

      try {
        const role = await ensureVerifiedRole(guild);
        await member.roles.add(role, 'Usuario verificó las TOS.');
        pendingVerifications.delete(`${guildId}:${interaction.user.id}`);
        await interaction.reply({ content: 'Gracias por aceptar las TOS. Ya puedes ver el servidor.', ephemeral: true });
      } catch (error) {
        console.error('No se pudo asignar el rol verificado:', error);
        await interaction.reply({ content: 'No pude otorgarte acceso. Contacta a un moderador.', ephemeral: true });
      }
      return;
    }
  } catch (error) {
    console.error('Error manejando una interacción:', error);
  }
});

async function sendVerificationPrompt(member) {
  const key = `${member.guild.id}:${member.id}`;
  if (pendingVerifications.has(key)) {
    return;
  }
  pendingVerifications.set(key, true);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`tos_accept:${member.guild.id}`).setLabel('Aceptar').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`tos_reject:${member.guild.id}`).setLabel('Rechazar').setStyle(ButtonStyle.Danger),
  );

  try {
    await member.send({ embeds: [tosEmbed(member.guild.name)], components: [row] });
  } catch (error) {
    console.warn(`No se pudo enviar la verificación a ${member.user.tag}`, error);
  }
}

client.on('guildMemberAdd', async (member) => {
  if (member.user.bot) return;
  await sendVerificationPrompt(member);
  if (isUserBlacklisted(member.id)) {
    await notifyOwner(
      client,
      `⚠️ El usuario ${member.user.tag} (${member.id}) en lista negra ingresó al servidor ${member.guild.name}.`,
    );
  }
});

client.on('guildCreate', async (guild) => {
  if (isGuildBlacklisted(guild.id)) {
    await notifyOwner(client, `⚠️ El bot se añadió a un servidor en lista negra: ${guild.name} (${guild.id}).`);
  }
});

client.on('messageCreate', async (message) => {
  if (message.author.bot || !message.guild) return;
  if (isUserBlacklisted(message.author.id)) {
    await notifyOwner(
      client,
      `📨 Mensaje de ${message.author.tag} (${message.author.id}) en ${message.guild.name}: ${message.url}`,
    );
  }
});

const token = process.env.DISCORD_TOKEN;
if (!token) {
  console.error('DISCORD_TOKEN no está configurado. Usa un archivo .env o variable de entorno.');
  process.exit(1);
}

ensureDataDir();
ensureJsonFile(WARNINGS_PATH, '{}');
ensureJsonFile(BLACKLIST_PATH, JSON.stringify({ users: [], guilds: [] }));
ensureJsonFile(WALLETS_PATH, '{}');
ensureJsonFile(ACCESS_KEYS_PATH, '{}');
client.login(token);
