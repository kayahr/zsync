/*
 * Copyright (C) 2022 Klaus Reimer <k@ailis.de>
 * Copyright (C) 2004,2005,2007,2009 Colin Phipps <cph@moria.org.uk>
 * See LICENSE.md for licensing information.
 */

import { rcksum_state } from "./internal";

/* r = range_before_block(self, x)
 * This determines which of the existing known ranges x falls in.
 * It returns -1 if it is inside an existing range (it doesn't tell you which
 *  one; if you already have it, that usually is enough to know).
 * Or it returns 0 if x is before the 1st range;
 * 1 if it is between ranges 1 and 2 (array indexes 0 and 1)
 * ...
 * numranges if it is after the last range
 */
function range_before_block(rs: rcksum_state, x: number): number {
    /* Lowest number and highest number block that it could be inside (0 based) */
    let min = 0;
    let max: number = rs.numranges - 1;

    /* By bisection */
    for (; min <= max;) {
        /* Range number to compare against */
        const r: number = (max + min) >> 1;

        if (x > rs.ranges[2 * r + 1]) {
            /* After range r */
            min = r + 1;
        } else if (x < rs.ranges[2 * r]) {
            /* Before range r */
            max = r - 1;
        } else {
            /* In range r */
            return -1;
        }
    }

    /* If we reach here, we know min = max + 1 and we were below range max+1
     * and above range min-1.
     * So we're between range max and max + 1
     * So we return max + 1  (return value is 1 based)  ( = min )
     */
    return min;
}

/* next_blockid = next_known_block(rs, blockid)
 * Returns the blockid of the next block which we already have data for.
 * If we know the requested block, it returns the blockid given; otherwise it
 * will return a later blockid.
 * If no later blocks are known, it returns rs->numblocks (i.e. the block after
 * the end of the file).
 */
export function next_known_block(rs: rcksum_state, x: number): number {
    const r: number = range_before_block(rs, x);
    if (r === -1) {
        return x;
    }
    if (r === rs.numranges) {
        return rs.blocks;
    }
    /* Else return first block of next known range. */
    return rs.ranges[2 * r];
}

/* add_to_ranges(rs, blockid)
 * Mark the given blockid as known, updating the stored known ranges
 * appropriately */
export function add_to_ranges(rs: rcksum_state, x: number): void {
    const r: number = range_before_block(rs, x);

    if (r === -1) {
        /* Already have this block */
    } else {
        rs.gotblocks++;

        if (r > 0 && r < rs.numranges
            /* If between two ranges and exactly filling the hole between them, merge them */
            && rs.ranges[2 * (r - 1) + 1] === x - 1
            && rs.ranges[2 * r] === x + 1) {
            // This block fills the gap between two areas that we have got completely. Merge the adjacent ranges
            rs.ranges[2 * (r - 1) + 1] = rs.ranges[2 * r + 1];
            // memmove(&rs.ranges[2 * r], &rs.ranges[2 * r + 2],
            //         (rs.numranges - r - 1) * sizeof(rs.ranges[0]) * 2);
            rs.ranges.splice(2 * r, 2);
            rs.numranges--;
        } else if (r > 0 && rs.numranges !== 0 && rs.ranges[2 * (r - 1) + 1] === x - 1) {
            /* If adjoining a range below, add to it */
            rs.ranges[2 * (r - 1) + 1] = x;
        } else if (r < rs.numranges && rs.ranges[2 * r] === x + 1) {
            /* If adjoining a range above, add to it */
            rs.ranges[2 * r] = x;
        } else {
            /* New range for this block alone */
            // rs.ranges =
            //     realloc(rs->ranges,
            //             (rs->numranges + 1) * 2 * sizeof(rs->ranges[0]));
            // memmove(&rs->ranges[2 * r + 2], &rs->ranges[2 * r],
            //         (rs->numranges - r) * 2 * sizeof(rs->ranges[0]));
            rs.ranges.splice(2 * r, 0, x, x);
            // rs.ranges[2 * r] = rs.ranges[2 * r + 1] = x;
            rs.numranges++;
        }
    }
}

/* rcksum_blocks_todo
 * Return the number of blocks still needed to complete the target file */
export function rcksum_blocks_todo(rs: rcksum_state): number {
    let i: number;
    let n: number = rs.blocks;
    for (i = 0; i < rs.numranges; i++) {
        n -= 1 + rs.ranges[2 * i + 1] - rs.ranges[2 * i];
    }
    return n;
}

/* rcksum_needed_block_ranges
 * Return the block ranges needed to complete the target file */
export function rcksum_needed_block_ranges(rs: rcksum_state, from: number, to: number): number[] {
    let i: number;
    let n: number;
    const alloc_n = 100;
    const r: number[] = [];

    if (to >= rs.blocks) { to = rs.blocks; }
    r[0] = from;
    r[1] = to;
    n = 1;
    /* Note r[2*n-1] is the last range in our prospective list */

    for (i = 0; i < rs.numranges; i++) {
        if (rs.ranges[2 * i] > r[2 * n - 1]) { continue; }
        if (rs.ranges[2 * i + 1] < from) { continue; }

        /* Okay, they intersect */
        if (n === 1 && rs.ranges[2 * i] <= from) {       /* Overlaps the start of our window */
            r[0] = rs.ranges[2 * i + 1] + 1;
        } else {
            /* If the last block that we still (which is the last window end -1, due
             * to half-openness) then this range just cuts the end of our window */
            if (rs.ranges[2 * i + 1] >= r[2 * n - 1] - 1) {
                r[2 * n - 1] = rs.ranges[2 * i];
            } else {
                /* In the middle of our range, split it */
                r[2 * n] = rs.ranges[2 * i + 1] + 1;
                r[2 * n + 1] = r[2 * n - 1];
                r[2 * n - 1] = rs.ranges[2 * i];
                n++;
                if (n === alloc_n) {
                    // Should be unnecessary in JS
                    // zs_blockid *r2;
                    // alloc_n += 100;
                    // r2 = realloc(r, 2 * alloc_n * sizeof *r);
                    // if (!r2) {
                    //     free(r);
                    //     return NULL;
                    // }
                    // r = r2;
                }
            }
        }
    }
    // Should be unnecessary in JS
    // r = realloc(r, 2 * n * sizeof *r);
    if (n === 1 && r[0] >= r[1]) { n = 0; }

    // *num = n;
    return r;
}
