import "dotenv/config";
import { Client, GatewayIntentBits, Partials } from "discord.js";
import { createServer } from "node:http";
import { Server } from "socket.io";
import { extractDropEvents } from "./mediaExtractor.js";

const token = process.env.DISCORD_TOKEN;
const wsPort = Number(process.env.WS_PORT ?? "3000");
const allowedOrigins = process.env.WS_ALLOWED_ORIGINS?.split(",").map((origin) => origin.trim()).filter(Boolean) ?? ["*"];
const monitoredChannelIds = (process.env.DISCORD_CHANNEL_IDS ?? "")
  .split(",")
  .map((channelId) => channelId.trim())
  .filter(Boolean);

if (!token) {
  throw new Error("DISCORD_TOKEN is required.");
}

const shouldMonitorChannel = (channelId: string): boolean => {
  if (monitoredChannelIds.length === 0) {
    return true;
  }

  return monitoredChannelIds.includes(channelId);
};

const httpServer = createServer();

const io = new Server(httpServer, {
  cors: {
    origin: allowedOrigins
  }
});

io.on("connection", (socket) => {
  console.log(`Desktop client connected: ${socket.id}`);

  socket.on("disconnect", (reason) => {
    console.log(`Desktop client disconnected: ${socket.id} (${reason})`);
  });
});

const discordClient = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  partials: [Partials.Channel]
});

discordClient.once("ready", () => {
  console.log(`Discord bot ready as ${discordClient.user?.tag ?? "unknown"}`);
});

discordClient.on("messageCreate", async (message) => {
  if (message.author.bot || !shouldMonitorChannel(message.channelId)) {
    return;
  }

  try {
    const events = await extractDropEvents(message);

    for (const event of events) {
      io.emit("meme:drop", event);
      console.log(`Broadcasted media ${event.kind} from ${event.author}: ${event.url}`);
    }
  } catch (error) {
    console.error("Failed to process Discord message", error);
  }
});

httpServer.listen(wsPort, () => {
  console.log(`WebSocket relay listening on port ${wsPort}`);
});

void discordClient.login(token).catch((error) => {
  console.error("Unable to login Discord bot", error);
  process.exitCode = 1;
});

process.on("uncaughtException", (error) => {
  console.error("Uncaught exception", error);
});

process.on("unhandledRejection", (error) => {
  console.error("Unhandled rejection", error);
});
