/*
 * Copyright (C) 2022 Klaus Reimer <k@ailis.de>
 * Copyright (C) 2004,2005,2007,2009 Colin Phipps <cph@moria.org.uk>
 * See LICENSE.md for licensing information.
 */

import { rename, truncate } from "node:fs/promises";

import { createHash } from "crypto";
import { open } from "fs/promises";

import { rcksum_add_target_block } from "./hash";
import { rcksum_state } from "./internal";
import { rcksum_blocks_todo, rcksum_needed_block_ranges } from "./range";
import { rcksum_submit_blocks, rcksum_submit_source_file, rsum } from "./rsum";
import { rcksum_end, rcksum_filename, rcksum_init } from "./state";
import { fgets, FILE, fread } from "./stdio";

const VERSION = "0.6.2";
const SHA1_DIGEST_LENGTH = 20;

export interface zsync_state {
    rs: rcksum_state | null;    /* rsync algorithm state, with block checksums and
                                 * holding the in-progress local version of the target */
    filelen: number;              /* Length of the target file */
    blocks: number;                 /* Number of blocks in the target */
    blocksize: number;           /* Blocksize */

    /* Checksum of the entire file, and checksum alg */
    checksum: string | null;
    checksum_method: string;

    /* URLs to uncompressed versions of the target */
    url: string[];
    nurl: number;

    cur_filename: string | null;         /* If we have taken the filename from rcksum, it is here */

    /* Hints for the output file, from the .zsync */
    filename: string;             /* The Filename: header */

    mtime: number;               /* MTime: from the .zsync, or -1 */
}

/** **************************************************************************
 *
 * zsync_receiver object definition and methods.
 * Stores the state for a currently-running download of blocks from a
 * particular URL or version of a file to complete a file using zsync.
 *
 * This is mostly a wrapper for the zsync_state which keeps various additional
 * state needed per-download: in particular the zlib stream object to
 * decompress the incoming data if this is a URL of a compressed version of the
 * target file.
 */
export interface zsync_receiver {
    zs: zsync_state;     /* The zsync_state that we are downloading for */
    url_type: 0;               /* Compressed or not */
    outbuf: Uint8Array;      /* Working buffer to keep incomplete blocks of data */
    outoffset: number;            /* and the position in that buffer */
}

/* Constructor */
export async function zsync_begin(f: FILE, tmpdir: string): Promise<zsync_state | null> {
    /* Defaults for the checksum bytes and sequential matches properties of the
     * rcksum_state. These are the defaults from versions of zsync before these
     * were variable. */
    let checksum_bytes = 16, rsum_bytes = 4, seq_matches = 1;

    /* Field names that we can ignore if present and not
     * understood. This allows new headers to be added without breaking
     * backwards compatibility, and conversely to add headers that do break
     * backwards compat and have old clients give meaningful errors. */
    let safelines: string | null = null;

    /* Allocate memory for the object */
    const zs: zsync_state = {
        url: [] as string[],
        nurl: 0
    } as zsync_state;

    /* Any non-zero defaults here. */
    zs.mtime = -1;

    while (true) {
        const buf = (await fgets(f)).trim();
        if (buf.length === 0) {
            break;
        }
        const separator = buf.indexOf(": ");
        if (separator !== -1) {
            const key = buf.substring(0, separator);
            const value = buf.substring(separator + 2);

            if (key === "zsync") {
                if (value === "0.0.4") {
                    throw new Error("This version of zsync is not compatible with zsync 0.0.4 streams");
                }
            } else if (key === "Min-Version") {
                // TODO This version check is just pathetic
                if (value > VERSION) {
                    throw new Error(`control file indicates that zsync-${value} or better is required`);
                }
            } else if (key === "Length") {
                zs.filelen = Number(value);
            } else if (key === "Filename") {
                zs.filename = value;
            } else if (key === "Z-Filename") {
                throw new Error("Z-Filename not supported");
            } else if (key === "URL") {
                zs.url.push(value);
                zs.nurl++;
            } else if (key === "Z-URL") {
                throw new Error("Z-URL not supported");
            } else if (key === "Blocksize") {
                const blocksize = Number(value);
                if (!(blocksize >= 0 && (blocksize & (blocksize - 1)) === 0)) {
                    throw new Error(`nonsensical blocksize ${blocksize}`);
                }
                zs.blocksize = blocksize;
            } else if (key === "Hash-Lengths") {
                const values = value.split(",").map(Number);
                if (values.length !== 3) {
                    throw new Error(`nonsensical hash lengths line ${value}`);
                }
                [ seq_matches, rsum_bytes, checksum_bytes ] = values;
                if (!(rsum_bytes >= 1 && rsum_bytes <= 4 && checksum_bytes >= 3 && checksum_bytes <= 16
                        && seq_matches >= 1 && seq_matches <= 2)) {
                    throw new Error(`nonsensical hash lengths line ${value}`);
                }
            } else if (zs.blocks > 0 && key === "Z-Map2") {
                throw new Error("Z-Map not supported");
            } else if (key === "SHA-1") {
                if (value.length !== SHA1_DIGEST_LENGTH * 2) {
                    throw new Error("SHA-1 digest from control file is wrong length.\n");
                } else {
                    zs.checksum = value;
                    zs.checksum_method = "SHA-1";
                }
            } else if (key === "Safe") {
                safelines = value;
            } else if (key === "Recompress") {
                throw new Error("Recompress not supported");
            } else if (key === "MTime") {
                zs.mtime = new Date(value).getTime();
            } else if (safelines == null || safelines.indexOf(key) === -1) {
                throw new Error(`unrecognised tag ${key} - you need a newer version of zsync.`);
            }
            if (zs.filelen > 0 && zs.blocksize > 0) {
                zs.blocks = Math.floor((zs.filelen + zs.blocksize - 1) / zs.blocksize);
            }
        } else {
            throw new Error(`Bad line - not a zsync file? "${buf}"`);
        }
    }
    if (!(zs.filelen > 0 && zs.blocksize > 0)) {
        throw new Error("Not a zsync file (looked for Blocksize and Length lines)\n");
    }
    if (await zsync_read_blocksums(zs, f, rsum_bytes, checksum_bytes, seq_matches, tmpdir) !== 0) {
        throw new Error("zsync_read_blocksums failed");
    }
    return zs;
}

