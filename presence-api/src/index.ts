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
  ChatInputCommandInteraction,
  ButtonInteraction,
  MessageFlags,
} from 'discord.js';
import { PrismaClient } from '@prisma/client';

/* ===== ENV ===== */
const {
  DISCORD_TOKEN,
  GUILD_ID,
  USER_IDS,
  TODO_CHANNEL_ID, // sett denne i .env
  PORT = '3000',
  PUBLIC_READ = 'false',
  API_KEY,
  CACHE_SECONDS = '20',
} = process.env as Record<string, string>;

if (!DISCORD_TOKEN || !GUILD_ID || !USER_IDS) {
  console.error('Missing env: DISCORD_TOKEN, GUILD_ID, USER_IDS');
  process.exit(1);
}

/* ===== Clients ===== */
const prisma = new PrismaClient();
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildPresences,
  ],
});

/* ===== Presence API (din) ===== */
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

/* ===== TODO utils ===== */
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

  const due = t.dueAt ? `<t:${Math.floor(new Date(t.dueAt).getTime() / 1000)}:f>` : '—';

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

/* — Only in #todo — */
let allowedChannelId: string | null = TODO_CHANNEL_ID ?? null;

async function ensureTodoChannelReady(): Promise<string | null> {
  if (allowedChannelId) return allowedChannelId;
  const guild = await client.guilds.fetch(GUILD_ID);
  const channels = await guild.channels.fetch();
  const todo = channels.find(
    (c: any) => c?.type === ChannelType.GuildText && c?.name?.toLowerCase() === 'todo'
  ) as TextChannel | undefined;
  if (todo) {
    allowedChannelId = todo.id;
    console.log('[task] TODO_CHANNEL_ID not set, using #todo by name:', allowedChannelId);
  } else {
    console.warn('[task] TODO channel not found. Set TODO_CHANNEL_ID in .env');
  }
  return allowedChannelId;
}

const requireInTodoChannel = async (
  interaction: ChatInputCommandInteraction
): Promise<boolean> => {
  const allowed = await ensureTodoChannelReady();
  if (!allowed) {
    await interaction.editReply({
      content: 'Admin: Sett env **TODO_CHANNEL_ID** til #todo-kanalens ID.',
    });
    return false;
  }
  if (interaction.channelId !== allowed) {
    await interaction.editReply({ content: `Bruk denne kommandoen i <#${allowed}>.` });
    return false;
  }
  return true;
};

/* Helpers som ikke avhenger av Interaction-typen */
async function updateTaskMessage(t: any) {
  try {
    if (!t.messageId) return;
    const ch = await client.channels.fetch(t.channelId);
    if (ch?.type === ChannelType.GuildText) {
      const msg = await (ch as TextChannel).messages.fetch(t.messageId).catch(() => null);
      if (msg) await msg.edit({ embeds: [taskEmbed(t)], components: taskButtons(t) });
    }
  } catch (e) {
    console.warn('Kunne ikke oppdatere melding:', e);
  }
}

async function deleteTaskMessage(t: any) {
  try {
    if (!t.messageId) return;
    const ch = await client.channels.fetch(t.channelId);
    if (ch?.type === ChannelType.GuildText) {
      const msg = await (ch as TextChannel).messages.fetch(t.messageId).catch(() => null);
      if (msg) await msg.delete().catch(() => null);
    }
  } catch {
    // ignore
  }
}

/* ===== Discord ===== */
client.once('ready', async () => {
  console.log(`Discord ready as ${client.user?.tag}`);
  await ensureTodoChannelReady();
});

