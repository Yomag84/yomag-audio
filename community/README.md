# Community setup

Tooling for standing up YomagAudio's community presence — currently just
the Discord server. Not part of the shipped app; these are one-off admin
scripts, run by hand when needed.

## Discord server

The live server: **https://discord.gg/fKWNtBHYHt**

`setup_discord_server.mjs` builds the server's channel/role structure via
the [Discord REST API](https://discord.com/developers/docs/intro) —
4 categories, 8 text channels, 1 voice channel, 3 roles, a welcome
message, and a permanent invite link, all in one run. It's what created
the current server, and it's kept here (rather than as a throwaway
script) so the structure is reproducible — a new server, a
disaster-recovery rebuild, or a starting point for extending it.

### Why this needs manual steps first

Discord's API has no way to create an application/bot (that's tied to
logging into the Developer Portal in a browser), and — confirmed while
setting this up — bots are flatly blocked from creating a new guild at
all (`POST /guilds` returns `"Bots cannot use this endpoint"`, code
`20001`, regardless of how few servers the bot is in). So the one-time
setup is:

1. Create a Discord Application + Bot at
   [discord.com/developers/applications](https://discord.com/developers/applications),
   copy its bot token.
2. **You** create the server (Discord app → **+** at the bottom of the
   server list → **Create My Own**).
3. Invite the bot to it with Administrator permission:
   `https://discord.com/api/oauth2/authorize?client_id=<APPLICATION_ID>&permissions=8&scope=bot`
   (Application ID is on the Developer Portal's General Information tab.)
4. Get the server ID (User Settings → Advanced → enable Developer Mode →
   right-click the server icon → Copy Server ID).
5. Save the bot token to `discord_token.txt` in this directory (it's
   `.gitignore`d — never commit it, and delete the file once you're done).
6. Run:
   ```bash
   YOMAG_DISCORD_GUILD_ID=<server id> node setup_discord_server.mjs
   ```

### ⚠️ Destructive on re-run

The script **deletes every existing channel** in the target guild before
recreating the structure, so it's safe for standing up a fresh server but
not for touching one that already has real conversation history, pinned
messages, or channels you've added since. If you need to add a channel to
the live server, do it by hand in Discord, or extend the script to diff
against what's already there instead of wiping first.

### After running it

- Assign the **Member** role to yourself/new joiners manually (Server
  Settings → Membership Screening, or by hand) — there's no API-level
  "auto-assign on join" without a persistent bot listening for member
  events, which this script isn't.
- Consider demoting the bot's permissions once you're done (Server
  Settings → Roles → the bot's role → uncheck Administrator) — it doesn't
  need standing access after the one-time setup.
- Update the invite link / guild ID in the root `README.md`'s
  **Community & support** section if you rebuild the server.
