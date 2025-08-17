import 'dotenv/config';
import express from 'express';
import {
  Client,
  GatewayIntentBits,
  Interaction,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  TextChannel,
  PermissionFlagsBits,
} from 'discord.js';
import { PrismaClient } from '@prisma/client';

/* ========== ENV ========== */
const {
  DISCORD_TOKEN,
  GUILD_ID,
  USER_IDS,
  PORT = '3000',
  PUBLIC_READ = 'false',
  API_KEY,
  CACHE_SECONDS = '20',
} = process.env as Record<string, string>;

if (!DISCORD_TOKEN || !GUILD_ID || !USER_IDS) {
  console.error('Missing env: DISCORD_TOKEN, GUILD_ID, USER_IDS');
  process.exit(1);
}

/* ========== Discord client + Prisma ========== */
const prisma = new PrismaClient();
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildPresences,
  ],
});

/* ========== Presence (din eksisterende funksjonalitet) ========== */
type PresenceView = {
  id: string;
  username: string;
  status: 'online' | 'idle' | 'dnd' | 'offline' | 'unknown';
  activities: { name: string; type: string }[];
  avatarUrl?: string;
};

let cache: { payload: any; ts: number } | null = null;
const cacheMs = Math.max(0, Number(CACHE_SECONDS) * 1000);

async function getTeamPresence(): Promise<PresenceView[]> {
  const guild = await client.guilds.fetch(GUILD_ID);
  // Hent alle members for å fylle presence-cache
  await guild.members.fetch();
  const ids = USER_IDS.split(',').map((s) => s.trim());

  return ids.map((id) => {
    const m = guild.members.cache.get(id);
    const p = m?.presence;
    return {
      id,
      username: m?.user?.username ?? 'unknown',
      status: (p?.status as PresenceView['status']) ?? 'offline',
      activities: (p?.activities ?? []).map((a) => ({
        name: a.name,
        type: String(a.type),
      })),
      avatarUrl: m?.user?.displayAvatarURL({ extension: 'png', size: 64 }),
    };
  });
}

/* ========== TODO utils ========== */
function parseDue(d?: string | null) {
  if (!d) return null;
  const s = d.trim();
  const iso =
    s.length <= 10 ? `${s}T00:00:00` : s.replace(' ', 'T') + (s.length === 16 ? ':00' : '');
  const dt = new Date(iso);
  return isNaN(dt.getTime()) ? null : dt;
}
const prio = (p: number) => (p === 1 ? '🔥' : p === 3 ? '⬇️' : '•');

function taskEmbed(t: any) {
  const status = t.done
    ? `✅ Ferdig av <@${t.completedBy}>`
    : t.claimedBy
    ? `🧑‍💻 Claimet av <@${t.claimedBy}>`
    : '🟢 Åpen';

  const due = t.dueAt
    ? `<t:${Math.floor(new Date(t.dueAt).getTime() / 1000)}:f>`
    : '—';

  return new EmbedBuilder()
    .setTitle(`${prio(t.priority)} ${t.title}`)
    .setDescription(t.notes ?? '')
    .addFields(
      { name: 'Status', value: status, inline: true },
      { name: 'Forfall', value: due, inline: true },
      { name: 'Opprettet av', value: `<@${t.createdBy}>`, inline: true },
    )
    .setFooter({ text: `ID: ${t.id.slice(0, 6)}` })
    .setTimestamp(new Date(t.createdAt));
}

function taskButtons(t: any) {
  const claimLabel = t.claimedBy ? 'Unclaim' : 'Claim';
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`task:claim:${t.id}`).setStyle(ButtonStyle.Primary).setLabel(claimLabel),
    new ButtonBuilder().setCustomId(`task:done:${t.id}`).setStyle(ButtonStyle.Success).setLabel('Done'),
    new ButtonBuilder().setCustomId(`task:del:${t.id}`).setStyle(ButtonStyle.Danger).setLabel('Delete'),
  );
  if (t.done) row.components.forEach((b) => b.setDisabled(true));
  return [row];
}

