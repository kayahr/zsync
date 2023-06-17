/*
 * Copyright (C) 2022 Klaus Reimer <k@ailis.de>
 * Copyright (C) 2004,2005,2007,2009 Colin Phipps <cph@moria.org.uk>
 * See LICENSE.md for licensing information.
 */

import { access, constants, link, rename, unlink, utimes } from "node:fs/promises";
import { dirname } from "node:path";

import getopt from "node-getopt";

import { Range, RangeData, RangeReader } from "../util/RangeReader";
import { http_get, range_fetch_addranges, range_fetch_start, referer, setReferer } from "./http";
import { fclose, FILE, fopen } from "./stdio";
import {
    zsync_begin, zsync_begin_receive, zsync_complete, zsync_end, zsync_filename, zsync_get_urls, zsync_mtime,
    zsync_needed_byte_ranges, zsync_receive_data, zsync_rename_file, zsync_state,
    zsync_status, zsync_submit_source_file
} from "./zsync";

/* read_seed_file(zsync, filename_str)
 * Reads the given file (decompressing it if appropriate) and applies the rsync
 * checksum algorithm to it, so any data that is contained in the target file
 * is written to the in-progress target. So use this function to supply local
 * source files which are believed to have data in common with the target.
 */
async function read_seed_file(z: zsync_state, fname: string): Promise<void> {
    const f = await fopen(fname, "r");
    try {
        /* Give the contents to libzsync to read, to find any content that
         * is part of the target file. */
        await zsync_submit_source_file(z, f);
    } finally {
        /* And close */
        await fclose(f);
    }
}

async function fetch_remaining_blocks_http(z: zsync_state, url: string, type: 0): Promise<number> {
    let ret = 0;
    let buf: Uint8Array;

    if (referer == null) {
        throw new Error("No referer set");
    }

    /* URL might be relative - we need an absolute URL to do a fetch */
    const u = new URL(url, referer).href;

    /* Start a range fetch and a zsync receiver */
    const rf = range_fetch_start(u);
    if (rf == null) {
        return -1;
    }
    const zr = zsync_begin_receive(z, type);

    {   /* Get a set of byte ranges that we need to complete the target */
        const zbyterange = zsync_needed_byte_ranges(z, type);
        if (zbyterange == null || zbyterange.length === 0) {
            return 0;
        }
        const nranges = zbyterange?.length >> 1;

        /* And give that to the range fetcher */
        range_fetch_addranges(rf, zbyterange, nranges);
    }

    {
        let len = 0;
        let zoffset = 0;

        const ranges: Range[] = [];
        for (let i = 0; i < rf.nranges; i++) {
            if (rf.ranges_todo == null) {
                throw new Error("ranges_todo is null");
            }
            ranges.push({
                start: rf.ranges_todo[i * 2],
                end: rf.ranges_todo[i * 2 + 1]
            });
        }

        const reader = await RangeReader.create(u, ranges);
        rf.rangessent = ranges.length;

        /* Loop while we're receiving data, until we're done or there is an error */
        let range: RangeData | null;
        while (ret !== 1 && (range = await reader.readRange()) != null) {
            zoffset = range.offset;
            buf = range.buffer;
            len = range.buffer.length;
            rf.rangesdone++;

            /* Pass received data to the zsync receiver, which writes it to the
             * appropriate location in the target file */
            if (await zsync_receive_data(zr, buf, zoffset, len) !== 0) {
                ret = 1;
            }

            // Needed in case next call returns len=0 and we need to signal where the EOF was.
            zoffset += len;
        }

        /* If error, we need to flag that to our caller */
        if (len < 0) {
            ret = -1;
        } else {
            /* Else, let the zsync receiver know that we're at EOF; there
             * could be data in its buffer that it can use or needs to process */
            await zsync_receive_data(zr, new Uint8Array(0), zoffset, 0);
        }
    }

    // /* Clean up */
    // free(buf);
    // http_down += range_fetch_bytes_down(rf);
    // zsync_end_receive(zr);
    // range_fetch_end(rf);
    // free(u);
    return ret;
}

/* fetch_remaining_blocks(zs)
 * Using the URLs in the supplied zsync state, downloads data to complete the
 * target file.
 */
