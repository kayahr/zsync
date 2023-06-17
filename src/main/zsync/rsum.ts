/*
 * Copyright (C) 2022 Klaus Reimer <k@ailis.de>
 * Copyright (C) 2004,2005,2007,2009 Colin Phipps <cph@moria.org.uk>
 * See LICENSE.md for licensing information.
 */

import { create } from "js-md4";

import { build_hash, remove_block_from_hash } from "./hash";
import { BITHASHBITS, get_HE_blockid, hash_entry, rcksum_state } from "./internal";
import { add_to_ranges, next_known_block } from "./range";
import { feof, FILE, fread } from "./stdio";

export interface rsum {
    a: number;
    b: number;
}

/* rcksum_submit_source_file(self, stream)
 * Read the given stream, applying the rsync rolling checksum algorithm to
 * identify any blocks of data in common with the target file. Blocks found are
 * written to our working target output.
 */
export async function rcksum_submit_source_file(z: rcksum_state, f: FILE): Promise<void> {
    let in2 = 0;

    /* Allocate buffer of 16 blocks */
    const bufsize: number = z.blocksize * 16;
    const buf = new Uint8Array(bufsize + z.context);

    /* Build checksum hash tables ready to analyse the blocks we find */

    if (z.rsum_hash == null) {
        build_hash(z);
    }

    while (!await feof(f)) {
        let len = 0;
        const start_in: number = in2;

        if (in2 === 0) {
            /* If this is the start, fill the buffer for the first time */
            len = await fread(buf, 1, bufsize, f);
            in2 += len;
        } else {
            /* Else, move the last context bytes from the end of the buffer to the
               start, and refill the rest of the buffer from the stream. */
            // memcpy(buf, buf + (bufsize - z->context), z->context);
            buf.set(buf.subarray(bufsize - z.context, bufsize));
            len = z.context + await fread(buf, 1, bufsize - z.context, f, z.context);
            in2 += bufsize - z.context;
        }

        /* If either fread above failed, or EOFed */
        if (await feof(f)) {          /* 0 pad to complete a block */
            // memset(buf + len, 0, z->context);
            buf.fill(0, len, len + z.context);
            len += z.context;
        }

        /* Process the data in the buffer */
        await rcksum_submit_source_data(z, buf, len, start_in);
    }
}

/* rcksum_calc_rsum_block(data, data_len)
 * Calculate the rsum for a single block of data. */
export function rcksum_calc_rsum_block(data: Uint8Array, len: number): rsum {
    let a = 0;
    let b = 0;

    let i = 0;
    while (len !== 0) {
        const c = data[i++];
        a = (a + c) & 0xffff;
        b = (b + len * c) & 0xffff;
        len--;
    }
    return { a, b };
}

/* rcksum_calc_checksum(checksum_buf, data, data_len)
 * Returns the MD4 checksum (in checksum_buf) of the given data block */
export function rcksum_calc_checksum(data: Uint8Array): Uint8Array {
    const hash = create();
    hash.update(data);
    return new Uint8Array(hash.array());
}

/* write_blocks(rcksum_state, buf, startblock, endblock)
 * Writes the block range (inclusive) from the supplied buffer to our
 * under-construction output file */
export async function write_blocks(z: rcksum_state, data: Uint8Array, bfrom: number, bto: number):
        Promise<void> {
    if (z.fd == null) {
        throw new Error("No file handle");
    }
    let len: number = (bto - bfrom + 1) << z.blockshift;
    let offset: number = bfrom << z.blockshift;
    let datap = 0;

    while (len !== 0) {
        let l: number = len;

        /* On some platforms, the bytes-to-write could be more than pwrite(2)
         * will accept. Write in blocks of 2^31 bytes in that case. */
        if (l < len) { l = 0x8000000; }

        /* Write */
        const rc = (await z.fd.write(data, datap, l, offset)).bytesWritten;

        /* Keep track of any data still to do */
        len -= rc;
        if (len !== 0) {              /* More to write */
            datap += rc;
            offset += rc;
        }
    }

    {   /* Having written those blocks, discard them from the rsum hashes (as
         * we don't need to identify data for those blocks again, and this may
         * speed up lookups (in particular if there are lots of identical
         * blocks), and add the written blocks to the record of blocks that we
         * have received and stored the data for */
        let id: number;
        for (id = bfrom; id <= bto; id++) {
            remove_block_from_hash(z, id);
            add_to_ranges(z, id);
        }
    }
}