/* zsync_read_blocksums(self, FILE*, rsum_bytes, checksum_bytes, seq_matches)
 * Called during construction only, this creates the rcksum_state that stores
 * the per-block checksums of the target file and holds the local working copy
 * of the in-progress target. And it populates the per-block checksums from the
 * given file handle, which must be reading from the .zsync at the start of the
 * checksums.
 * rsum_bytes, checksum_bytes, seq_matches are settings for the checksums,
 * passed through to the rcksum_state. */
async function zsync_read_blocksums(zs: zsync_state, f: FILE,
                                rsum_bytes: number, checksum_bytes: number,
                                seq_matches: number, tmpdir: string): Promise<number> {
    /* Make the rcksum_state first */
    if ((zs.rs = await rcksum_init(zs.blocks, zs.blocksize, rsum_bytes,
                               checksum_bytes, seq_matches, tmpdir)) == null) {
        return -1;
    }

    /* Now read in and store the checksums */
    let id = 0;
    for (; id < zs.blocks; id++) {
        const r: rsum = { a: 0, b: 0 };

        /* Read in */
        const buffer = new Uint16Array(2);
        const buffer2 = new Uint8Array(buffer.buffer);
        await fread(buffer2, 1, rsum_bytes, f, 4 - rsum_bytes);
        const checksum = new Uint8Array(checksum_bytes);
        await fread(checksum, 1, checksum_bytes, f);
        /* Convert to host endian and store */
        r.a = buffer[0];
        r.b = ((buffer[1] & 0xff00) >> 8) | ((buffer[1] & 0xff) << 8);
        rcksum_add_target_block(zs.rs, id, r, checksum);
    }
    return 0;
}

/* char* = zsync_filename(self)
 * Returns the suggested filename to be used for the final result of this
 * zsync.  Malloced string to be freed by the caller. */
export function zsync_filename(zs: zsync_state): string {
    return zs.filename;
}

/* zsync_submit_source_file(self, FILE*)
 * Read the given stream, applying the rsync rolling checksum algorithm to
 * identify any blocks of data in common with the target file. Blocks found are
 * written to our local copy of the target in progress.
 */
export async function zsync_submit_source_file(zs: zsync_state, f: FILE): Promise<void> {
    if (zs.rs == null) {
        throw new Error("rs is null");
    }
    await rcksum_submit_source_file(zs.rs, f);
}

function zsync_cur_filename(zs: zsync_state): string {
    if (zs.cur_filename == null) {
        if (zs.rs == null) {
            throw new Error("rs is null");
        }
        zs.cur_filename = rcksum_filename(zs.rs);
        if (zs.cur_filename == null) {
            throw new Error("cur_filename is null");
        }
    }
    return zs.cur_filename;
}

/* zsync_rename_file(self, filename)
 * Tell libzsync to move the local copy of the target (or under construction
 * target) to the given filename. */
export async function zsync_rename_file(zs: zsync_state, f: string): Promise<void> {
    const rf = zsync_cur_filename(zs);
    await rename(rf, f);
    zs.cur_filename = f;
}

