// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import { commands, ExtensionContext, workspace } from "vscode";
import * as book from "./bookUtil";
import { ReaderSyncService, SyncResult } from "./readerSync";

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
  const readerSync = new ReaderSyncService(context, books);
  books.onLocalProgressChange = () => void readerSync.markLocalChange().catch(console.error);

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

  const syncReader = async (showResult: boolean) => {
    const result = await readerSync.syncNow();
    if (result.changed) {
      setText(await books.getJumpingPage());
    }
    if (showResult) {
      const messages: Record<SyncResult["direction"], string> = {
        uploaded: "已将 VS Code 阅读进度同步到 Reader",
        downloaded: "已从 Reader 恢复阅读进度",
        unchanged: "两端阅读进度已一致",
      };
      vscode.window.showInformationMessage(messages[result.direction]);
    }
  };

  const pageSyncInterval = setInterval(() => {
    void books.syncPageIfChanged().catch(console.error);
    void readerSync
      .isConfigured()
      .then((configured) => {
        if (configured) {
          return syncReader(false);
        }
      })
      .catch(console.error);
  }, 10 * 60 * 1000);

  // 老板键
  let displayCode = commands.registerCommand("extension.displayCode", () => {
    textItem.hide();
    prevItem.hide();
  });

  // 下一页
  let getNextPage = commands.registerCommand("extension.getNextPage", async () => {
    setText(await books.getNextPage());
  });

  // 上一页
  let getPreviousPage = commands.registerCommand(
    "extension.getPreviousPage",
    async () => {
      setText(await books.getPreviousPage());
    },
  );

  // 跳转某个页面
  let getJumpingPage = commands.registerCommand(
    "extension.getJumpingPage",
    async () => {
      setText(await books.getJumpingPage());
    },
  );

  const readerLogin = commands.registerCommand("extension.readerLogin", async () => {
    try {
      if (await readerSync.login()) {
        await syncReader(false);
      }
    } catch (error) {
      vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
    }
  });

  const readerLogout = commands.registerCommand("extension.readerLogout", () => readerSync.logout());

  const readerSyncNow = commands.registerCommand("extension.readerSyncNow", async () => {
    try {
      await syncReader(true);
    } catch (error) {
      vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
    }
  });

  const pageConfigurationChange = workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration("thiefBook.currPageNumber")) {
      books.refreshPageFromConfiguration();
    }
  });

  context.subscriptions.push(displayCode);
  context.subscriptions.push(getNextPage);
  context.subscriptions.push(getPreviousPage);
  context.subscriptions.push(getJumpingPage);
  context.subscriptions.push(readerLogin);
  context.subscriptions.push(readerLogout);
  context.subscriptions.push(readerSyncNow);
  context.subscriptions.push(pageConfigurationChange);
  context.subscriptions.push({
    dispose: () => clearInterval(pageSyncInterval),
  });

  void readerSync
    .isConfigured()
    .then((configured) => {
      if (configured) {
        return syncReader(false);
      }
    })
    .catch(console.error);
}

// this method is called when your extension is deactivated
export function deactivate() {}
