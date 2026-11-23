// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import { commands, ExtensionContext, workspace } from "vscode";
import * as book from "./bookUtil";

import * as vscode from "vscode";

// this method is called when your extension is activated
// your extension is activated the very first time the command is executed
export function activate(context: ExtensionContext) {
  // Use the console to output diagnostic information (console.log) and errors (console.error)
  // This line of code will only be executed once when your extension is activated
  console.log('Congratulations, your extension "thief-book" is now active!');

  // The command has been defined in the package.json file
  // Now provide the implementation of the command with registerCommand
  // The commandId parameter must match the command field in package.json
  const textColor = () =>
    <string>workspace.getConfiguration().get("thiefBook.textColor");
  const books = new book.Book(context);
  const pageSyncInterval = setInterval(
    () => void books.syncPageIfChanged().catch(console.error),
    10 * 60 * 1000,
  );

  const textItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    3,
  );
  textItem.command = "extension.getNextPage";

  const prevItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    2,
  );
  prevItem.text = "⬆";
  prevItem.command = "extension.getPreviousPage";

  const setText = (text: string) => {
    textItem.text = text;
    textItem.color = textColor();
    textItem.show();
    prevItem.color = textColor();
    prevItem.show();
  };

  // 老板键
  let displayCode = commands.registerCommand("extension.displayCode", () => {
    textItem.hide();
    prevItem.hide();
  });

  // 下一页
  let getNextPage = commands.registerCommand("extension.getNextPage", () => {
    setText(books.getNextPage());
  });

  // 上一页
  let getPreviousPage = commands.registerCommand(
    "extension.getPreviousPage",
    () => {
      setText(books.getPreviousPage());
    },
  );

  // 跳转某个页面
  let getJumpingPage = commands.registerCommand(
    "extension.getJumpingPage",
    () => {
      setText(books.getJumpingPage());
    },
  );

  const pageConfigurationChange = workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration("thiefBook.currPageNumber")) {
      books.refreshPageFromConfiguration();
    }
  });

  context.subscriptions.push(displayCode);
  context.subscriptions.push(getNextPage);
  context.subscriptions.push(getPreviousPage);
  context.subscriptions.push(getJumpingPage);
  context.subscriptions.push(pageConfigurationChange);
  context.subscriptions.push({
    dispose: () => clearInterval(pageSyncInterval),
  });
}

// this method is called when your extension is deactivated
export function deactivate() {}