/* zsync_get_urls(self, &num, &type)
 * Returns a (pointer to an) array of URLs (returning the number of them in
 * num) that are remote available copies of the target file (according to the
 * .zsync).
 * Note that these URLs could be for encoded versions of the target; a 'type'
 * is returned in *type which tells libzsync in later calls what version of the
 * target is being retrieved. */
export function zsync_get_urls(zs: zsync_state): string[] {
    const result = zs.url;
    if (zs.nurl !== result.length) {
        throw new Error("Length mismatch in urls");
    }
    return result;
}

/* zsync_status(self)
 * Returns  0 if we have no data in the target file yet.
 *          1 if we have some but not all
 *          2 or more if we have all.
 * The caller should not rely on exact values 2+; just test >= 2. Values >2 may
 * be used in later versions of libzsync. */
export function zsync_status(zs: zsync_state): number {
    if (zs.rs == null) {
        throw new Error("rs is null");
    }
    const todo = rcksum_blocks_todo(zs.rs);
    if (todo === zs.blocks) { return 0; }
    if (todo > 0) { return 1; }
    return 2;                   /* TODO: more? */
}

/* Constructor */
export function zsync_begin_receive(zs: zsync_state, url_type: 0): zsync_receiver {
    const zr: zsync_receiver = {
        zs,
        outbuf: new Uint8Array(zs.blocksize),
        url_type,
        outoffset: 0
    };
    return zr;
}

/* zsync_needed_byte_ranges(self, &num, type)
 * Returns an array of offsets (2*num of them) for the start and end of num
 * byte ranges in the given type of version of the target (type as returned by
 * a zsync_get_urls call), such that retrieving all these byte ranges would be
 * sufficient to obtain a complete copy of the target file.
 */
export function zsync_needed_byte_ranges(zs: zsync_state, type: 0): number[] | null {
    const byterange: number[] = [];

    if (zs.rs == null) {
        throw new Error("rs is null");
    }
    /* Request all needed block ranges */
    const blrange = rcksum_needed_block_ranges(zs.rs, 0, 0x7fffffff);
    const nrange = blrange.length >> 1;

    /* Allocate space for byte ranges */
    // byterange = malloc(2 * nrange * sizeof *byterange);
    // if (!byterange) {
    //     free(blrange);
    //     return NULL;
    // }

    /* Now convert blocks to bytes.
     * Note: Must cast one operand to off_t as both blocksize and blrange[x]
     * are int's whereas the product must be a file offfset. Needed so we don't
     * truncate file offsets to 32bits on 32bit platforms. */
    for (let i = 0; i < nrange; i++) {
        byterange[2 * i] = blrange[2 * i] * zs.blocksize;
        byterange[2 * i + 1] = blrange[2 * i + 1] * zs.blocksize - 1;
    }
    // free(blrange);      /* And release the blocks, we're done with them */

    switch (type) {
    case 0:
        // *num = nrange;
        return byterange;
    // case 1:
    //     {   /* Convert ranges in the uncompressed data to ranges in the compressed data */
    //         off_t *zbyterange =
    //             zmap_to_compressed_ranges(zs->zmap, byterange, nrange, &nrange);

    //         /* Store the number of compressed ranges and return them, freeing
    //          * the uncompressed ones now we've used them. */
    //         if (zbyterange) {
    //             *num = nrange;
    //         }
    //         free(byterange);
    //         return zbyterange;
    //     }
    default:
        // free(byterange);
        return null;
    }
}

/* zsync_submit_data(self, buf[], offset, blocks)
 * Passes data retrieved from the remote copy of
 * the target file to libzsync, to be written into our local copy. The data is
 * the given number of blocks at the given offset (must be block-aligned), data
 * in buf[].  */
async function zsync_submit_data(zs: zsync_state,
                             buf: Uint8Array, offset: number,
                             blocks: number): Promise<number> {
    if (zs.rs == null) {
        throw new Error("rs is null");
    }
    const blstart: number  = (offset / zs.blocksize) | 0;
    const blend: number = blstart + blocks - 1;

    return rcksum_submit_blocks(zs.rs, buf, blstart, blend);
}

/* zsync_receive_data_uncompressed(self, buf[], offset, buflen)
 * Adds the data in buf (buflen bytes) to this file at the given offset.
 * Returns 0 unless there's an error (e.g. the submitted data doesn't match the
 * expected checksum for the corresponding blocks)
 */
