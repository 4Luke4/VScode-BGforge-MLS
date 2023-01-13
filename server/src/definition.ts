import { Location } from "vscode-languageserver";

export interface Data extends Map<string, Location> {}

/** Intermediate result from parsing */
export interface DefinitionItem {
    name: string;
    line: number;
    start: number;
    end: number;
}
/** All intermediate results from a file */
export interface DefinitionList extends Array<DefinitionItem> {}

/** Take regex parse result list and turn it into a proper definition map */
export function load(uri: string, data: DefinitionList) {
    const definitions: Data = new Map();
    for (const def of data) {
        const range = {
            start: { line: def.line, character: def.start },
            end: { line: def.line, character: def.end },
        };
        const item = { uri: uri, range: range };
        definitions.set(def.name, item);
    }
    return definitions;
}
