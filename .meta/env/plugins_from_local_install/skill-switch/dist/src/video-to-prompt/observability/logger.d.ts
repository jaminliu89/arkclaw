export interface VtpLogContext {
    rid?: string;
    phase?: string;
    span?: string;
}
export declare const vtpLog: {
    info(ctx: VtpLogContext | undefined, fields: Record<string, unknown>): void;
    warn(ctx: VtpLogContext | undefined, fields: Record<string, unknown>): void;
    error(ctx: VtpLogContext | undefined, fields: Record<string, unknown>): void;
    debug(ctx: VtpLogContext | undefined, fields: Record<string, unknown>): void;
};
//# sourceMappingURL=logger.d.ts.map