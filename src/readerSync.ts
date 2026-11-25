import * as http from "http";
import * as https from "https";
import { URL } from "url";
import { ConfigurationTarget, ExtensionContext, window, workspace } from "vscode";
import { Book } from "./bookUtil";
import { createLocalProgress, pageForReaderProgress } from "./readerSyncCore";

const SESSION_SECRET = "thiefBook.readerSession";
const LOCAL_UPDATED_PREFIX = "thiefBook.readerSync.localUpdatedAt:";

interface ReaderSession {
  user: { id: string; username: string };
  accessToken: string;
  accessTokenExpiresAt: number;
  refreshToken: string;
  refreshTokenExpiresAt: number;
}

interface StoredSession extends ReaderSession {
  serverUrl: string;
}

interface ReaderProgress {
  bookId: string;
  locator: string;
  percentage: number;
  chapterTitle: string;
  device: string;
  updatedAt: number;
}

export interface SyncResult {
  changed: boolean;
  direction: "uploaded" | "downloaded" | "unchanged";
}

class HttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

function normalizeServerUrl(value: string): string {
  const parsed = new URL(value.trim());
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Reader 地址必须使用 http 或 https");
  }
  return parsed.toString().replace(/\/$/, "");
}

function locatorSection(locator: string): string {
  const match = /^r1:[^:]+:(.+)$/.exec(locator);
  return match?.[1] ?? "";
}

export class ReaderSyncService {
  private session: StoredSession | null | undefined;

  constructor(
    private readonly context: ExtensionContext,
    private readonly book: Book,
  ) {}

  async markLocalChange(): Promise<void> {
    const filePath = workspace.getConfiguration().get<string>("thiefBook.filePath", "");
    if (!filePath) {
      return;
    }
    await this.context.globalState.update(`${LOCAL_UPDATED_PREFIX}${filePath}`, Date.now());
  }

  async login(): Promise<boolean> {
    const configured = workspace.getConfiguration().get<string>("thiefBook.readerServerUrl", "");
    const serverInput = await window.showInputBox({
      prompt: "Reader 服务地址",
      value: configured || "http://localhost:5888",
      ignoreFocusOut: true,
    });
    if (!serverInput) {
      return false;
    }

    let serverUrl: string;
    try {
      serverUrl = normalizeServerUrl(serverInput);
    } catch (error) {
      window.showErrorMessage(error instanceof Error ? error.message : String(error));
      return false;
    }

    const username = await window.showInputBox({ prompt: "Reader 用户名", ignoreFocusOut: true });
    if (!username) {
      return false;
    }
    const password = await window.showInputBox({
      prompt: "Reader 密码",
      password: true,
      ignoreFocusOut: true,
    });
    if (!password) {
      return false;
    }

    const session = await this.request<ReaderSession>(serverUrl, "POST", "/api/v1/auth/login", {
      username,
      password,
    });
    await workspace
      .getConfiguration()
      .update("thiefBook.readerServerUrl", serverUrl, ConfigurationTarget.Global);
    await this.saveSession({ ...session, serverUrl });
    window.showInformationMessage(`Reader 已登录：${session.user.username}`);
    return true;
  }

  async logout(): Promise<void> {
    const session = await this.loadSession();
    if (session) {
      await this.request(session.serverUrl, "POST", "/api/v1/auth/logout", {
        refreshToken: session.refreshToken,
      }).catch(() => undefined);
    }
    this.session = null;
    await this.context.secrets.delete(SESSION_SECRET);
    window.showInformationMessage("Reader 已退出登录");
  }

  async syncNow(): Promise<SyncResult> {
    const snapshot = this.book.getSyncSnapshot();
    if (!snapshot) {
      throw new Error("请先配置有效的 TXT 文件路径");
    }
    await this.requireSession();
    const local = createLocalProgress(snapshot);
    const key = `${LOCAL_UPDATED_PREFIX}${snapshot.filePath}`;
    let localUpdatedAt = this.context.globalState.get<number>(key);
    const response = await this.authenticatedRequest<{ progress: ReaderProgress | null }>(
      "GET",
      `/api/v1/sync/progress/${encodeURIComponent(local.bookId)}`,
    );
    const remote = response.progress;

    // Existing local reading must win on the first sync; otherwise enabling sync
    // would reset a long-read book to a fresh server record at page one.
    if (localUpdatedAt === undefined && snapshot.currentPage > 1) {
      localUpdatedAt = Date.now();
      await this.context.globalState.update(key, localUpdatedAt);
    }

    const sameTimestampDifferentSection =
      remote !== null &&
      localUpdatedAt !== undefined &&
      remote.updatedAt === localUpdatedAt &&
      locatorSection(remote.locator) !== "" &&
      locatorSection(remote.locator) !== locatorSection(local.locator);
    if (
      remote &&
      (localUpdatedAt === undefined || remote.updatedAt > localUpdatedAt || sameTimestampDifferentSection)
    ) {
      const remotePage = pageForReaderProgress(snapshot, remote.locator, remote.percentage);
      const changed = await this.book.applyRemotePage(remotePage);
      await this.context.globalState.update(key, remote.updatedAt);
      return { changed, direction: "downloaded" };
    }

    if (!remote || localUpdatedAt === undefined || localUpdatedAt > remote.updatedAt) {
      const updatedAt = localUpdatedAt ?? Date.now();
      const pushed = await this.authenticatedRequest<{ progress: ReaderProgress | null }>(
        "PUT",
        `/api/v1/sync/progress/${encodeURIComponent(local.bookId)}`,
        {
          locator: local.locator,
          percentage: local.percentage,
          chapterTitle: local.chapterTitle,
          device: "vscode",
          updatedAt,
        },
      );
      await this.context.globalState.update(key, pushed.progress?.updatedAt ?? updatedAt);
      return { changed: false, direction: "uploaded" };
    }

    return { changed: false, direction: "unchanged" };
  }