/* check_checksums_on_hash_chain(self, &hash_entry, data[], onlyone)
 * Given a hash table entry, check the data in this block against every entry
 * in the linked list for this hash entry, checking the checksums for this
 * block against those recorded in the hash entries.
 *
 * If we get a hit (checksums match a desired block), write the data to that
 * block in the target file and update our state accordingly to indicate that
 * we have got that block successfully.
 *
 * Return the number of blocks successfully obtained.
 */
async function check_checksums_on_hash_chain(z: rcksum_state,
                                         e: hash_entry,
                                         data: Uint8Array,
                                         onlyone: boolean): Promise<number> {
    const md4sum: Uint8Array[] = []; // [2][CHECKSUM_SIZE];
    let done_md4 = -1;
    let got_blocks = 0;
    const r: rsum = z.r[0];

    /* This is a hint to the caller that they should try matching the next
     * block against a particular hash entry (because at least z->seq_matches
     * prior blocks to it matched in sequence). Clear it here and set it below
     * if and when we get such a set of matches. */
    z.next_match = null;

    /* This is essentially a for (;e;e=e->next), but we want to remove links from
     * the list as we find matches, without keeping too many temp variables.
     */
    z.rover = e;
    while (z.rover != null) {
        e = z.rover;
        z.rover = onlyone ? null : e.next;

        /* Check weak checksum first */

        z.stats.hashhit++;
        if (e.r.a !== (r.a & z.rsum_a_mask) || e.r.b !== r.b) {
            continue;
        }

        const id = get_HE_blockid(z, e);

        if (!onlyone && z.seq_matches > 1
             && (z.blockhashes[id + 1].r.a !== (z.r[1].a & z.rsum_a_mask)
                || z.blockhashes[id + 1].r.b !== z.r[1].b)) {
            continue;
        }

        z.stats.weakhit++;

        {
            let ok = true;
            let check_md4 = 0;
            const next_known = -1;

            /* This block at least must match; we must match at least
             * z->seq_matches-1 others, which could either be trailing stuff,
             * or these could be preceding blocks that we have verified
             * already. */
            do {
                /* We only calculate the MD4 once we need it; but need not do so twice */
                if (check_md4 > done_md4) {
                    md4sum[check_md4] = rcksum_calc_checksum(
                                         data.subarray(z.blocksize * check_md4, z.blocksize * (check_md4 + 1)));
                    done_md4 = check_md4;
                    z.stats.checksummed++;
                }

                const areEqual = (first: Uint8Array, second: Uint8Array | null): boolean =>
                    second != null
                    && first.length === second.length && first.every((value, index) => value === second[index]);


                /* Now check the strong checksum for this block */
                if (areEqual(md4sum[check_md4], z.blockhashes[id + check_md4].checksum)) {
                    ok = false;
                } else if (next_known === -1) {
                    check_md4++;
                }
            } while (ok && !onlyone && check_md4 < z.seq_matches);

            if (ok) {
                let num_write_blocks: number;

                /* Find the next block that we already have data for. If this
                 * is part of a run of matches then we have this stored already
                 * as ->next_known. */
                const next_known: number = onlyone ? z.next_known : next_known_block(z, id);

                z.stats.stronghit += check_md4;

                if (next_known > id + check_md4) {
                    num_write_blocks = check_md4;

                    /* Save state for this run of matches */
                    z.next_match = z.blockhashes[id + check_md4];
                    if (!onlyone) { z.next_known = next_known; }
                } else {
                    /* We've reached the EOF, or data we already know. Just
                     * write out the blocks we don't know, and that's the end
                     * of this run of matches. */
                    num_write_blocks = next_known - id;
                }

                /* Write out the matched blocks that we don't yet know */
                await write_blocks(z, data, id, id + num_write_blocks - 1);
                got_blocks += num_write_blocks;
            }
        }
    }
    return got_blocks;
}

