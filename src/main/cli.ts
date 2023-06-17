/*
 * Copyright (C) 2023 Klaus Reimer <k@ailis.de>
 * See LICENSE.md for licensing information.
 */

import "source-map-support/register";

import { zsync } from "./zsync";

void (async () => {
    await zsync(process.argv[2]);
})();
