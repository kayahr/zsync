/*
 * Copyright (C) 2022 Klaus Reimer <k@ailis.de>
 * Copyright (C) 2004,2005,2007,2009 Colin Phipps <cph@moria.org.uk>
 * See LICENSE.md for licensing information.
 */

import { open, unlink } from "node:fs/promises";

import { file as tmpfile } from "tmp-promise";

import { rcksum_state } from "./internal";

/* rcksum_init(num_blocks, block_size, rsum_bytes, checksum_bytes, require_consecutive_matches)
 * Creates and returns an rcksum_state with the given properties
 */
export async function rcksum_init(nblocks: number, blocksize: number,
                                 rsum_bytes: number, checksum_bytes: number,
                                 require_consecutive_matches: number, tmpdir: string): Promise<rcksum_state | null> {
    /* Allocate memory for the object */
    const z = {} as rcksum_state;

    /* Enter supplied properties. */
    z.blocksize = blocksize;
    z.blocks = nblocks;
    z.rsum_a_mask = rsum_bytes < 3 ? 0 : rsum_bytes === 3 ? 0xff : 0xffff;
    z.rsum_bits = rsum_bytes * 8;
    z.checksum_bytes = checksum_bytes;
    z.seq_matches = require_consecutive_matches;

    /* require_consecutive_matches is 1 if true; and if true we need 1 block of
     * context to do block matching */
    z.context = blocksize * require_consecutive_matches;

    /* Initialise to 0 various state & stats */
    z.gotblocks = 0;
    z.stats = { checksummed: 0, hashhit: 0, stronghit: 0, weakhit: 0 };
    z.ranges = [];
    z.numranges = 0;
    z.r = [ { a: 0, b: 0 }, { a: 0, b: 0 } ];

    /* Hashes for looking up checksums are generated when needed.
     * So initially store NULL so we know there's nothing there yet.
     */
    z.rsum_hash = null;
    z.bithash = null;

    if ((z.blocksize & (z.blocksize - 1)) === 0 && z.blocks !== 0) {
        /* Create temporary file */
        const path = (await tmpfile({ template: "rcksum-XXXXXX", tmpdir })).path;
        z.filename = path;
        z.fd = await open(path, "w");
        /* Calculate bit-shift for blocksize */
        for (let i = 0; i < 32; i++) {
            if (z.blocksize === (1 << i)) {
                z.blockshift = i;
                break;
            }
        }

        z.blockhashes = [];
        for (let i = 0; i < z.blocks + z.seq_matches; i++) {
            z.blockhashes.push({
                checksum: null,
                next: null,
                r: { a: 0, b: 0 }
            });
        }
        return z;
    }
    return null;
}

/* rcksum_filename(self)
 * Returns temporary filename to caller as malloced string.
 * Ownership of the file passes to the caller - the function returns NULL if
 * called again, and it is up to the caller to deal with the file. */
export function rcksum_filename(rs: rcksum_state): string | null {
    const p = rs.filename;
    rs.filename = null;
    return p;
}

/* rcksum_end - destructor */
export async function rcksum_end(z: rcksum_state): Promise<void> {
    /* Free temporary file resources */
    if (z.fd != null) { await z.fd.close(); }
    if (z.filename != null) {
        await unlink(z.filename);
    }
}