/* rcksum_submit_source_data(self, data, datalen, offset)
 * Reads the supplied data (length datalen) and identifies any contained blocks
 * of data that can be used to make up the target file.
 *
 * offset should be 0 for a new data stream (or if our position in the data
 * stream has been changed and does not match the last call) or should be the
 * offset in the whole source stream otherwise.
 *
 * Returns the number of blocks in the target file that we obtained as a result
 * of reading this buffer.
 *
 * IMPLEMENTATION:
 * We maintain the following state:
 * skip - the number of bytes to skip next time we enter rcksum_submit_source_data
 *        e.g. because we've just matched a block and the forward jump takes
 *        us past the end of the buffer
 * r[0] - rolling checksum of the first blocksize bytes of the buffer
 * r[1] - rolling checksum of the next blocksize bytes of the buffer (if seq_matches > 1)
 */
async function rcksum_submit_source_data(z: rcksum_state, data: Uint8Array,
                              len: number, offset: number): Promise<void> {
    if (z.rsum_hash == null) {
        throw new Error("rsum_hash is null");
    }
    /* The window in data[] currently being considered is
     * [x, x+bs)
     */
    let x = 0;
    const bs: number = z.blocksize;

    if (offset !== 0) {
        x = z.skip;
    } else {
        z.next_match = null;
    }

    if (x !== 0 || offset === 0) {
        z.r[0] = rcksum_calc_rsum_block(data.subarray(x), bs);
        if (z.seq_matches > 1) { z.r[1] = rcksum_calc_rsum_block(data.subarray(x + bs), bs); }
    }
    z.skip = 0;

    /* Work through the block until the current blocksize bytes being
     * considered, starting at x, is at the end of the buffer */
    for (;;) {
        if (x + z.context === len) {
            return;
        }
        {
            /* # of blocks of the output file we got from this data */
            let thismatch = 0;
            /* # of blocks to advance if thismatch > 0. Can be less than
             * thismatch as thismatch could be N*blocks_matched, if a block was
             * duplicated to multiple locations in the output file. */
            let blocks_matched = 0;

            /* If the previous block was a match, but we're looking for
             * sequential matches, then test this block against the block in
             * the target immediately after our previous hit. */
            if ((z.next_match != null) && z.seq_matches > 1) {
                if (0 !== (thismatch = await check_checksums_on_hash_chain(z, z.next_match, data.subarray(x), true))) {
                    blocks_matched = 1;
                }
            }
            if (thismatch === 0) {
                let e: hash_entry | null;

                /* Do a hash table lookup - first in the bithash (fast negative
                 * check) and then in the rsum hash */
                let hash: number = z.r[0].b;
                hash ^= ((((z.seq_matches > 1) ? z.r[1].b
                        : z.r[0].a & z.rsum_a_mask) << BITHASHBITS) >>> 0);
                if ((z.bithash != null) && (z.bithash[(hash & z.bithashmask) >> 3] & (1 << (hash & 7))) !== 0
                        && (e = z.rsum_hash[hash & z.hashmask]) != null) {
                    /* Okay, we have a hash hit. Follow the hash chain and
                     * check our block against all the entries. */
                    thismatch = await check_checksums_on_hash_chain(z, e, data.subarray(x), false);
                    if (thismatch !== 0) { blocks_matched = z.seq_matches; }
                }
            }

            /* If we got a hit, skip forward (if a block in the target matches
             * at x, it's highly unlikely to get a hit at x+1 as all the
             * target's blocks are multiples of the blocksize apart. */
            if (blocks_matched !== 0) {
                x += bs + (blocks_matched > 1 ? bs : 0);

                if (x + z.context > len) {
                    /* can't calculate rsum for block after this one, because
                     * it's not in the buffer. So leave a hint for next time so
                     * we know we need to recalculate */
                    z.skip = x + z.context - len;
                    return;
                }

                /* If we are moving forward just 1 block, we already have the
                 * following block rsum. If we are skipping both, then
                 * recalculate both */
                if (z.seq_matches > 1 && blocks_matched === 1) {
                    z.r[0] = z.r[1];
                }else {
                    z.r[0] = rcksum_calc_rsum_block(data.subarray(x), bs);
                }
                if (z.seq_matches > 1) {
                    z.r[1] = rcksum_calc_rsum_block(data.subarray(x + bs), bs);
                }
                continue;
            }
        }

        /* Else - advance the window by 1 byte - update the rolling checksum
         * and our offset in the buffer */
        {
            const Nc: number = data[x + bs * 2];
            const nc: number = data[x + bs];
            const oc: number = data[x];

            function unsignedChar(c: number): number {
                return c & 0xff;
            }

            // UPDATE_RSUM(z.r[0].a, z.r[0].b, oc, nc, z.blockshift);
            // #define UPDATE_RSUM(a, b, oldc, newc, bshift) do { (a) += ((unsigned char)(newc)) -
            // ((unsigned char)(oldc)); (b) += (a) - ((oldc) << (bshift)); } while (0)
            z.r[0].a = (z.r[0].a + (unsignedChar(nc) - unsignedChar(oc))) & 0xffff;
            z.r[0].b = (z.r[0].b + (z.r[0].a - (oc << z.blockshift))) & 0xffff;
            if (z.seq_matches > 1) {
                // UPDATE_RSUM(z.r[1].a, z.r[1].b, nc, Nc, z.blockshift);
                z.r[1].a = (z.r[1].a + (unsignedChar(Nc) - unsignedChar(nc))) & 0xffff;
                z.r[1].b = (z.r[1].b + (z.r[1].a - (nc << z.blockshift))) & 0xffff;
            }
        }
        x++;
    }
}