async function fetch_remaining_blocks(zs: zsync_state): Promise<void> {
    const url = zsync_get_urls(zs);
    const n = url.length;
    const status: number[] = [];        /* keep status for each URL - 0 means no error */
    let ok_urls = n;

    if (url.length === 0) {
        throw new Error("no URLs available from zsync?");
    }

    /* Keep going until we're done or have no useful URLs left */
    while (zsync_status(zs) < 2 && ok_urls !== 0) {
        /* Still need data; pick a URL to use. */
        const try2 = Math.floor(Math.random() * n);

        if (status[try2] !== 0) {
            const tryurl = url[try2];

            /* Try fetching data from this URL */
            const rc = await fetch_remaining_blocks_http(zs, tryurl, 0 /* utype */);
            if (rc !== 0) {
                console.error(`failed to retrieve from ${tryurl}`);
                status[try2] = 1;
                ok_urls--;
            }
        }
    }
}

/* zs = read_zsync_control_file(location_str, filename)
 * Reads a zsync control file from either a URL or filename specified in
 * location_str. This is treated as a URL if no local file exists of that name
 * and it starts with a URL scheme ; only http URLs are supported.
 * Second parameter is a filename in which to locally save the content of the
 * .zsync _if it is retrieved from a URL_; can be NULL in which case no local
 * copy is made.
 */
async function read_zsync_control_file(p: string, fn: string | null, tmpdir: string): Promise<zsync_state> {
    let zs: zsync_state | null;

    /* Try opening as a local path */
    let f: FILE;
    try {
        f = await fopen(p, "r");
    } catch (e) {
        /* No such local file - if not a URL either, report error */
        if (p.indexOf(":") < 0) {
            throw e;
        }

        /* Try URL fetch */
        f = await http_get(p, fn, setReferer);
    }
    try {
        /* Read the .zsync */
        if ((zs = await zsync_begin(f, tmpdir)) == null) {
            throw new Error("zsync_begin failed");
        }
    } finally {
        /* And close it */
        await fclose(f);
    }
    return zs;
}

function isalnum(s: string, i: number): boolean {
    const c = s[i].toLowerCase();
    return (c >= "a" && c <= "z") || (c >= "0" && c >= "9");
}

/* str = get_filename_prefix(path_str)
 * Returns a (malloced) string of the alphanumeric leading segment of the
 * filename in the given file path.
 */
function get_filename_prefix(p: string): string {
    const s = p;
    const ti = s.lastIndexOf("/");
    let t = ti >= 0 ? s.substring(ti + 1) : null;
    if (t == null) { t = s; }
    let ui = 0;
    while (isalnum(t, ui)) {
        ui++;
    }
    return t.substring(0, ui);
}

/* filename_str = get_filename(zs, source_filename_str)
 * Returns a (malloced string with a) suitable filename for a zsync download,
 * using the given zsync state and source filename strings as hints. */
function get_filename(zs: zsync_state, source_name: string): string {
    const p = zsync_filename(zs);
    let filename: string | null = null;

    if (p != null) {
        if (p.indexOf("/") >= 0) {
            throw new Error(`Rejected filename specified in ${source_name}, contained path component`);
        } else {
            const t = get_filename_prefix(source_name);

            if (t !== "" && p.startsWith(t)) { filename = p; }

            if (t !== "" && filename == null) {
                throw new Error(
                    `Rejected filename specified in ${source_name} - prefix ${t} differed from filename ${p}.`);
            }
        }
    }
    if (filename == null) {
        filename = get_filename_prefix(source_name);
        if (filename == null) {
            filename = "zsync-download";
        }
    }
    return filename;
}

/** **************************************************************************
 *
 * Main program */
