declare module "js-md4" {
    export interface Md4 {
        update(data: string | number[] | Uint8Array | ArrayBuffer): Md4;
        array(): number[];
        hex(): string;
    }
    export function create(): Md4;
}
