/*
 * Copyright (C) 2023 Klaus Reimer <k@ailis.de>
 * See LICENSE.md for licensing information.
 */

import { env } from "node:process";

import { main } from "./zsync/client";

export interface ZSyncOptions {
    /**
     * Optional output file. Automatically determined from source URL and current working directory if not
     * specified.
     */
    output?: string;

    /**
     * Optional extra input files scanned to identify blocks in common with the target file and zsync uses any
     * blocks found.
     */
    inputs?: string[];

    /**
     * Optional CA certificate chain passed to Node TLS.
     */
    ca?: string;
}

/**
 * Syncs a file from a remote server.
 *
 * @param source  - The HTTPS URL pointing at the zsync file on the remote server.
 * @param options - Optional zsync options.
 */
export async function zsync(source: string, options: ZSyncOptions = {}): Promise<void> {
    const args: string[] = [];
    if (options.output != null) {
        args.push("-o", options.output);
    }
    if (options.inputs != null) {
        for (const input of options.inputs) {
            args.push("-i", input);
        }
    }
    env["CACERT"] = options.ca;
    await main([
        source,
        ...args
    ]);
}