export async function main(argv: string[]): Promise<number> {
    let temp_file: string | null = null;
    const seedfiles: string[] = [];
    let nseedfiles = 0;
    let filename: string | null = null;
    let zfname: string | null = null;
    let outputdir = ".";

    const opts = getopt.create([
        [ "k", "=" ],
        [ "o", "=" ],
        [ "i", "=+" ],
        [ "u", "=" ]
    ]).bindHelp().parse(argv);
    for (const [ opt, optarg ] of Object.entries(opts.options)) {
        switch (opt) {
        case "k":
            zfname = optarg as string;
            break;
        case "o":
            filename = optarg as string;
            outputdir = dirname(filename);
            break;
        case "i":
            if (typeof optarg === "string") {
                seedfiles.push(optarg);
                nseedfiles++;
            } else if (optarg instanceof Array) {
                seedfiles.push(...optarg);
                nseedfiles += optarg.length;
            }
            break;
        case "u":
            setReferer(optarg as string);
            break;
        }
    }
    /* Last and only non-option parameter must be the path/URL of the .zsync */
    if (opts.argv.length < 1) {
        throw new Error("No .zsync file specified.\nUsage: zsync http://example.com/some/filename.zsync");
    } else if (opts.argv.length > 1) {
        throw new Error("Usage: zsync http://example.com/some/filename.zsync");
    }

    /* STEP 1: Read the zsync control file */
    const zs = await read_zsync_control_file(opts.argv[0], zfname, outputdir);

    // /* Get eventual filename for output, and filename to write to while working */
    if (filename == null) {
        filename = get_filename(zs, argv[0]);
    }
    temp_file = filename + ".part";

    {   /* STEP 2: read available local data and fill in what we know in the
         *target file */
        let i = 0;

        /* If the target file already exists, we're probably updating that file
         * - so it's a seed file */
        try {
            await access(filename, constants.R_OK);
            seedfiles.push(filename);
            nseedfiles++;
        } catch (e) {
            // Ignored
        }
        /* If the .part file exists, it's probably an interrupted earlier
         * effort; a normal HTTP client would 'resume' from where it got to,
         * but zsync can't (because we don't know this data corresponds to the
         * current version on the remote) and doesn't need to, because we can
         * treat it like any other local source of data. Use it now. */
        try {
            await access(temp_file, constants.R_OK);
            seedfiles.push(temp_file);
            nseedfiles++;
        } catch (e) {
            // Ignored
        }

        /* Try any seed files supplied by the command line */
        for (i = 0; i < nseedfiles; i++) {
            let dup = false;
            let j = 0;

            /* And stop reading seed files once the target is complete. */
            if (zsync_status(zs) >= 2) {
                break;
            }

            /* Skip dups automatically, to save the person running the program
             * having to worry about this stuff. */
            for (j = 0; j < i; j++) {
                if (seedfiles[i] === seedfiles[j]) {
                    dup = true;
                }
            }

            /* And now, if not a duplicate, read it */
            if (!dup) {
                await read_seed_file(zs, seedfiles[i]);
            }
        }
    }

    /* libzsync has been writing to a randomely-named temp file so far -
     * because we didn't want to overwrite the .part from previous runs. Now
     * we've read any previous .part, we can replace it with our new
     * in-progress run (which should be a superset of the old .part - unless
     * the content changed, in which case it still contains anything relevant
     * from the old .part). */
    await zsync_rename_file(zs, temp_file);

    /* STEP 3: fetch remaining blocks via the URLs from the .zsync */
    await fetch_remaining_blocks(zs);

    {   /* STEP 4: verify download */
        const r = await zsync_complete(zs);
        switch (r) {
            case -1:
                throw new Error(`Aborting, download available in ${temp_file}`);
            case 0:
                // no recognised checksum found
                break;
            case 1:
                // checksum matches OK
                break;
        }
    }

    // free(temp_file);

    /* Get any mtime that we is suggested to set for the file, and then shut
     * down the zsync_state as we are done on the file transfer. Getting the
     * current name of the file at the same time. */
    const mtime = zsync_mtime(zs);
    temp_file = await zsync_end(zs);

    /* STEP 5: Move completed .part file into place as the final target */
    if (filename !== "") {
        const oldfile_backup = filename + ".zs-old";
        let ok = true;

        let exists = false;
        try {
            await access(filename, constants.F_OK);
            exists = true;
        } catch(e) {
            exists = false;
        }

        if (exists) {
            /* Backup the old file. */
            /* First, remove any previous backup. We don't care if this fails -
                * the link below will catch any failure */
            try {
                await unlink(oldfile_backup);
            } catch (e) {
                // Ignored
            }

            /* Try linking the filename to the backup file name, so we will
                atomically replace the target file in the next step.
                If that fails due to EPERM, it is probably a filesystem that
                doesn't support hard-links - so try just renaming it to the
                backup filename. */
            try {
                await link(filename, oldfile_backup);
            } catch (e) {
                try {
                    await rename(filename, oldfile_backup);
                } catch (e) {
                    console.error(`Unable to back up old file ${filename} - completed download left in ${temp_file}`);
                    ok = false;
                }
            }
        }
        if (ok) {
            /* Rename the file to the desired name */
            await rename(temp_file, filename);
            /* final, final thing - set the mtime on the file if we have one */
            if (mtime !== -1) {
                const date = new Date(mtime);
                const timestamp = date.getTime() / 1000 + date.getTimezoneOffset() * 60;
                await utimes(filename, Date.now() / 1000, timestamp);
            }
        }
    } else {
        console.log(`No filename specified for download - completed download left in ${temp_file}`);
    }

    return 0;
}
