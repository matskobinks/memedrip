import { describe, expect, it, vi } from "vitest";
import { extractDropEvents, resolveGifSourceUrl } from "../src/mediaExtractor.js";

describe("extractDropEvents", () => {
  it("extracts image attachments", async () => {
    const events = await extractDropEvents({
      id: "m1",
      content: "",
      channelId: "c1",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      author: { username: "alice" },
      attachments: [
        {
          id: "a1",
          url: "https://cdn.discordapp.com/file.png",
          contentType: "image/png",
          name: "file.png"
        }
      ]
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "image",
      durationMs: 7000,
      author: "alice"
    });
  });

  it("resolves Tenor/Giphy links to raw media URLs", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        '<html><head><meta property="og:image" content="https://media.tenor.com/abc123/tenor.gif"></head></html>',
        { status: 200 }
      )
    );

    const events = await extractDropEvents(
      {
        id: "m2",
        content: "https://tenor.com/view/example-gif-12345",
        channelId: "c1",
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        author: { username: "bob" },
        attachments: []
      },
      fetchMock
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "gif",
      url: "https://media.tenor.com/abc123/tenor.gif"
    });
  });

  it("ignores unrelated links", async () => {
    const url = await resolveGifSourceUrl("https://example.com/not-a-gif");

    expect(url).toBeNull();
  });
});
