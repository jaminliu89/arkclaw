export type HandoffSource = "cua" | "bua";
export declare function markHandoffSource(sessionKey: string, source: HandoffSource, mtimeMs?: number): void;
export declare function getRecentHandoffSource(sessionKey: string): HandoffSource | null;
export declare function consumeRecentHandoffSource(sessionKey: string): HandoffSource | null;
export declare function _clearHandoffSourcesForTest(): void;
//# sourceMappingURL=handoff-source.d.ts.map