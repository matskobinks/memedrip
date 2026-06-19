import type { DropEvent, MediaKind } from "./types.js";

const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".webp", ".bmp", ".svg", ".gif"];
const VIDEO_EXTENSIONS = [".mp4", ".webm", ".mov", ".m4v", ".avi", ".mkv"];

const MEDIA_LINK_REGEX = /(https?:\/\/[^\s]+)/gi;

interface AttachmentLike {
  id?: string;
  url: string;
  contentType?: string | null;
  name?: string | null;
}

export interface DiscordMessageLike {
  id: string;
  content: string;
  createdAt: Date;
  channelId: string;
  author?: { username?: string | null };
  attachments: Map<string, AttachmentLike> | AttachmentLike[];
}

const hasExtension = (url: string, extensions: string[]) => {
  const pathname = new URL(url).pathname.toLowerCase();
  return extensions.some((extension) => pathname.endsWith(extension));
};

const inferAttachmentKind = (attachment: AttachmentLike): MediaKind | null => {
  const contentType = attachment.contentType?.toLowerCase() ?? "";
  const fileName = attachment.name?.toLowerCase() ?? "";

  if (contentType.startsWith("image/")) {
    return contentType.includes("gif") ? "gif" : "image";
  }

  if (contentType.startsWith("video/")) {
    return "video";
  }

  const urlOrName = `${attachment.url}${fileName}`;

  if (hasExtension(urlOrName, VIDEO_EXTENSIONS)) {
    return "video";
  }

  if (hasExtension(urlOrName, IMAGE_EXTENSIONS)) {
    return urlOrName.endsWith(".gif") ? "gif" : "image";
  }

  return null;
};

const getDurationForKind = (kind: MediaKind): number => {
  if (kind === "video") {
    return 15000;
  }

  return 7000;
};

const extractLinks = (content: string): string[] => {
  if (!content) {
    return [];
  }

  return [...content.matchAll(MEDIA_LINK_REGEX)]
    .map((match) => match[0].replace(/[)>.,!?]$/, ""))
    .filter((candidate, index, links) => links.indexOf(candidate) === index);
};

const extractMetaUrl = (html: string): string | null => {
  const metaPatterns = [
    /<meta\s+property=["']og:video:url["']\s+content=["']([^"']+)["']/i,
    /<meta\s+property=["']og:video["']\s+content=["']([^"']+)["']/i,
    /<meta\s+property=["']og:image["']\s+content=["']([^"']+)["']/i,
    /<meta\s+name=["']twitter:image["']\s+content=["']([^"']+)["']/i
  ];

  for (const pattern of metaPatterns) {
    const match = html.match(pattern);

    if (match?.[1]) {
      return match[1];
    }
  }

  return null;
};

const hostMatches = (hostname: string, expectedHost: string): boolean => {
  return hostname === expectedHost || hostname.endsWith(`.${expectedHost}`);
};

const isGifProvider = (url: URL): boolean => {
  const host = url.hostname.toLowerCase();
  return hostMatches(host, "tenor.com") || hostMatches(host, "giphy.com") || hostMatches(host, "media.giphy.com");
};

const resolveWithTimeout = async (url: string, fetchFn: typeof fetch): Promise<Response> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);

  try {
    return await fetchFn(url, {
      signal: controller.signal,
      headers: {
        "user-agent": "memedrip-bot/1.0"
      }
    });
  } finally {
    clearTimeout(timer);
  }
};

export const resolveGifSourceUrl = async (link: string, fetchFn: typeof fetch = fetch): Promise<string | null> => {
  let parsed: URL;

  try {
    parsed = new URL(link);
  } catch {
    return null;
  }

  if (!isGifProvider(parsed)) {
    return null;
  }

  if (hostMatches(parsed.hostname.toLowerCase(), "media.giphy.com")) {
    return link;
  }

  try {
    const response = await resolveWithTimeout(link, fetchFn);

    if (!response.ok) {
      return null;
    }

    const html = await response.text();
    const resolved = extractMetaUrl(html);

    if (!resolved) {
      return null;
    }

    return new URL(resolved, parsed.origin).toString();
  } catch {
    return null;
  }
};

const toAttachmentArray = (attachments: DiscordMessageLike["attachments"]): AttachmentLike[] => {
  return Array.isArray(attachments) ? attachments : Array.from(attachments.values());
};

export const extractDropEvents = async (
  message: DiscordMessageLike,
  fetchFn: typeof fetch = fetch
): Promise<DropEvent[]> => {
  const events: DropEvent[] = [];
  const author = message.author?.username ?? "unknown";

  for (const attachment of toAttachmentArray(message.attachments)) {
    const kind = inferAttachmentKind(attachment);

    if (!kind) {
      continue;
    }

    events.push({
      id: `${message.id}-${attachment.id ?? attachment.url}`,
      source: "discord",
      kind,
      url: attachment.url,
      author,
      channelId: message.channelId,
      createdAt: message.createdAt.toISOString(),
      durationMs: getDurationForKind(kind)
    });
  }

  for (const link of extractLinks(message.content)) {
    const sourceUrl = await resolveGifSourceUrl(link, fetchFn);

    if (!sourceUrl) {
      continue;
    }

    if (events.some((event) => event.url === sourceUrl)) {
      continue;
    }

    events.push({
      id: `${message.id}-${sourceUrl}`,
      source: "discord",
      kind: "gif",
      url: sourceUrl,
      author,
      channelId: message.channelId,
      createdAt: message.createdAt.toISOString(),
      durationMs: getDurationForKind("gif")
    });
  }

  return events;
};
