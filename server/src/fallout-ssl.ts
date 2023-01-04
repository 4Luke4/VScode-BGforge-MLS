import { CompletionItemKind } from "vscode-languageserver";
import {
    conlog,
    ParseItemList,
    ParseResult,
    send_parse_result,
    is_subpath,
    is_directory,
    find_files,
    fullpath,
} from "./common";
import { connection, documents } from "./server";
import * as path from "path";
import { DynamicData } from "./common";
import { MarkupKind } from "vscode-languageserver/node";
import * as cp from "child_process";
import { SSLsettings } from "./settings";
import * as completion from "./completion";
import { HoverEx, HoverMap, HoverMapEx } from "./hover";
import * as hover from "./hover";
import * as fs from "fs";
import * as jsdoc from "./jsdoc";

interface HeaderDataList {
    macros: DefineList;
    procedures: ProcList;
}

interface ProcListItem {
    label: string;
    detail: string;
    jsdoc?: jsdoc.JSdoc;
}
interface ProcList extends Array<ProcListItem> {}
interface DefineListItem {
    label: string;
    detail: string;
    constant: boolean;
    multiline: boolean;
    firstline: string;
    jsdoc?: jsdoc.JSdoc;
}
interface DefineList extends Array<DefineListItem> {}

const lang_id = "fallout-ssl";
const ssl_ext = ".ssl";

export async function load_data(headersDirectory: string) {
    const completion_list: Array<completion.CompletionItemEx> = [];
    const hover_map = new Map<string, HoverEx>();
    const headers_list = find_files(headersDirectory, "h");

    for (const header_path of headers_list) {
        const text = fs.readFileSync(path.join(headersDirectory, header_path), "utf8");
        const header_data = find_symbols(text);
        load_macros(header_path, header_data, completion_list, hover_map);
        load_procedures(header_path, header_data, completion_list, hover_map);
    }
    const result: DynamicData = { completion: completion_list, hover: hover_map };
    return result;
}

function load_procedures(
    path: string,
    header_data: HeaderDataList,
    completion_list: completion.CompletionList,
    hover_map: HoverMap
) {
    for (const proc of header_data.procedures) {
        let markdown_value = [
            "```" + `${lang_id}`,
            `${proc.detail}`,
            "```",
            "\n```bgforge-mls-comment\n",
            `${path}`,
            "```",
        ].join("\n");
        if (proc.jsdoc) {
            const jsdmd = jsdocToMD(proc.jsdoc);
            markdown_value += jsdmd;
        }
        const markdown_contents = { kind: MarkupKind.Markdown, value: markdown_value };
        const completion_item = {
            label: proc.label,
            documentation: markdown_contents,
            source: path,
            kind: CompletionItemKind.Function,
        };
        completion_list.push(completion_item);
        const hover_item = { contents: markdown_contents, source: path };
        hover_map.set(proc.label, hover_item);
    }
}

function load_macros(
    path: string,
    header_data: HeaderDataList,
    completion_list: completion.CompletionList,
    hover_map: HoverMap
) {
    for (const macro of header_data.macros) {
        let markdown_value: string;
        let detail = macro.detail;
        // for a constant, show just value
        if (macro.constant) {
            detail = macro.firstline;
        }

        markdown_value = [
            "```" + `${lang_id}`,
            `${detail}`,
            "```",
            "\n```bgforge-mls-comment\n",
            `${path}`,
            "```",
        ].join("\n");
        // for single line ones, show full line too
        if (!macro.multiline && !macro.constant) {
            markdown_value += ["\n```" + `${lang_id}`, `${macro.firstline}`, "```"].join("\n");
        }
        let completion_kind;
        if (macro.constant) {
            completion_kind = CompletionItemKind.Constant;
        } else {
            // there's no good icon for macros, using something distinct from function
            completion_kind = CompletionItemKind.Field;
        }
        const markdown_contents = { kind: MarkupKind.Markdown, value: markdown_value };
        const completion_item = {
            label: macro.label,
            documentation: markdown_contents,
            source: path,
            kind: completion_kind,
            labelDetails: { description: path },
        };

        completion_list.push(completion_item);

        const hover_item = { contents: markdown_contents, source: path };
        hover_map.set(macro.label, hover_item);
    }
}

export function reload_data(
    path: string,
    text: string,
    completion: completion.CompletionListEx | undefined,
    hover: HoverMapEx | undefined
) {
    const symbols = find_symbols(text);
    if (completion == undefined) {
        completion = [];
    }
    const new_completion = completion.filter((item) => item.source != path);
    if (hover == undefined) {
        hover = new Map();
    }
    const new_hover = new Map(
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        Array.from(hover).filter(([key, value]) => {
            if (value.source != path) {
                return true;
            }
            return false;
        })
    );

    load_macros(path, symbols, new_completion, new_hover);
    load_procedures(path, symbols, new_completion, new_hover);
    const result: DynamicData = { completion: new_completion, hover: new_hover };
    conlog("reload data");
    return result;
}

