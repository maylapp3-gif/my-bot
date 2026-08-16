import { Api, type TelegramClient } from "telegram";

// Bridges the bot's callback handler to a specific moderator's userbot client
// so a one-tap "Block & delete" can act on the mod's PERSONAL account (block +
// wipe the DM) in addition to the bot side.
//
// This module imports NOTHING from bot/ — it's a leaf the bot side can depend
// on without creating an import cycle (bot/index never imports userbot/index).
export interface RegisteredUserbot {
  modChatId: string;
  client: TelegramClient;
  // InputPeer (carrying access_hash) stashed at detection time, keyed by the
  // peer's user id, so a later block/delete has a usable handle even for a
  // never-before-resolved stranger.
  inputPeers: Map<string, Api.TypeInputPeer>;
}

const registry = new Map<string, RegisteredUserbot>();

export function registerUserbot(entry: RegisteredUserbot): void {
  registry.set(entry.modChatId, entry);
}

export function getUserbot(modChatId: string): RegisteredUserbot | undefined {
  return registry.get(modChatId);
}