async function updateTaskMessage(i: any, t: any) {
  try {
    const ch = await i.client.channels.fetch(t.channelId);
    if (ch?.type === ChannelType.GuildText && t.messageId) {
      const msg = await (ch as TextChannel).messages.fetch(t.messageId).catch(() => null);
      if (msg) await msg.edit({ embeds: [taskEmbed(t)], components: taskButtons(t) });
    }
  } catch (e) {
    console.warn('Kunne ikke oppdatere melding:', e);
  }
}

async function deleteTaskMessage(i: any, t: any) {
  try {
    const ch = await i.client.channels.fetch(t.channelId);
    if (ch?.type === ChannelType.GuildText && t.messageId) {
      const msg = await (ch as TextChannel).messages.fetch(t.messageId).catch(() => null);
      if (msg) await msg.delete().catch(() => null);
    }
  } catch {
    // ignore
  }
}

/* ========== Discord handlers ========== */
client.once('ready', () => {
  console.log(`Discord ready as ${client.user?.tag}`);
});

client.on('interactionCreate', async (interaction: Interaction) => {
  try {
    /* ---- Slash: /task ---- */
    if (interaction.isChatInputCommand() && interaction.commandName === 'task') {
      const sub = interaction.options.getSubcommand();
      await interaction.deferReply({ ephemeral: true }); // ACK innen 3s

      const guildId = interaction.guildId!;
      if (sub === 'add') {
        const title = interaction.options.getString('title', true);
        const notes = interaction.options.getString('notes') ?? null;
        const dueStr = interaction.options.getString('due') ?? null;
        const priority = Math.min(3, Math.max(1, interaction.options.getInteger('priority') ?? 2));
        const target = interaction.options.getChannel('channel') ?? interaction.channel;
        if (!target || target.type !== ChannelType.GuildText) {
          await interaction.editReply({ content: 'Velg en tekstkanal.' });
          return;
        }

        const created = await prisma.guildTask.create({
          data: {
            guildId,
            channelId: target.id,
            title,
            notes,
            dueAt: parseDue(dueStr),
            priority,
            createdBy: interaction.user.id,
          },
        });

        const embed = taskEmbed(created);
        const components = taskButtons(created);
        const msg = await (target as TextChannel).send({ embeds: [embed], components });

        await prisma.guildTask.update({ where: { id: created.id }, data: { messageId: msg.id } });
        await interaction.editReply({ content: `Oppgave opprettet i <#${target.id}>.` });
        return;
      }

      if (sub === 'list') {
        const filter = interaction.options.getString('filter') ?? 'open';
        const where =
          filter === 'claimed'
            ? { guildId, done: false, NOT: { claimedBy: null } }
            : filter === 'done'
            ? { guildId, done: true }
            : filter === 'all'
            ? { guildId }
            : { guildId, done: false };

        const tasks = await prisma.guildTask.findMany({
          where,
          orderBy: [{ done: 'asc' }, { dueAt: 'asc' }, { createdAt: 'asc' }],
          take: 20,
        });

        const lines = tasks.length
          ? tasks
              .map((t) => {
                const link = t.messageId
                  ? `https://discord.com/channels/${guildId}/${t.channelId}/${t.messageId}`
                  : '';
                const who = t.done
                  ? t.completedBy
                    ? `✅ <@${t.completedBy}>`
                    : '✅'
                  : t.claimedBy
                  ? `🧑‍💻 <@${t.claimedBy}>`
                  : '🟢';
                const due = t.dueAt
                  ? `— <t:${Math.floor(new Date(t.dueAt).getTime() / 1000)}:R>`
                  : '';
                return `${who} ${prio(t.priority)} **${t.title}** ${due} ${link}`;
              })
              .join('\n')
          : 'Ingen oppgaver.';

        await interaction.editReply({ content: `**Oppgaver (${filter})**\n${lines}` });
        return;
      }
    }

    /* ---- Buttons: Claim / Done / Delete ---- */
    if (interaction.isButton() && interaction.customId.startsWith('task:')) {
      await interaction.deferUpdate(); // ACK knappeklikk
      const [, action, id] = interaction.customId.split(':');

      const task = await prisma.guildTask.findUnique({ where: { id } });
      if (!task) {
        await interaction.followUp({ content: 'Oppgaven finnes ikke lenger.', ephemeral: true });
        return;
      }
      if (task.guildId !== interaction.guildId) {
        await interaction.followUp({ content: 'Feil server.', ephemeral: true });
        return;
      }

      if (action === 'claim') {
        const updated = await prisma.guildTask.update({
          where: { id },
          data:
            task.claimedBy === interaction.user.id
              ? { claimedBy: null, claimedAt: null }
              : { claimedBy: interaction.user.id, claimedAt: new Date() },
        });
        await updateTaskMessage(interaction, updated);
        await interaction.followUp({
          content:
            task.claimedBy === interaction.user.id
              ? 'Unclaimed.'
              : `Claimed av <@${interaction.user.id}>.`,
          ephemeral: true,
        });
        return;
      }

      if (action === 'done') {
        if (task.done) {
          await interaction.followUp({ content: 'Allerede ferdig.', ephemeral: true });
          return;
        }
        const updated = await prisma.guildTask.update({
          where: { id },
          data: { done: true, completedBy: interaction.user.id, completedAt: new Date() },
        });
        await updateTaskMessage(interaction, updated);
        await interaction.followUp({
          content: `Markert ferdig av <@${interaction.user.id}>.`,
          ephemeral: true,
        });
        return;
      }

      if (action === 'del') {
        const member: any = interaction.member;
        const canDelete =
          task.createdBy === interaction.user.id ||
          (member?.permissions && member.permissions.has(PermissionFlagsBits.ManageMessages));
        if (!canDelete) {
          await interaction.followUp({
            content: 'Du har ikke lov til å slette denne oppgaven.',
            ephemeral: true,
          });
          return;
        }
        await prisma.guildTask.delete({ where: { id } });
        await deleteTaskMessage(interaction, task);
        await interaction.followUp({ content: 'Oppgave slettet.', ephemeral: true });
        return;
      }
    }
  } catch (e) {
    console.error(e);
    if (interaction.isRepliable()) {
      if (interaction.deferred) {
        await interaction.editReply({ content: 'Noe gikk galt 🤕' }).catch(() => {});
      } else {
        await interaction.reply({ content: 'Noe gikk galt 🤕', ephemeral: true }).catch(() => {});
      }
    }
  }
});

