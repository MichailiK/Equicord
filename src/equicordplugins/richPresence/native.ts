/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { VENCORD_USER_AGENT } from "@shared/vencordUserAgent";
import type { IpcMainInvokeEvent } from "electron";

import type { GrTrackData } from "./types/gensokyoRadio";

const MBID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export async function fetchMusicBrainzRelease(_: IpcMainInvokeEvent, releaseMbid: unknown): Promise<{ trackIds: Record<string, string>; hasFrontCover: boolean; } | null> {
    if (typeof releaseMbid !== "string" || !MBID_REGEX.test(releaseMbid)) return null;

    try {
        const res = await fetch(`https://musicbrainz.org/ws/2/release/${releaseMbid}?inc=recordings&fmt=json`, {
            headers: { "User-Agent": `${VENCORD_USER_AGENT} ( hello@michai.li )` }
        });
        if (!res.ok) return null;

        const json = await res.json();
        const tracks: { id: string; recording: { id: string; }; }[] = json.media?.flatMap((m: { tracks?: unknown[]; }) => m.tracks ?? []) ?? [];
        return {
            trackIds: Object.fromEntries(tracks.map(t => [t.recording.id, t.id])),
            hasFrontCover: !!json["cover-art-archive"]?.front,
        };
    } catch {
        return null;
    }
}

export async function fetchTrackData(): Promise<GrTrackData | null> {
    const song = await (await fetch("https://gensokyoradio.net/api/station/playing/")).json();

    return {
        title: song.SONGINFO.TITLE,
        album: song.SONGINFO.ALBUM,
        artist: song.SONGINFO.ARTIST,
        position: song.SONGTIMES.SONGSTART,
        duration: song.SONGTIMES.SONGEND,
        artwork: song.MISC.ALBUMART ? `https://gensokyoradio.net/images/albums/500/${song.MISC.ALBUMART}` : "",
    };
}