  async isConfigured(): Promise<boolean> {
    const serverUrl = workspace.getConfiguration().get<string>("thiefBook.readerServerUrl", "");
    return Boolean(serverUrl && (await this.loadSession()));
  }

  private async requireSession(): Promise<StoredSession> {
    const session = await this.loadSession();
    const configured = workspace.getConfiguration().get<string>("thiefBook.readerServerUrl", "");
    if (!session || !configured) {
      throw new Error("请先执行“Thief Book: 登录 Reader”");
    }
    if (normalizeServerUrl(configured) !== session.serverUrl) {
      throw new Error("Reader 服务地址已变化，请重新登录");
    }
    return session;
  }

  private async loadSession(): Promise<StoredSession | null> {
    if (this.session !== undefined) {
      return this.session;
    }
    const stored = await this.context.secrets.get(SESSION_SECRET);
    if (!stored) {
      return (this.session = null);
    }
    try {
      const parsed = JSON.parse(stored) as StoredSession;
      if (!parsed.accessToken || !parsed.refreshToken || !parsed.serverUrl) {
        throw new Error("invalid session");
      }
      return (this.session = parsed);
    } catch {
      await this.context.secrets.delete(SESSION_SECRET);
      return (this.session = null);
    }
  }

  private async saveSession(session: StoredSession): Promise<void> {
    this.session = session;
    await this.context.secrets.store(SESSION_SECRET, JSON.stringify(session));
  }

  private async authenticatedRequest<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    let current = await this.requireSession();
    if (current.accessTokenExpiresAt <= Date.now() + 60_000) {
      current = await this.refresh(current);
    }
    try {
      return await this.request<T>(current.serverUrl, method, path, body, current.accessToken);
    } catch (error) {
      if (!(error instanceof HttpError) || error.status !== 401) {
        throw error;
      }
      current = await this.refresh(current);
      return this.request<T>(current.serverUrl, method, path, body, current.accessToken);
    }
  }

  private async refresh(session: StoredSession): Promise<StoredSession> {
    const refreshed = await this.request<ReaderSession>(session.serverUrl, "POST", "/api/v1/auth/refresh", {
      refreshToken: session.refreshToken,
    });
    const stored = { ...refreshed, serverUrl: session.serverUrl };
    await this.saveSession(stored);
    return stored;
  }

  private request<T>(
    serverUrl: string,
    method: string,
    path: string,
    body?: unknown,
    accessToken?: string,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const target = new URL(path, `${serverUrl}/`);
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const headers: Record<string, string | number> = { accept: "application/json" };
      if (payload !== undefined) {
        headers["content-type"] = "application/json";
        headers["content-length"] = Buffer.byteLength(payload);
      }
      if (accessToken) { headers.authorization = `Bearer ${accessToken}`; }
      const transport = target.protocol === "https:" ? https : http;
      const request = transport.request(target, { method, headers }, (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer | string) =>
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)),
        );
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let parsed: any = {};
          if (text) {
            try {
              parsed = JSON.parse(text);
            } catch {
              reject(new Error(`Reader 返回了无法解析的响应（HTTP ${response.statusCode ?? 0}）`));
              return;
            }
          }
          const status = response.statusCode ?? 0;
          if (status < 200 || status >= 300) {
            reject(new HttpError(status, parsed?.error?.message || `Reader 请求失败（HTTP ${status}）`));
            return;
          }
          resolve(parsed as T);
        });
      });
      request.setTimeout(10_000, () => request.destroy(new Error("Reader 请求超时")));
      request.on("error", reject);
      if (payload !== undefined) {
        request.write(payload);
      }
      request.end();
    });
  }
}
