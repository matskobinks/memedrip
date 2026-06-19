export type MediaKind = "image" | "video" | "gif";

export interface DropEvent {
  id: string;
  source: "discord";
  kind: MediaKind;
  url: string;
  author: string;
  channelId: string;
  createdAt: string;
  durationMs: number;
}
