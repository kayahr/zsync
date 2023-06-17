/*
 * Copyright (C) 2023 Klaus Reimer <k@ailis.de>
 * See LICENSE.md for licensing information.
 */

export class ZSyncError extends Error {
    public constructor(message: string) {
        super(message);
        this.name = this.constructor.name;
    }
}