function find_symbols(text: string) {
    // defines
    const define_list: DefineList = [];
    const define_regex =
        /((\/\*\*\s*\n([^*]|(\*(?!\/)))*\*\/)\r?\n)?#define[ \t]+(\w+)(?:\(([^)]+)\))?[ \t]+(.+)/gm;
    const constant_regex = /^[A-Z0-9_]+/;
    let match = define_regex.exec(text);
    while (match != null) {
        // This is necessary to avoid infinite loops with zero-width matches
        if (match.index === define_regex.lastIndex) {
            define_regex.lastIndex++;
        }

        const define_name = match[5];
        let define_firstline = match[7];
        define_firstline = define_firstline.trimEnd();

        // check if it's multiline
        let multiline = false;
        if (define_firstline.endsWith("\\")) {
            multiline = true;
        }

        // check if it has vars
        let define_detail = define_name;
        if (match[6]) {
            // function-like macro
            const define_vars = match[6];
            define_detail = `${define_name}(${define_vars})`;
        }

        // check if it's looks like a constant
        // a more elaborate analysis could catch more constants
        // this is deliberately simple to encourage better and more consistent code style
        let constant = false;
        if (!multiline && constant_regex.test(define_name)) {
            constant = true;
        }
        // if jsdoc found
        if (match[2]) {
            const jsd = jsdoc.parse(match[2]);
            define_detail = jsdocToDetail(define_name, jsd);
            const item = {
                label: define_name,
                constant: constant,
                detail: define_detail,
                multiline: multiline,
                firstline: define_firstline,
                jsdoc: jsd,
            };
            define_list.push(item);
        } else {
            const item = {
                label: define_name,
                constant: constant,
                detail: define_detail,
                multiline: multiline,
                firstline: define_firstline,
            };
            define_list.push(item);
        }
        match = define_regex.exec(text);
    }

    // procedures
    const proc_list: ProcList = [];
    // multiline jsdoc regex: (\/\*\*\s*\n([^*]|(\*(?!\/)))*\*\/)
    // from here https://stackoverflow.com/questions/35905181/regex-for-jsdoc-comments
    // procedure regex: procedure[\s]+(\w+)(?:\(([^)]+)\))?[\s]+begin
    const proc_regex =
        /((\/\*\*\s*\n([^*]|(\*(?!\/)))*\*\/)\r?\n)?procedure[\s]+(\w+)(?:\(([^)]+)\))?[\s]+begin/gm;
    match = proc_regex.exec(text);
    while (match != null) {
        // This is necessary to avoid infinite loops with zero-width matches
        if (match.index === proc_regex.lastIndex) {
            proc_regex.lastIndex++;
        }
        const proc_name = match[5];
        let proc_detail = proc_name;
        if (match[6]) {
            proc_detail = `procedure ${proc_name}(${match[6]})`;
        } else {
            proc_detail = `procedure ${proc_name}()`;
        }

        // if jsdoc found
        if (match[2]) {
            const jsd = jsdoc.parse(match[2]);
            proc_detail = jsdocToDetail(proc_name, jsd);
            const item = { label: proc_name, detail: proc_detail, jsdoc: jsd };
            proc_list.push(item);
        } else {
            const item = { label: proc_name, detail: proc_detail };
            proc_list.push(item);
        }
        match = proc_regex.exec(text);
    }

    const result: HeaderDataList = {
        macros: define_list,
        procedures: proc_list,
    };
    return result;
}

function jsdocToMD(jsd: jsdoc.JSdoc) {
    let md = "\n---\n";
    if (jsd.desc) {
        md += `\n${jsd.desc}`;
    }
    if (jsd.args.length > 0) {
        for (const arg of jsd.args) {
            md += `\n- \`${arg.type}\` ${arg.name}`;
        }
    }
    if (jsd.ret) {
        md += `\n\n Returns \`${jsd.ret.type}\``;
    }
    return md;
}

function jsdocToDetail(label: string, jsd: jsdoc.JSdoc) {
    const type = jsd.ret ? jsd.ret.type : "void";
    const args = jsd.args.map(({ type, name }) => `${type} ${name}`);
    const args_string = args.join(", ");
    const detail = `${type} ${label}(${args_string})`;
    return detail;
}

/** `text` looks like this
 *
 * `[Error] <Semantic> <my_script.ssl>:26:25: Unknown identifier qq.`
 * Numbers mean line:column
 */