/* rcksum_submit_blocks(self, data, startblock, endblock)
 * The data in data[] (which should be (endblock - startblock + 1) * blocksize * bytes)
 * is tested block-by-block as valid data against the target checksums for
 * those blocks and, if valid, accepted and written to the working output.
 *
 * Use this when you have obtained data that you know corresponds to given
 * blocks in the output file (i.e. you've downloaded them from a real copy of
 * the target).
 */
export async function rcksum_submit_blocks(z: rcksum_state, data: Uint8Array,
                         bfrom: number, bto: number): Promise<number> {
    let x: number;
    let md4sum: Uint8Array; //    unsigned char md4sum[CHECKSUM_SIZE];

    /* Build checksum hash tables if we don't have them yet */
    if (z.rsum_hash == null) {
        build_hash(z);
    }

    /* Check each block */
    for (x = bfrom; x <= bto; x++) {
        md4sum = rcksum_calc_checksum(data.subarray((x - bfrom) << z.blockshift,
                             ((x - bfrom) << z.blockshift) + z.blocksize));
        // TODO Inefficient
        const a = JSON.stringify(md4sum.subarray(0, z.checksum_bytes));
        const b = JSON.stringify(z.blockhashes[x].checksum);
        if (a !== b) {
            if (x > bfrom) {     /* Write any good blocks we did get */
                await write_blocks(z, data, bfrom, x - 1);
            }
            return -1;
        }
    }

    /* All blocks are valid; write them and update our state */
    await write_blocks(z, data, bfrom, bto);
    return 0;
}
