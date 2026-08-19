// Builds (or rebuilds) the YomagAudio Discord server's channel/role
// structure via the Discord REST API. Used once to stand up the current
// server - kept here so the structure is reproducible (a new server, a
// disaster-recovery rebuild, or extending it later) instead of being a
// one-off script that only ever existed in someone's temp directory.
//
// WARNING: this DELETES every existing channel in the target guild before
// recreating the structure below (see the wipe step in main()) - it's
// meant for standing up a fresh server, not for touching one with real
// conversation history/pinned messages/etc. already in it. If you need to
// add a channel to a live server, do it by hand or extend this script to
// diff against what already exists instead of wiping first.
//
// Usage:
//   node setup_discord_server.mjs
//
// Prerequisites (all manual, browser-only - see community/README.md for
// the full walkthrough, including why bots can't create the guild itself):
//   1. A Discord Application + Bot at https://discord.com/developers/applications,
//      with a bot token.
//   2. A Discord server already created (by a human - POST /guilds returns
//      "Bots cannot use this endpoint" (code 20001), confirmed as of this
//      writing, so there's no way around this step).
//   3. The bot invited to that server with Administrator permission:
//      https://discord.com/api/oauth2/authorize?client_id=<APPLICATION_ID>&permissions=8&scope=bot
//   4. That server's ID (Developer Mode on -> right-click the server icon
//      -> Copy Server ID) passed as YOMAG_DISCORD_GUILD_ID below.
//
// The bot token itself is read from discord_token.txt next to this
// script - NEVER hardcode it here or pass it as a CLI arg/env var that
// could end up in shell history; add discord_token.txt to .gitignore and
// delete it once you're done running this.

import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

const __dirname = dirname(fileURLToPath(import.meta.url))
const TOKEN = readFileSync(join(__dirname, "discord_token.txt"), "utf-8").trim()
const API = "https://discord.com/api/v10"

async function discord(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bot ${TOKEN}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`${method} ${path} -> ${res.status}: ${text}`)
  }
  if (res.status === 204) return null
  return res.json()
}

const CHANNEL_TYPE = { GUILD_TEXT: 0, GUILD_VOICE: 2, GUILD_CATEGORY: 4 }

const STRUCTURE = [
  {
    name: "WELCOME",
    channels: [
      { name: "welcome", topic: "Start here." },
      { name: "announcements", topic: "Releases and project updates." },
    ],
  },
  {
    name: "COMMUNITY",
    channels: [
      { name: "general", topic: "General discussion." },
      { name: "showcase", topic: "Share your routing setups and recordings." },
      { name: "feature-requests", topic: "Suggest and discuss new features." },
    ],
  },
  {
    name: "SUPPORT",
    channels: [
      { name: "help", topic: "Ask for help using YomagAudio." },
      { name: "bug-reports", topic: "Report bugs (or use the GitHub issue tracker)." },
    ],
  },
  {
    name: "DEVELOPMENT",
    channels: [{ name: "dev-chat", topic: "Development discussion." }],
  },
]

const ROLES = ["Maintainer", "Contributor", "Member"]

const WELCOME_MESSAGE = `**Welcome to the YomagAudio community!**

YomagAudio is a Windows audio routing/mixing app with built-in multitrack recording and editing — an open-source alternative to Loopback/Voicemeeter.

- <#{announcements}> for release updates
- <#{help}> if you're stuck
- <#{showcase}> to share what you've built
- GitHub: https://github.com/Yomag84/yomag-audio

Have fun!`

async function main() {
  let guildId = process.env.YOMAG_DISCORD_GUILD_ID

  if (!guildId) {
    console.log("No YOMAG_DISCORD_GUILD_ID set - attempting to create a new guild via POST /guilds ...")
    try {
      const guild = await discord("POST", "/guilds", { name: "YomagAudio" })
      guildId = guild.id
      console.log(`Created guild "${guild.name}" (${guildId})`)
    } catch (err) {
      console.error("Guild creation failed - as of this writing, Discord flatly rejects bot-created")
      console.error('guilds ("Bots cannot use this endpoint", code 20001), regardless of guild count:')
      console.error(String(err))
      console.error("\nFallback: create the server yourself in the Discord app (the + at the bottom of")
      console.error("the server list -> Create My Own), then invite this bot with Administrator")
      console.error("permission using:")
      console.error(`  https://discord.com/api/oauth2/authorize?client_id=<YOUR_APPLICATION_ID>&permissions=8&scope=bot`)
      console.error("then re-run this script with YOMAG_DISCORD_GUILD_ID=<server id> set.")
      process.exit(1)
    }
  }

  // Wipe every existing channel (Discord's auto-created defaults, or
  // anything already there) so the structure below is the only thing
  // present. See the WARNING at the top of this file before re-running
  // this against a server that already has real content in it.
  const existing = await discord("GET", `/guilds/${guildId}/channels`)
  for (const ch of existing) {
    await discord("DELETE", `/channels/${ch.id}`)
  }

  const channelIds = {}
  for (const category of STRUCTURE) {
    const cat = await discord("POST", `/guilds/${guildId}/channels`, {
      name: category.name,
      type: CHANNEL_TYPE.GUILD_CATEGORY,
    })
    for (const ch of category.channels) {
      const created = await discord("POST", `/guilds/${guildId}/channels`, {
        name: ch.name,
        type: CHANNEL_TYPE.GUILD_TEXT,
        topic: ch.topic,
        parent_id: cat.id,
      })
      channelIds[ch.name] = created.id
    }
  }
  await discord("POST", `/guilds/${guildId}/channels`, {
    name: "General Voice",
    type: CHANNEL_TYPE.GUILD_VOICE,
  })

  for (const roleName of ROLES) {
    await discord("POST", `/guilds/${guildId}/roles`, { name: roleName, mentionable: true })
  }
  console.log(`Created roles: ${ROLES.join(", ")}`)
  console.log("Note: Discord has no API-level 'auto-assign on join' - assign Member manually, via")
  console.log("Server Settings -> Membership Screening/auto-role, or a persistent bot listening for join events.")

  const welcomeText = WELCOME_MESSAGE.replace("{announcements}", channelIds["announcements"]).replace(
    "{help}",
    channelIds["help"]
  ).replace("{showcase}", channelIds["showcase"])
  await discord("POST", `/channels/${channelIds["welcome"]}/messages`, { content: welcomeText })

  const invite = await discord("POST", `/channels/${channelIds["welcome"]}/invites`, {
    max_age: 0, // never expires
    max_uses: 0, // unlimited
  })

  console.log("\nDone.")
  console.log(`Guild ID:     ${guildId}`)
  console.log(`Invite link:  https://discord.gg/${invite.code}`)
  console.log("Plug both into README.md's Community & support badges.")
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
