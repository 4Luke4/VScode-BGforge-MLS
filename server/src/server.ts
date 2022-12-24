'use strict';

import {
	createConnection,
	TextDocuments,
	Diagnostic,
	ProposedFeatures,
	InitializeParams,
	DidChangeConfigurationNotification,
	CompletionItem,
	TextDocumentPositionParams,
	Hover,
	MarkupKind,
	SignatureHelp,
	TextDocumentSyncKind,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { URI } from 'vscode-uri';
import * as path from 'path';
import * as fallout_ssl from './fallout-ssl';
import * as weidu from './weidu';
import * as common from './common';
import { conlog } from './common';


// Create a connection for the server. The connection uses Node's IPC as a transport.
// Also include all preview / proposed LSP features.
export const connection = createConnection(ProposedFeatures.all);

// Create a simple text document manager. The text document manager
// supports full document sync only
export const documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);


let hasConfigurationCapability: boolean = false;
let hasWorkspaceFolderCapability: boolean = false;
let hasDiagnosticRelatedInformationCapability: boolean = false;

let completion_map = new Map<string, Array<any>>();
let signature_map = new Map<string, Array<any>>();
let hover_map = new Map<string, any>();

const completion_languages = ["weidu-tp2", "fallout-ssl"]
const hover_languages = ["weidu-tp2", "fallout-ssl"]

// for language KEY, hovers and completions are searched in VALUE map
const lang_data_map = new Map([
	["weidu-tp2", "weidu-tp2"],
	["weidu-tp2-tpl", "weidu-tp2"],

	["weidu-d", "weidu-d"],
	["weidu-d-tpl", "weidu-d"],

	["weidu-baf", "weidu-baf"],
	["weidu-baf-tpl", "weidu-baf"],
	["weidu-ssl", "weidu-baf"],
	["weidu-slb", "weidu-baf"],

	["fallout-ssl", "fallout-ssl"],
	["fallout-ssl-hover", "fallout-ssl"]
]);

const config_section = "bgforge";
const config_prefix = 'bgforge.';
const fallout_ssl_config = config_prefix + 'fallout-ssl';

connection.onInitialize((params: InitializeParams) => {
	let capabilities = params.capabilities;
	// Does the client support the `workspace/configuration` request?
	// If not, we will fall back using global settings
	hasConfigurationCapability =
		capabilities.workspace && !!capabilities.workspace.configuration;
	hasWorkspaceFolderCapability =
		capabilities.workspace && !!capabilities.workspace.workspaceFolders;
	hasDiagnosticRelatedInformationCapability =
		capabilities.textDocument &&
		capabilities.textDocument.publishDiagnostics &&
		capabilities.textDocument.publishDiagnostics.relatedInformation;

	return {
		capabilities: {
			textDocumentSync: TextDocumentSyncKind.Full,
			// Tell the client that the server supports code completion
			completionProvider: {
				resolveProvider: true,
			},
			hoverProvider: true,
			signatureHelpProvider: {
				"triggerCharacters": ['(']
			}
		}
	};
});

connection.onInitialized(() => {
	if (hasConfigurationCapability) {
		// Register for all configuration changes.
		connection.client.register(
			DidChangeConfigurationNotification.type,
			undefined
		);
	}
	if (hasWorkspaceFolderCapability) {
		connection.workspace.onDidChangeWorkspaceFolders(_event => {
			conlog('Workspace folder change event received.');
		});
	}

	// load data
	completion_map = load_completion();
	hover_map = load_hover();
	generate_signatures();
});

function generate_signatures() {
	const fallout_ssl_signature_list = fallout_ssl.get_signature_list(completion_map);
	signature_map.set("fallout-ssl", fallout_ssl_signature_list);
}

// The settings
interface SSLsettings {
	maxNumberOfProblems: number;
}

// The global settings, used when the `workspace/configuration` request is not supported by the client.
// Please note that this is not the case when using this server with the client provided in this example
// but could happen with other clients.
const defaultSettings: SSLsettings = { maxNumberOfProblems: 10 };
let globalSettings: SSLsettings = defaultSettings;

// Cache the settings of all open documents
let documentSettings: Map<string, Thenable<SSLsettings>> = new Map();

connection.onDidChangeConfiguration(change => {
	if (hasConfigurationCapability) {
		// Reset all cached document settings
		documentSettings.clear();
	} else {
		globalSettings = <SSLsettings>(
			(change.settings.bgforge || defaultSettings)
		);
	}

	// Revalidate all open text documents
	documents.all().forEach(validateTextDocument);
});

function get_data_lang(lang_id: string) {
	let data_lang = lang_data_map.get(lang_id);
	if (!data_lang) { data_lang = "c++" }
	return data_lang;
}

// Only keep settings for open documents
documents.onDidClose(e => {
	documentSettings.delete(e.document.uri);
});

// The content of a text document has changed. This event is emitted
// when the text document first opened or when its content has changed.
documents.onDidChangeContent(change => {
	validateTextDocument(change.document);

	const lang_id = documents.get(change.document.uri).languageId;
	switch (lang_id) {
		case 'fallout-ssl': {
			fallout_ssl.reload_defines(completion_map, signature_map, URI.parse(change.document.uri).fsPath, change.document.getText());
			break;
		}
	}
});

async function validateTextDocument(textDocument: TextDocument): Promise<void> {
	// In this simple example we get the settings for every validate run.
	const diagnostics: Diagnostic[] = [];
	// Send the computed diagnostics to VSCode.
	connection.sendDiagnostics({ uri: textDocument.uri, diagnostics });
}

