/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export interface JfSession {
    UserId: string;
    NowPlayingItem?: JfNowPlayingItem;
    PlayState?: {
        IsPaused?: boolean;
        PositionTicks?: number;
        MediaSourceId?: string;
    };
}

export interface JfMediaStream {
    Type?: string;
    Codec?: string;
    Width?: number;
    Height?: number;
    VideoRangeType?: string;
}

export interface JfNowPlayingItem {
    Name?: string;
    Type?: string;
    Id?: string;
    SeriesId?: string;
    SeriesName?: string;
    Artists?: string[];
    AlbumArtist?: string;
    Album?: string;
    ParentIndexNumber?: number;
    IndexNumber?: number;
    ProductionYear?: number;
    RunTimeTicks?: number;
    ImageTags?: { Primary?: string; };
    ProviderIds?: Record<string, string>;
    Studios?: { Name?: string; }[];
    MediaStreams?: JfMediaStream[];
    MediaSources?: { Id?: string; MediaStreams?: JfMediaStream[]; }[];
}

export interface JfMediaData {
    name: string;
    type: string;
    artist?: string;
    album?: string;
    seriesName?: string;
    seasonNumber?: number;
    episodeNumber?: number;
    year?: number;
    url?: string;
    imageUrl?: string;
    duration?: number;
    position?: number;
    isPaused?: boolean;
    providerIds?: Record<string, string>;
    seriesProviderIds?: Record<string, string>;
    videoQuality?: string;
    videoResolution?: string;
    videoFormat?: string;
    studio?: string;
}
