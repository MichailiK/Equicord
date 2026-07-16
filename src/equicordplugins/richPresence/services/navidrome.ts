/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Logger } from "@utils/Logger";
import { parseUrl } from "@utils/misc";
import { TTLMap } from "@utils/TTLMap";
import { PluginNative } from "@utils/types";
import { Activity, ActivityButton } from "@vencord/discord-types";
import { ActivityFlags, ActivityStatusDisplayType } from "@vencord/discord-types/enums";
import { ApplicationAssetUtils, FluxDispatcher } from "@webpack/common";
import md5 from "md5";

import { settings } from "../settings";

function md5Hex(str: string): string {
    return md5(str);
}

const SOCKET_ID = "RichPresence_Navidrome";
const logger = new Logger("RichPresence:Navidrome");
const Native = VencordNative.pluginHelpers.RichPresence as PluginNative<typeof import("../native")>;

let updateTimer: NodeJS.Timeout | undefined;
let abortController: AbortController | undefined;
let currentTrackId: string | undefined;
let cachedStartTimestamp: number | undefined;
let cachedPauseTimestamp: number | undefined;
let cachedTrackState: string | undefined;
let lastMinutesAgo: number | undefined;
let cachedActivity: Activity | undefined;
let cachedSettingsJSON: string | undefined;
const lastFmCache = new Map<string, string | null>();
const mbidCache = new TTLMap<string, string | null>(8 * 60 * 60 * 1000);
const releaseCache = new TTLMap<string, MbRelease>(8 * 60 * 60 * 1000);

interface MbRelease {
    trackIds: Record<string, string>;
    hasFrontCover: boolean;
}

const pendingReleases = new Set<string>();

function getRelease(releaseMbid: string): MbRelease | undefined {
    if (!releaseCache.has(releaseMbid) && !pendingReleases.has(releaseMbid)) {
        pendingReleases.add(releaseMbid);
        Native.fetchMusicBrainzRelease(releaseMbid).then(release => {
            if (!release) return logger.warn("Failed to fetch release from MusicBrainz", releaseMbid);
            releaseCache.set(releaseMbid, release);
            cachedActivity = undefined;
            restartUpdates();
        }).finally(() => pendingReleases.delete(releaseMbid));
    }
    return releaseCache.get(releaseMbid);
}

interface NdTrack {
    id: string;
    title?: string;
    artist?: string;
    artistId?: string;
    artists?: { id: string; name: string; }[];
    album?: string;
    albumId?: string;
    musicBrainzId?: string;
    year?: number;
    suffix?: string;
    bitDepth?: number;
    bitRate?: number;
    samplingRate?: number;
    duration?: number;
    minutesAgo?: number;
    username?: string;
    state?: string;
    positionMs?: number;
    playbackRate?: number;
}

function customFormat(formatStr: string | undefined, track: NdTrack): string {
    if (!formatStr) return "";

    const numberFmt = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });
    const qualityStrings: string[] = [];
    if (track.suffix)
        qualityStrings.push(track.suffix.toUpperCase());
    if (track.bitDepth && track.samplingRate) {
        qualityStrings.push(`${track.bitDepth.toFixed()}/${(numberFmt.format(track.samplingRate / 1000))}`);
    }
    if (track.bitRate) {
        if (track.bitRate >= 2048)
            qualityStrings.push(`${(track.bitRate / 1024).toFixed(1)} Mb/s`);
        else
            qualityStrings.push(`${track.bitRate} kb/s`);
    }
    return formatStr
        .replaceAll("{song}", track.title ?? "")
        .replaceAll("{artist}", track.artists?.[0]?.name ?? track.artist ?? "")
        .replaceAll("{album}", track.album ?? "")
        .replaceAll("{year}", track.year ? `${track.year}` : "")
        .replaceAll("{quality}", qualityStrings.join(" · "));
}