connection.onDidChangeWatchedFiles(_change => {
	// Monitored files have change in VSCode
	conlog('We received an file change event');
});


// This handler provides the initial list of the completion items.
connection.onCompletion(
	(_textDocumentPosition: TextDocumentPositionParams): CompletionItem[] => {
		const lang_id = documents.get(_textDocumentPosition.textDocument.uri).languageId;
		let current_list: any;
		if (lang_id == "fallout-ssl") {
			current_list = fallout_ssl.filter_completion(completion_map.get(lang_id), _textDocumentPosition.textDocument.uri);
		} else {
			current_list = completion_map.get(lang_id);
		}
		return current_list;
	}
);

function load_completion() {
	const fs = require('fs');

	for (const lang_id of completion_languages) {
		try {
			const file_path = path.join(__dirname, `completion.${lang_id}.json`);
			const completion_list = JSON.parse(fs.readFileSync(file_path));
			completion_map.set(lang_id, completion_list);
		} catch (e) {
			conlog(e);
		}

		// //Fallout SSL: add completion from headers
		// connection.workspace.getConfiguration(fallout_ssl_config).then(function (conf: any) {
		// 	if (conf.headers_directory != "NONE") {
		// 		try {
		// 			let procdef_list = fallout_ssl.get_defines(conf.headers_directory);
		// 			fallout_ssl.load_defines(completion_map, signature_map, procdef_list);
		// 		} catch (e) {
		// 			conlog(e);
		// 		}
		// 	}
		// });

	}
	return completion_map;
};

function load_hover() {
	const fs = require('fs');

	for (const lang_id of hover_languages) {
		try {
			const file_path = path.join(__dirname, `hover.${lang_id}.json`);
			const hover_data = JSON.parse(fs.readFileSync(file_path));
			hover_map.set(lang_id, hover_data);
		} catch (e) {
			conlog(e);
		}
	}
	return hover_map;
};


// This handler resolve additional information for the item selected in
// the completion list.
connection.onCompletionResolve(
	(item: CompletionItem): CompletionItem => {
		return item;
	}
);

// Make the text document manager listen on the connection
// for open, change and close text document events
documents.listen(connection);

// Listen on the connection
connection.listen();


connection.onHover((textDocumentPosition: TextDocumentPositionParams): Hover => {
	const lang_id = documents.get(textDocumentPosition.textDocument.uri).languageId;
	const hover_lang_id = get_data_lang(lang_id);
	const hover_data = hover_map.get(hover_lang_id);
	if (!hover_data) { return; }

	const text = documents.get(textDocumentPosition.textDocument.uri).getText();
	const lines = text.split(/\r?\n/g);
	const position = textDocumentPosition.position;
	const filename = common.fname(textDocumentPosition.textDocument.uri);

	const str = lines[position.line];
	const pos = position.character;
	const word = common.get_word_at(str, pos);

	if (word) {
		const hover = hover_data[word];
		if (hover) { return hover; }

		// if (present.length > 0) {
		// 	const item = present[0];
		// 	if (item.detail || item.documentation) {
		// 		let markdown;
		// 		if (item.fulltext) {  // full text for defines
		// 			markdown = {
		// 				kind: MarkupKind.Markdown,
		// 				value: [
		// 					'```' + `${hover_lang}`,
		// 					item.fulltext,
		// 					'```',
		// 					item.documentation.value
		// 				].join('\n')
		// 			};
		// 		} else {
		// 			markdown = {
		// 				kind: MarkupKind.Markdown,
		// 				value: [
		// 					'```' + `${hover_lang}`,
		// 					item.detail,
		// 					'```',
		// 					item.documentation.value
		// 				].join('\n')
		// 			};
		// 		}
		// 		const hover = { contents: markdown };
		// 		return hover;
		// 	}
		// }
	}
});

connection.onSignatureHelp((textDocumentPosition: TextDocumentPositionParams): SignatureHelp => {
	const text = documents.get(textDocumentPosition.textDocument.uri).getText();
	const lines = text.split(/\r?\n/g);
	const position = textDocumentPosition.position;
	const str = lines[position.line];
	const pos = position.character;
	const word = common.get_signature_word(str, pos);
	const lang_id = documents.get(textDocumentPosition.textDocument.uri).languageId;
	const signature_list = signature_map.get(lang_id);
	if (signature_list && word) {
		const present = signature_list.filter(function (el: any) {
			return (el.label == word);
		});
		if (present.length > 0) {
			const sig = present[0];
			return { signatures: [{ label: sig.label, documentation: sig.documentation, parameters: [] }], activeSignature: 0, activeParameter: null };
		}
	}
});

connection.onExecuteCommand((params, cancel_token) => {
	const command = params.command;
	const args = params.arguments;
	const text_document = args[1];
	const lang_id = text_document.languageId;

	const scheme = text_document.uri.scheme;
	if (scheme != "file") {
		conlog("Focus a valid file to compile.");
		connection.window.showInformationMessage("Focus a valid file to compile!");
	}

	switch (command) {
		case "extension.bgforge.compile": {
			switch (lang_id) {
				case "fallout-ssl": {
					fallout_ssl.sslcompile(params, cancel_token);
					break;
				}
				case "weidu-tp2":
				case "weidu-tp2-tpl":
				case "weidu-baf":
				case "weidu-baf-tpl":
				case "weidu-d":
				case "weidu-d-tpl": {
					weidu.wcompile(params, cancel_token);
					break;
				}
				default: {
					connection.window.showInformationMessage("Focus a valid file to compile!");
					break;
				}
			}
		}
	}

});