function parse_compile_output(text: string, uri: string) {
    const text_document = documents.get(uri);
    const errors_pattern = /\[Error\] <(.+)>:([\d]*):([\d]*):? (.*)/g;
    const warnings_pattern = /\[Warning\] <(.+)>:([\d]*):([\d]*):? (.*)/g;
    const errors: ParseItemList = [];
    const warnings: ParseItemList = [];

    try {
        let match: RegExpExecArray;
        while ((match = errors_pattern.exec(text)) != null) {
            // This is necessary to avoid infinite loops with zero-width matches
            if (match.index === errors_pattern.lastIndex) {
                errors_pattern.lastIndex++;
            }
            let col: string;
            if (match[3] == "") {
                col = "1";
            } else {
                col = match[3];
            }
            errors.push({
                file: match[1],
                line: parseInt(match[2]),
                column_start: 0,
                column_end: parseInt(col) - 1,
                message: match[4],
            });
        }

        while ((match = warnings_pattern.exec(text)) != null) {
            // This is necessary to avoid infinite loops with zero-width matches
            if (match.index === warnings_pattern.lastIndex) {
                warnings_pattern.lastIndex++;
            }
            let col: string;
            if (match[3] == "") {
                col = "0";
            } else {
                col = match[3];
            }
            const line = parseInt(match[2]);
            const column_end = text_document.offsetAt({ line: line, character: 0 }) - 1;
            warnings.push({
                file: match[1],
                line: line,
                column_start: parseInt(col),
                column_end: column_end,
                message: match[4],
            });
        }
    } catch (err) {
        conlog(err);
    }
    const result: ParseResult = { errors: errors, warnings };
    return result;
}

function send_diagnostics(uri: string, output_text: string) {
    const parse_result = parse_compile_output(output_text, uri);
    send_parse_result(uri, parse_result);
}

export function compile(uri: string, ssl_settings: SSLsettings, interactive = false) {
    const filepath = fullpath(uri);
    const cwd_to = path.dirname(filepath);
    const base_name = path.parse(filepath).base;
    const base = path.parse(filepath).name;
    const compile_cmd = `${ssl_settings.compilePath} ${ssl_settings.compileOptions}`;
    const dst_path = path.join(ssl_settings.outputDirectory, base + ".int");
    const ext = path.parse(filepath).ext;

    if (ext.toLowerCase() != ssl_ext) {
        // vscode loses open file if clicked on console or elsewhere
        conlog("Not a Fallout SSL file! Please focus a Fallout SSL file to compile.");
        if (interactive) {
            connection.window.showInformationMessage("Please focus a Fallout SSL file to compile!");
        }
        return;
    }
    conlog(`compiling ${base_name}...`);

    cp.exec(
        compile_cmd + " " + base_name + " -o " + dst_path,
        { cwd: cwd_to },
        (err: cp.ExecException, stdout: string, stderr: string) => {
            conlog("stdout: " + stdout);
            if (stderr) {
                conlog("stderr: " + stderr);
            }
            if (err) {
                conlog("error: " + err.message);
                if (interactive) {
                    connection.window.showErrorMessage(`Failed to compile ${base_name}!`);
                }
            } else {
                if (interactive) {
                    connection.window.showInformationMessage(`Succesfully compiled ${base_name}.`);
                }
            }
            send_diagnostics(uri, stdout);
        }
    );
}

/** Loads Fallout header data from a directory outside of workspace, if specified in settings.
 * These files are not tracked for changes, and data is static.
 */
export async function load_external_headers(workspace_root: string, headers_dir: string) {
    conlog("loading external headers");

    try {
        if (!is_directory(headers_dir)) {
            conlog(`${headers_dir} is not a directory, skipping external headers.`);
            return;
        }
    } catch {
        conlog(`lstat ${headers_dir} failed, aborting.`);
        return;
    }
    if (is_subpath(workspace_root, headers_dir)) {
        conlog(`real ${headers_dir} is a subdirectory of workspace ${workspace_root}, aborting.`);
        return;
    }

    conlog(`loading external headers from ${headers_dir}`);
    const fallout_header_data = await load_data(headers_dir);
    const lang_id = "fallout-ssl";
    const old_completion = completion.staticData.get(lang_id);
    const old_hover = hover.staticData.get(lang_id);
    const new_completion = [...old_completion, ...fallout_header_data.completion];
    const new_hover = new Map([...old_hover, ...fallout_header_data.hover]);

    hover.staticData.set(lang_id, new_hover);
    completion.staticData.set(lang_id, new_completion);
    conlog(`loaded external headers from ${headers_dir}`);
}
