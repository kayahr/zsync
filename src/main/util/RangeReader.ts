/*
 * Copyright (C) 2022 Klaus Reimer <k@ailis.de>
 * See LICENSE.md for licensing information.
 */

import { IncomingMessage, request as httpRequest } from "node:http";
import { request as httpsRequest, RequestOptions } from "node:https";
import { env } from "node:process";

import { DataReader } from "@kayahr/datastream";

import { Notifier } from "./Notifier";

export class ResponseInputStream extends ReadableStream<Uint8Array> {
    private readonly queue: Buffer[] = [];
    private end: boolean = false;
    private readonly notifier = new Notifier();

    /**
     * Creates a new file input stream reading to the given file.
     *
     * @param filename  - The name of the file to read.
     * @param chunkSize - The size of the chunks to read from the file.
     */
    public constructor(response: IncomingMessage) {
        super({
            start: () => {
                response.on("data", (buffer: Buffer) => {
                    this.queue.push(buffer);
                    this.notifier.notify();
                });
                response.on("end", () => {
                    this.end = true;
                    this.notifier.notify();
                });
            },
            pull: async (controller: ReadableStreamDefaultController<Uint8Array>) => {
                while (true) {
                    const buffer = this.queue.shift();
                    if (buffer != null) {
                        controller.enqueue(buffer);
                        break;
                    } else if (this.end) {
                        controller.close();
                        break;
                    } else {
                        await this.notifier.wait();
                    }
                }
            }
        });
    }

    /**
     * Closes the stream.
     */
    public close(): void {
        this.end = true;
        while (this.queue.pop() != null) {
            // Do nothing
        }
    }
}

export interface Range {
    start: number;
    end: number;
}

export interface RangeData {
    offset: number;
    buffer: Uint8Array;
}

export class RangeReader implements AsyncIterable<RangeData> {
    private constructor(
        private readonly reader: DataReader,
        private readonly contentType: string,
        private readonly contentLength: number,
        private readonly contentOffset: number
    ) {}

    public static async create(url: string, ranges: Range[]): Promise<RangeReader> {
        const options: RequestOptions = {
            method: "GET",
            headers: {
                Range: `bytes=${ranges.map(range => `${range.start}-${range.end}`).join(",")}`
            },
            ca: env["CACERT"]
        };
        return new Promise<RangeReader>((resolve, reject) => {
            const request = url.startsWith("https:") ? httpsRequest : httpRequest;
            const req = request(url, options, res => {
                if (res.statusCode !== 206) {
                    reject(new Error(`Expected HTTP response status code 206 but got ${res.statusCode}`));
                } else {
                    let contentOffset = 0;
                    const contentRange = res.headers["content-range"];
                    if (contentRange != null) {
                        contentOffset = parseInt(contentRange.substring(6));
                    }
                    const stream = new ResponseInputStream(res);
                    const reader = new DataReader(stream.getReader());
                    resolve(new RangeReader(reader, res.headers["content-type"] ?? "application/octet-stream",
                        +(res.headers["content-length"] ?? "0"), contentOffset));
                }
            });
            req.on("error", reject);
            req.end();
        });
    }

    public async *[Symbol.asyncIterator](): AsyncIterator<RangeData> {
        while (true) {
            const range = await this.readRange();
            if (range == null) {
                break;
            }
            yield range;
        }
    }

    public async readRange(): Promise<RangeData | null> {
        if (this.contentType.startsWith("multipart/byteranges")) {
            let start = 0;
            let end = 0;
            while (true) {
                const boundary = await this.reader.readLine();
                if (boundary == null) {
                    return null;
                }
                if (boundary.startsWith("--")) {
                    break;
                }
            }
            while (true) {
                const line = await this.reader.readLine();
                if (line == null) {
                    return null;
                }
                if (line === "") {
                    break;
                }
                const match = /^Content-range: bytes (?<start>[0-9]+)-(?<end>[0-9]+)\/(?<total>[0-9]+)$/i.exec(line);
                if (match != null) {
                    start = +(match.groups?.["start"] ?? "0");
                    end = +(match.groups?.["end"] ?? "0");
                }
            }
            if (end === 0) {
                throw new Error("No range found");
            }
            const size = end - start + 1;
            const buffer = new Uint8Array(size);
            const read = await this.reader.readUint8Array(buffer);
            if (read < size) {
                return null;
            }
            return { offset: start, buffer };
        } else {
            const buffer = new Uint8Array(this.contentLength);
            const read = await this.reader.readUint8Array(buffer);
            if (read < this.contentLength) {
                return null;
            }
            return { offset: this.contentOffset, buffer };
        }
    }
}
