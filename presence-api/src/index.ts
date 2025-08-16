import 'dotenv/config';
import express from 'express';
import { Client, GatewayIntentBits } from 'discord.js';

const {
  DISCORD_TOKEN,
  GUILD_ID,
  USER_IDS,
  PORT = '3000',
  PUBLIC_READ = 'false',
  API_KEY,
  CACHE_SECONDS = '20'
} = process.env as Record<string, string>;

if (!DISCORD_TOKEN || !GUILD_ID || !USER_IDS) {
  console.error('Missing env: DISCORD_TOKEN, GUILD_ID, USER_IDS');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildPresences
  ]
});

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
  const ids = USER_IDS.split(',').map(s => s.trim());

  return ids.map(id => {
    const m = guild.members.cache.get(id);
    const p = m?.presence;
    return {
      id,
      username: m?.user?.username ?? 'unknown',
      status: (p?.status as PresenceView['status']) ?? 'offline',
      activities: (p?.activities ?? []).map(a => ({
        name: a.name,
        type: String(a.type)
      })),
      avatarUrl: m?.user?.displayAvatarURL({ extension: 'png', size: 64 })
    };
  });
}

client.on('ready', () => {
  console.log(`Discord ready as ${client.user?.tag}`);
});

client.login(DISCORD_TOKEN);

const app = express();

/** PUBLIC: healthz er alltid åpen */
app.get('/healthz', (_req, res) => {
  return res.json({
    ok: true,
    discordReady: !!client.isReady(),
    now: new Date().toISOString()
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