/* ========== Login Discord ========== */
client.login(DISCORD_TOKEN);

/* ========== Express API (din eksisterende) ========== */
const app = express();

/** PUBLIC: healthz er alltid åpen */
app.get('/healthz', (_req, res) => {
  return res.json({
    ok: true,
    discordReady: !!client.isReady(),
    now: new Date().toISOString(),
  });
});

/** API-nøkkel kreves kun for /api/* når PUBLIC_READ !== 'true' */
app.use('/api', (req, res, next) => {
  if (PUBLIC_READ === 'true') return next();
  const expected = (API_KEY ?? '').trim();
  const got = (req.header('x-api-key') ?? '').trim();
  console.log('[API KEY CHECK]', { got, expectedLen: expected.length, gotLen: got.length });
  if (!expected || got === expected) return next();
  return res.status(401).json({ error: 'unauthorized' });
});

app.get('/api/presence', async (_req, res) => {
  try {
    if (!client.isReady()) return res.status(503).json({ error: 'discord_not_ready' });

    const now = Date.now();
    if (cache && now - cache.ts < cacheMs) return res.json(cache.payload);

    const team = await getTeamPresence();
    const payload = { updatedAt: new Date().toISOString(), team };
    cache = { payload, ts: now };
    res.json(payload);
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? 'unknown_error' });
  }
});

app.listen(Number(PORT), () => {
  console.log(`Presence API listening on :${PORT}`);
});