async function getAsset(applicationId: string, key: string): Promise<string> {
    return (await ApplicationAssetUtils.fetchAssetIds(applicationId, [key]))[0];
}

function setActivity(activity: Activity | null) {
    FluxDispatcher.dispatch({ type: "LOCAL_ACTIVITY_UPDATE", activity, socketId: SOCKET_ID });
}

async function fetchNowPlaying(signal?: AbortSignal): Promise<NdTrack | null> {
    const { nd_serverUrl, nd_username, nd_password } = settings.store;

    if (!nd_serverUrl || !nd_username || !nd_password) {
        logger.warn("Navidrome server URL, username, or password is not set.");
        return null;
    }

    try {
        const parsedUrl = parseUrl(nd_serverUrl);
        if (!parsedUrl) {
            logger.warn("Navidrome server URL is invalid.");
            return null;
        }

        if (parsedUrl.protocol !== "https:") {
            logger.warn("Navidrome server URL must use HTTPS.");
            return null;
        }

        const salt = Math.random().toString(36).substring(2, 8);
        const token = md5Hex((nd_password ?? "") + salt);

        const baseUrl = parsedUrl.href.replace(/\/$/, "");
        const queryParams = `u=${encodeURIComponent(nd_username)}&t=${token}&s=${salt}&v=1.12.0&c=equicord-rpc&f=json`;

        const res = await fetch(`${baseUrl}/rest/getNowPlaying?${queryParams}`, { signal });
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);

        const data = await res.json();

        if (data["subsonic-response"]?.status === "failed") {
            logger.warn("Navidrome API error:", data["subsonic-response"].error?.message);
            return null;
        }

        const entries = data["subsonic-response"]?.nowPlaying?.entry;
        if (!entries || !Array.isArray(entries) || entries.length === 0) return null;

        const myEntries = entries.filter((e: NdTrack) => e.username?.toLowerCase() === nd_username.toLowerCase());
        return myEntries.find((e: NdTrack) => e.state?.toLowerCase() === "playing") ?? myEntries[0] ?? null;
    } catch (e: unknown) {
        if (e instanceof Error && e.name === "AbortError") throw e;
        logger.error("Failed to fetch from Navidrome API", e);
        return null;
    }
}

async function fetchMbid(baseUrl: string, type: "album" | "artist", id: string, signal?: AbortSignal): Promise<string | undefined> {
    const cacheKey = `${type}:${id}`;
    if (!mbidCache.has(cacheKey)) {
        const { nd_username, nd_password } = settings.store;
        const salt = Math.random().toString(36).substring(2, 8);
        const token = md5Hex((nd_password ?? "") + salt);
        const endpoint = type === "album" ? "getAlbum" : "getArtist";

        try {
            const res = await fetch(`${baseUrl}/rest/${endpoint}?id=${encodeURIComponent(id)}&u=${encodeURIComponent(nd_username ?? "")}&t=${token}&s=${salt}&v=1.12.0&c=equicord-rpc&f=json`, { signal });
            const json = await res.json();
            mbidCache.set(cacheKey, json["subsonic-response"]?.[type]?.musicBrainzId || null);
        } catch (e: unknown) {
            if (e instanceof Error && e.name === "AbortError") throw e;
            logger.warn(`Failed to fetch ${type} MBID from Navidrome`, e);
            return undefined;
        }
    }
    return mbidCache.get(cacheKey) ?? undefined;
}

function getSettingsJSON() {
    return JSON.stringify({
        nd_clientId: settings.store.nd_clientId,
        nd_showSmallImage: settings.store.nd_showSmallImage,
        nd_username: settings.store.nd_username,
        nd_password: settings.store.nd_password,
        nd_serverUrl: settings.store.nd_serverUrl,
        nd_nameString: settings.store.nd_nameString,
        nd_detailsString: settings.store.nd_detailsString,
        nd_stateString: settings.store.nd_stateString,
        nd_largeTextString: settings.store.nd_largeTextString,
        nd_activityType: settings.store.nd_activityType,
        nd_statusDisplayType: settings.store.nd_statusDisplayType,
        nd_albumArtMode: settings.store.nd_albumArtMode,
        nd_lastfmApiKey: settings.store.nd_lastfmApiKey,
        nd_showAlbum: settings.store.nd_showAlbum,
        nd_artistLink: settings.store.nd_artistLink,
        nd_hideOnPause: settings.store.nd_hideOnPause
    });
}

