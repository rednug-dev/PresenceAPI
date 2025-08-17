import 'dotenv/config';
import { REST, Routes, SlashCommandBuilder } from 'discord.js';

const task = new SlashCommandBuilder()
  .setName('task')
  .setDescription('Server to-do (kun i #todo)')
  .addSubcommand(sc =>
    sc.setName('add')
      .setDescription('Legg til oppgave')
      .addStringOption(o => o.setName('title').setDescription('Tittel').setRequired(true))
      .addStringOption(o => o.setName('notes').setDescription('Notater'))
      .addStringOption(o => o.setName('due').setDescription('YYYY-MM-DD HH:mm'))
      .addIntegerOption(o => o.setName('priority').setDescription('1=Høy, 2=Normal, 3=Lav')))
  .addSubcommand(sc =>
    sc.setName('list')
      .setDescription('List oppgaver')
      .addStringOption(o => o.setName('filter').setDescription('open|claimed|done|all')
        .addChoices(
          { name: 'open', value: 'open' },
          { name: 'claimed', value: 'claimed' },
          { name: 'done', value: 'done' },
          { name: 'all', value: 'all' },
        )))
  .addSubcommand(sc =>
    sc.setName('delete')
      .setDescription('Slett oppgave ved ID eller ID-prefix (6+ tegn)')
      .addStringOption(o => o.setName('id').setDescription('Oppgave-ID eller prefix').setRequired(true)))
  .addSubcommand(sc =>
    sc.setName('cleanup')
      .setDescription('Fjern “ghost tasks” uten melding (mods)'));

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN!);
const appId = process.env.DISCORD_CLIENT_ID!;
const guildId = process.env.GUILD_ID;

(async () => {
  if (!appId) throw new Error('DISCORD_CLIENT_ID mangler i .env');
  if (guildId) {
    await rest.put(Routes.applicationGuildCommands(appId, guildId), { body: [task.toJSON()] });
    console.log('Guild-kommandoer registrert:', guildId);
  } else {
    await rest.put(Routes.applicationCommands(appId), { body: [task.toJSON()] });
    console.log('Globale kommandoer registrert');
  }
})();