export async function zsync_receive_data(zr: zsync_receiver, buf: Uint8Array, offset: number, len: number):
        Promise<number> {
    let ret = 0;
    const blocksize: number = zr.zs.blocksize;

    if (0 !== (offset % blocksize)) {
        let x: number = len;

        if (x > blocksize - (offset % blocksize)) { x = blocksize - (offset % blocksize); }

        if (zr.outoffset === offset) {
            /* Half-way through a block, so let's try and complete it */
            if (len !== 0) {
                zr.outbuf.set(buf.subarray(0, x), offset % blocksize);
                // memcpy(zr->outbuf + offset % blocksize, buf, x);
            } else {
                // Pad with 0s to length.
                len = x = blocksize - (offset % blocksize);
                zr.outbuf.fill(0, offset % blocksize, offset % blocksize + len);
                // memset(zr->outbuf + offset % blocksize, 0, len = x =
                //        blocksize - (offset % blocksize));
            }

            if ((x + offset) % blocksize === 0) {
                if (await zsync_submit_data(zr.zs, zr.outbuf, zr.outoffset + x - blocksize, 1) !== 0) {
                    ret = 1;
                }
            }
        }
        buf = buf.subarray(x);
        len -= x;
        offset += x;
    }

    /* Now we are block-aligned */
    if (len >= blocksize) {
        let w: number = len / blocksize;

        if (await zsync_submit_data(zr.zs, buf, offset, w) !== 0) { ret = 1; }

        w *= blocksize;
        buf = buf.subarray(w);
        len -= w;
        offset += w;
    }
    /* Store incomplete block */
    if (len !== 0) {
        zr.outbuf.set(buf.subarray(0, len));
        // memcpy(zr->outbuf, buf, len);
        offset += len;          /* not needed: buf += len; len -= len; */
    }

    zr.outoffset = offset;
    return ret;
}

/* zsync_complete(self)
 * Finish a zsync download. Should be called once all blocks have been
 * retrieved successfully. This returns 0 if the file passes the final
 * whole-file checksum and if any recompression requested by the .zsync file is
 * done.
 * Returns -1 on error (and prints the error to stderr)
 *          0 if successful but no checksum verified
 *          1 if successful including checksum verified
 */
export async function zsync_complete(zs: zsync_state): Promise<number> {
    if (zs.rs == null) {
        throw new Error("rs is null");
    }
    let rc = 0;

    /* We've finished with the rsync algorithm. Take over the local copy from
     * librcksum and free our rcksum state. */
    // let fh = rcksum_filehandle(zs.rs!);
    const filename = zsync_cur_filename(zs);
    await rcksum_end(zs.rs);
    zs.rs = null;

    /* Truncate the file to the exact length (to remove any trailing NULs from
     * the last block); return to the start of the file ready to verify. */
    await truncate(filename, zs.filelen);

    // if (lseek(fh, 0, SEEK_SET) != 0) {
    //     perror("lseek");
    //     rc = -1;
    // }

    /* Do checksum check */
    if (rc === 0 && zs.checksum != null && (zs.checksum_method === "SHA-1")) {
        rc = await zsync_sha1(zs, filename);
    }

    // await fh?.close();

    /* Do any requested recompression */
    // if (rc >= 0 && zs.gzhead && zs.gzopts) {
    //     if (zsync_recompress(zs) != 0) {
    //         return -1;
    //     }
    // }
    return rc;
}

/* zsync_sha1(self, filedesc)
 * Given the currently-open-and-at-start-of-file complete local copy of the
 * target, read it and compare the SHA1 checksum with the one from the .zsync.
 * Returns -1 or 1 as per zsync_complete.
 */
async function zsync_sha1(zs: zsync_state, filename: string): Promise<number> {
    const size = 4096;
    const shasum = createHash("sha1");
    const buffer = new Uint8Array(size);
    let offset = 0;
    const fh = await open(filename, "r");
    try {
        while (true) {
            const { bytesRead } = await fh.read(buffer, 0, size, offset);
            if (bytesRead === 0) {
                break;
            }
            shasum.update(buffer.subarray(0, bytesRead));
            offset += bytesRead;
        }
    } finally {
        await fh.close();
    }
    return zs.checksum === shasum.digest("hex") ? 1 : -1;
}

/* time_t = zsync_mtime(self)
 * Returns the mtime on the original copy of the target; for the client program
 * to set the mtime of the local file to match, if it so chooses.
 * Or -1 if no mtime specified in the .zsync */
export function zsync_mtime(zs: zsync_state): number  {
    return zs.mtime;
}

/* Destructor */
export async function zsync_end(zs: zsync_state): Promise<string> {
    const f: string = zsync_cur_filename(zs);

    /* Free rcksum object and zmap */
    if (zs.rs != null) {
        await rcksum_end(zs.rs);
    }
    return f;
}
