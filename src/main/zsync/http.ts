/*
 * Copyright (C) 2022 Klaus Reimer <k@ailis.de>
 * Copyright (C) 2004,2005,2007,2009 Colin Phipps <cph@moria.org.uk>
 * See LICENSE.md for licensing information.
 */

import { request as httpRequest } from "http";
import { request as httpsRequest, RequestOptions } from "https";
import { file as tmpfile } from "tmp-promise";

import { ZSyncError } from "../ZSyncError";
import { fclose, FILE, fopen, fwrite } from "./stdio";

export let referer: string | null = null;

export function setReferer(ref: string): void {
    referer = ref;
}

export interface range_fetch {
    /* URL to retrieve from, host:port */
    url: string | null;

    /* Byte ranges to fetch */
    ranges_todo: number[] | null; /* Contains 2*nranges ranges, consisting of start and stop offset */
    nranges: number;
    rangessent: number;     /* We've requested the first rangessent ranges from the remote */
    rangesdone: number;     /* and received this many */
}

export async function http_get(orig_url: string, tfname: string | null, track_referer: (ref: string) => void):
        Promise<FILE> {
    track_referer(orig_url);
    return new Promise<FILE>((resolve, reject) => {
        const options: RequestOptions = {
            method: "GET",
            ca: process.env["CACERT"]

        };
        const request = orig_url.startsWith("https:") ? httpsRequest : httpRequest;
        const req = request(orig_url, options, async res => {
            if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307) {
                if (res.headers.location == null) {
                    reject(new ZSyncError("HTTP redirect has no location header"));
                } else {
                    http_get(new URL(res.headers.location, orig_url).href, tfname, track_referer)
                        .then(resolve, reject);
                }
                return;
            }
            if (res.statusCode !== 200) {
                reject(new ZSyncError(`HTTP request to '${orig_url}' failed with status ${res.statusCode}: `
                    + `${res.statusMessage}`));
                return;
            }
            const name = tfname ?? ((await tmpfile()).path);
            const file = await fopen(name, "w");
            res.on("data", async (chunk: Buffer) => {
                await fwrite(chunk, 1, chunk.length, file);
            });
            res.on("end", async () => {
                await fclose(file);
                resolve(await fopen(name, "r"));
            });
        });
        req.end();
    });
}

/* range_fetch_set_url(rf, url)
 * Set up a range_fetch to fetch from a given URL. Private method.
 * C is a nightmare for memory allocation here. At least the errors should be
 * caught, but minor memory leaks may occur on some error paths. */
function range_fetch_set_url(rf: range_fetch, orig_url: string): void {
    /* Get the host, port and path from the URL. */
    const url = new URL(orig_url);

    // Set url to relative part and chost, cport to the target
    rf.url = url.pathname;
}


/* range_fetch_start(origin_url)
 * Returns a new range fetch object, for the given URL.
 */
export function range_fetch_start(orig_url: string): range_fetch | null {
    const rf: range_fetch = {
        /* Blank initialisation for other fields before set_url call */
        url: null,
        /* Initialise other state fields */
        ranges_todo: null,             /* And no ranges given yet */
        nranges: 0,
        rangesdone: 0,
        rangessent: 0
    };

    range_fetch_set_url(rf, orig_url);

    return rf;
}

/* range_fetch_addranges(self, off_t[], nranges)
 * Adds ranges to fetch, supplied as an array of 2*nranges offsets (start and
 * stop for each range) */
export function range_fetch_addranges(rf: range_fetch, ranges: number[], nranges: number): void {
    const existing_ranges = rf.nranges - rf.rangesdone;

    /* Allocate new memory, enough for valid existing entries and new entries */
    const nr: number[] = [];

    /* Copy only still-valid entries from the existing queue over */
    if (existing_ranges > 0) {
        if (rf.ranges_todo == null) {
            throw new Error("ranges_todo is null");
        }
        nr.push(...rf.ranges_todo.slice(2 * rf.rangesdone, 2 * (rf.rangesdone + existing_ranges)));
    }
    // memcpy(nr, &(rf->ranges_todo[2 * rf->rangesdone]),
    //        2 * sizeof(*ranges) * existing_ranges);

    /* And replace existing queue with new one */
    // free(rf->ranges_todo);
    rf.ranges_todo = nr;
    rf.rangessent -= rf.rangesdone;
    rf.rangesdone = 0;
    rf.nranges = existing_ranges;

    /* And append the new stuff */
    nr.push(...ranges);
    // memcpy(&nr[2 * existing_ranges], ranges, 2 * sizeof(*ranges) * nranges);
    rf.nranges += nranges;
}