async function getActivity(signal?: AbortSignal): Promise<Activity | null> {
    const track = await fetchNowPlaying(signal);
    if (signal?.aborted) {
        const e = new Error("Aborted");
        e.name = "AbortError";
        throw e;
    }
    if (!track) return null;

    const currentSettingsJSON = getSettingsJSON();

    const isPaused = track.state?.toLowerCase() === "paused";

    if (track.id === currentTrackId && cachedActivity && cachedSettingsJSON === currentSettingsJSON) {
        let drift = false;
        if (track.positionMs !== undefined && !isPaused && cachedStartTimestamp) {
            const expectedPosition = Date.now() - cachedStartTimestamp;
            if (Math.abs(expectedPosition - track.positionMs) > 2000) drift = true;
        }
        if (track.state === cachedTrackState && (track.minutesAgo ?? 0) === (lastMinutesAgo ?? 0) && !drift) {
            return cachedActivity;
        }
    }

    const { nd_clientId, nd_showSmallImage, nd_serverUrl, nd_showAlbum, nd_nameString, nd_detailsString, nd_stateString, nd_largeTextString, nd_activityType, nd_statusDisplayType, nd_lastfmApiKey, nd_hideOnPause } = settings.store;

    if (isPaused && nd_hideOnPause) {
        cachedPauseTimestamp = undefined;
        return null;
    }

    const _clientId = nd_clientId?.trim();
    const appId = _clientId === "" ? "1470554657506984069" : (_clientId ?? "1470554657506984069");

    const _serverUrl = nd_serverUrl?.trim();
    const parsedExternalUrl = parseUrl(_serverUrl ?? "");
    const externalBaseUrl = parsedExternalUrl ? parsedExternalUrl.href.replace(/\/$/, "") : null;

    const durationMs = (track.duration ?? 0) * 1000;

    const trackMinutesAgo = track.minutesAgo ?? 0;

    if (track.id !== currentTrackId || !cachedStartTimestamp) {
        currentTrackId = track.id;
        const elapsedMs = track.positionMs ?? (trackMinutesAgo * 60 * 1000);
        cachedStartTimestamp = Date.now() - elapsedMs;
        lastMinutesAgo = trackMinutesAgo;
    } else {
        if (track.positionMs !== undefined) {
            if (!isPaused) {
                const expectedPosition = Date.now() - cachedStartTimestamp;
                if (Math.abs(expectedPosition - track.positionMs) > 2000) {
                    cachedStartTimestamp = Date.now() - track.positionMs;
                }
            }
        } else {
            if (trackMinutesAgo < (lastMinutesAgo ?? 0) || trackMinutesAgo > (lastMinutesAgo ?? 0) + 1) {
                const elapsedMs = trackMinutesAgo * 60 * 1000;
                cachedStartTimestamp = Date.now() - elapsedMs;
            }
        }
        lastMinutesAgo = trackMinutesAgo;
    }

    if (isPaused) {
        if (!cachedPauseTimestamp) {
            cachedPauseTimestamp = Date.now();
        }
    } else {
        cachedPauseTimestamp = undefined;
    }

    const endTimestamp = cachedStartTimestamp + durationMs;

    const isPlaying = Number(nd_activityType ?? 2) === 0;
    const nameString = !isPlaying ? customFormat(nd_nameString || "Navidrome", track) : "Navidrome";

    const detailsString = customFormat(nd_detailsString, track);
    let stateString = customFormat(nd_stateString, track);

    if (isPaused) {
        stateString = stateString ? `${stateString} (Paused)` : "Paused";
    }

    const assets: Activity["assets"] = {};
    if (nd_showAlbum && nd_largeTextString) {
        const largeText = customFormat(nd_largeTextString, track);
        if (largeText) {
            if (Number(nd_activityType ?? 2) === 0) {
                stateString = stateString ? `${stateString} • ${largeText}` : largeText;
            } else {
                assets.large_text = largeText;
            }
        }
    }

    const artistId = track.artists?.[0]?.id ?? track.artistId;
    const [albumMbid, artistMbid] = externalBaseUrl ? await Promise.all([
        track.albumId ? fetchMbid(externalBaseUrl, "album", track.albumId, signal) : undefined,
        settings.store.nd_artistLink && artistId ? fetchMbid(externalBaseUrl, "artist", artistId, signal) : undefined,
    ]) : [];
    const release = albumMbid ? getRelease(albumMbid) : undefined;

    const albumArtMode = settings.store.nd_albumArtMode ?? "none";
    let resolvedCoverArtUrl: string | null = null;

    if (albumArtMode === "coverartarchive" && albumMbid && release?.hasFrontCover) {
        resolvedCoverArtUrl = `https://coverartarchive.org/release/${albumMbid}/front-250`;
    } else if (albumArtMode === "lastfm" && track.artist) {
        const trimmedKey = nd_lastfmApiKey?.trim();
        const apiKey = trimmedKey || "feff915bf5987580c9dc354d523dc6b9";
        const cacheKey = `${track.id}:${apiKey}`;

        if (lastFmCache.has(cacheKey)) {
            resolvedCoverArtUrl = lastFmCache.get(cacheKey) ?? null;
        } else {
            try {
                const artist = encodeURIComponent(track.artist);
                let image: string | undefined;

                if (track.album) {
                    const album = encodeURIComponent(track.album);
                    const res = await fetch(`https://ws.audioscrobbler.com/2.0/?method=album.getinfo&api_key=${apiKey}&artist=${artist}&album=${album}&format=json`, { signal });
                    const json = await res.json();
                    image = json?.album?.image?.at(-1)?.["#text"];
                }

                if (!image && track.title) {
                    const title = encodeURIComponent(track.title);
                    const res = await fetch(`https://ws.audioscrobbler.com/2.0/?method=track.getinfo&api_key=${apiKey}&artist=${artist}&track=${title}&format=json`, { signal });
                    const json = await res.json();
                    image = json?.track?.album?.image?.at(-1)?.["#text"];
                }

                resolvedCoverArtUrl = image ?? null;
                lastFmCache.set(cacheKey, resolvedCoverArtUrl);
            } catch (e: unknown) {
                if (e instanceof Error && e.name === "AbortError") throw e;
                resolvedCoverArtUrl = null;
                lastFmCache.set(cacheKey, null);
            }
        }
    }

    let largeImagePromise: Promise<string>;
    if (resolvedCoverArtUrl) {
        largeImagePromise = getAsset(appId, resolvedCoverArtUrl).catch(() => "navidrome");
    } else {
        largeImagePromise = getAsset(appId, "navidrome").catch(() => "navidrome");
    }

    let smallImagePromise: Promise<string> | undefined;
    if (nd_showSmallImage) {
        smallImagePromise = getAsset(appId, "navidrome").catch(() => "navidrome");
        assets.small_text = "Navidrome";
    }

    const [largeImage, smallImage] = await Promise.all([
        largeImagePromise,
        smallImagePromise ?? Promise.resolve("")
    ]);

    assets.large_image = largeImage;
    if (nd_showSmallImage && smallImage) {
        assets.small_image = smallImage;
    }

    if (signal?.aborted) {
        const e = new Error("Aborted");
        e.name = "AbortError";
        throw e;
    }

    const activity: Activity = {
        application_id: appId,
        name: nameString || "Navidrome",
        details: detailsString || undefined,
        state: stateString || undefined,
        status_display_type: nd_statusDisplayType ? {
            "off": ActivityStatusDisplayType.NAME,
            "artist": ActivityStatusDisplayType.STATE,
            "track": ActivityStatusDisplayType.DETAILS
        }[nd_statusDisplayType as "off" | "artist" | "track"] : undefined,
        type: (isPaused && !nd_hideOnPause) ? 0 : Number(nd_activityType ?? 2),
        flags: ActivityFlags.INSTANCE,
        timestamps: isPaused && !nd_hideOnPause ? {
            start: cachedPauseTimestamp,
        } : {
            start: cachedStartTimestamp,
            end: durationMs > 0 ? endTimestamp : undefined,
        },
        assets,
    };

    if (track.musicBrainzId) activity.details_url = `https://listenbrainz.org/track/${track.musicBrainzId}`;
    if (artistMbid) activity.state_url = `https://listenbrainz.org/artist/${artistMbid}`;
    if (albumMbid) assets.large_url = `https://musicbrainz.org/release/${albumMbid}`;

    const buttons: ActivityButton[] = [];
    if (albumMbid) {
        const trackMbid = track.musicBrainzId && release?.trackIds[track.musicBrainzId];
        buttons.push({ label: "View Album on ListenBrainz", url: `https://listenbrainz.org/release/${albumMbid}` });
        buttons.push({ label: "View on MusicBrainz", url: `https://musicbrainz.org/release/${albumMbid}${trackMbid ? `#${trackMbid}` : ""}` });
    }

    if (buttons.length) {
        activity.buttons = buttons.map(b => b.label);
        activity.metadata = { button_urls: buttons.map(b => b.url) };
    }

    cachedSettingsJSON = currentSettingsJSON;
    cachedActivity = activity;
    cachedTrackState = track.state;
    return activity;
}

async function updatePresence() {
    try {
        const activity = await getActivity(abortController?.signal);
        setActivity(activity);
        if (!activity) {
            currentTrackId = undefined;
            cachedStartTimestamp = undefined;
            lastMinutesAgo = undefined;
            cachedActivity = undefined;
            cachedSettingsJSON = undefined;
            cachedTrackState = undefined;
            cachedPauseTimestamp = undefined;
        }
    } catch (e: unknown) {
        if (e instanceof Error && e.name === "AbortError") return;
        logger.error("Failed to update presence", e);
        setActivity(null);
        currentTrackId = undefined;
        cachedStartTimestamp = undefined;
        cachedPauseTimestamp = undefined;
        lastMinutesAgo = undefined;
        cachedActivity = undefined;
        cachedSettingsJSON = undefined;
        cachedTrackState = undefined;
    }

    if (abortController && !abortController.signal.aborted) {
        const interval = (settings.store.nd_refreshInterval as number) ?? 10;
        updateTimer = setTimeout(updatePresence, interval * 1000);
    }
}

export function start() {
    abortController = new AbortController();
    updatePresence();
}

export function forceUpdate() {
    const currentSettingsJSON = getSettingsJSON();

    if (cachedSettingsJSON === currentSettingsJSON) {
        return;
    }

    restartUpdates();
}

function restartUpdates() {
    if (abortController && !abortController.signal.aborted) {
        abortController.abort();
        clearTimeout(updateTimer);
        abortController = new AbortController();
        updatePresence();
    }
}

export function stop() {
    abortController?.abort();
    abortController = undefined;
    clearTimeout(updateTimer);
    lastFmCache.clear();
    mbidCache.clear();
    releaseCache.clear();
    updateTimer = undefined;
    currentTrackId = undefined;
    cachedStartTimestamp = undefined;
    cachedPauseTimestamp = undefined;
    lastMinutesAgo = undefined;
    cachedActivity = undefined;
    cachedSettingsJSON = undefined;
    cachedTrackState = undefined;
    setActivity(null);
}