client.on('interactionCreate', async (interaction: Interaction) => {
  try {
    /* ---- Slash: /task ---- */
    if (interaction.isChatInputCommand() && interaction.commandName === 'task') {
      const i = interaction as ChatInputCommandInteraction;
      const sub = i.options.getSubcommand();
      await i.deferReply({ flags: MessageFlags.Ephemeral }); // ACK innen 3s, uten deprecated warning

      if (!(await requireInTodoChannel(i))) return;

      const guildId = i.guildId!;
      const todoId = allowedChannelId!;

      if (sub === 'add') {
        const title = i.options.getString('title', true);
        const notes = i.options.getString('notes') ?? null;
        const dueStr = i.options.getString('due') ?? null;
        const priority = Math.min(3, Math.max(1, i.options.getInteger('priority') ?? 2));

        // rettighets-sjekk i #todo
        const todoCh = (await client.channels.fetch(todoId)) as TextChannel;
        const me = await i.guild!.members.fetchMe();
        const perms = todoCh.permissionsFor(me);
        if (!perms?.has(['ViewChannel', 'SendMessages', 'EmbedLinks'])) {
          await i.editReply({
            content:
              `Mangler rettigheter i <#${todoId}> (trenger: ViewChannel, SendMessages, EmbedLinks).`,
          });
          return;
        }

        // DB → post → update (rollback ved feil)
        const created = await prisma.guildTask.create({
          data: {
            guildId,
            channelId: todoId,
            title,
            notes,
            dueAt: parseDue(dueStr),
            priority,
            createdBy: i.user.id,
          },
        });

        try {
          const msg = await todoCh.send({
            embeds: [taskEmbed(created)],
            components: taskButtons(created),
          });
          await prisma.guildTask.update({
            where: { id: created.id },
            data: { messageId: msg.id },
          });
          await i.editReply({ content: `Oppgave opprettet i <#${todoId}>.` });
        } catch (err: any) {
          await prisma.guildTask.delete({ where: { id: created.id } }); // rollback
          await i.editReply({
            content: `Klarte ikke å poste i <#${todoId}>: ${String(err?.message ?? err)}`.slice(
              0,
              300
            ),
          });
        }
        return;
      }

      if (sub === 'list') {
        const filter = i.options.getString('filter') ?? 'open';
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
                const tail = link || `(ID: ${t.id.slice(0, 6)})`;
                const ghost = t.messageId ? '' : '⚠️ ';
                return `${ghost}${who} ${prio(t.priority)} **${t.title}** ${due} ${tail}`;
              })
              .join('\n')
          : 'Ingen oppgaver.';

        await i.editReply({ content: `**Oppgaver (${filter})**\n${lines}` });
        return;
      }

      if (sub === 'delete') {
        const idInput = i.options.getString('id', true).trim();
        if (idInput.length < 6) {
          await i.editReply({ content: 'Bruk minst 6 tegn av ID-en (prefix).' });
          return;
        }

        const hits = await prisma.guildTask.findMany({
          where: { guildId, id: { startsWith: idInput } },
          take: 2,
        });
        if (hits.length === 0) {
          await i.editReply({ content: 'Fant ingen oppgave som matcher den ID-en.' });
          return;
        }
        if (hits.length > 1) {
          await i.editReply({ content: 'Flere oppgaver matcher prefixet. Oppgi hele ID-en.' });
          return;
        }

        const t = hits[0];
        const member: any = i.member;
        const canDelete =
          t.createdBy === i.user.id ||
          (member?.permissions && member.permissions.has(PermissionFlagsBits.ManageMessages));
        if (!canDelete) {
          await i.editReply({ content: 'Du har ikke lov til å slette denne oppgaven.' });
          return;
        }

        await prisma.guildTask.delete({ where: { id: t.id } });
        await deleteTaskMessage(t);
        await i.editReply({ content: `Slettet: \`${t.id.slice(0, 6)}\`` });
        return;
      }

      if (sub === 'cleanup') {
        const member: any = i.member;
        if (!(member?.permissions && member.permissions.has(PermissionFlagsBits.ManageMessages))) {
          await i.editReply({ content: 'Kun moderatorer (Manage Messages) kan kjøre cleanup.' });
          return;
        }
        const ghosts = await prisma.guildTask.findMany({
          where: { guildId, OR: [{ messageId: null }, { messageId: '' }] },
          take: 200,
        });
        for (const t of ghosts) await prisma.guildTask.delete({ where: { id: t.id } });
        await i.editReply({ content: `Cleanup: fjernet ${ghosts.length} oppgaver uten melding.` });
        return;
      }
    }

    /* ---- Buttons ---- */
    if (interaction.isButton() && interaction.customId.startsWith('task:')) {
      const i = interaction as ButtonInteraction;
      await i.deferUpdate();

      const [, action, id] = i.customId.split(':');
      const task = await prisma.guildTask.findUnique({ where: { id } });
      if (!task) {
        await i.followUp({ content: 'Oppgaven finnes ikke lenger.', flags: MessageFlags.Ephemeral });
        return;
      }
      if (allowedChannelId && task.channelId !== allowedChannelId) {
        await i.followUp({ content: 'Denne oppgaven er låst til #todo.', flags: MessageFlags.Ephemeral });
        return;
      }

      if (action === 'claim') {
        const updated = await prisma.guildTask.update({
          where: { id },
          data:
            task.claimedBy === i.user.id
              ? { claimedBy: null, claimedAt: null }
              : { claimedBy: i.user.id, claimedAt: new Date() },
        });
        await updateTaskMessage(updated);
        return;
      }

      if (action === 'done') {
        if (task.done) return;
        const updated = await prisma.guildTask.update({
          where: { id },
          data: { done: true, completedBy: i.user.id, completedAt: new Date() },
        });
        await updateTaskMessage(updated);
        return;
      }

      if (action === 'del') {
        const member: any = i.member;
        const canDelete =
          task.createdBy === i.user.id ||
          (member?.permissions && member.permissions.has(PermissionFlagsBits.ManageMessages));
        if (!canDelete) {
          await i.followUp({ content: 'Du har ikke lov til å slette denne oppgaven.', flags: MessageFlags.Ephemeral });
          return;
        }
        await prisma.guildTask.delete({ where: { id } });
        await deleteTaskMessage(task);
        return;
      }
    }
  } catch (e) {
    console.error(e);
    if (interaction.isRepliable()) {
      if ('deferred' in interaction && (interaction as any).deferred) {
        await (interaction as any).editReply({ content: 'Noe gikk galt 🤕' }).catch(() => {});
      } else {
        await (interaction as any).reply({ content: 'Noe gikk galt 🤕', flags: MessageFlags.Ephemeral }).catch(() => {});
      }
    }
  }
});

/* ===== Discord login ===== */
client.login(DISCORD_TOKEN);

/* ===== Express API ===== */
const app = express();

app.get('/healthz', (_req, res) => {
  return res.json({ ok: true, discordReady: !!client.isReady(), now: new Date().toISOString() });
});

app.use('/api', (req, res, next) => {
  if (PUBLIC_READ === 'true') return next();
  const expected = (API_KEY ?? '').trim();
  const got = (req.header('x-api-key') ?? '').trim();
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
