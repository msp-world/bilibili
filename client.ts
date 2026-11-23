/**
 * B 站直播间长连客户端（Web 弹幕协议，只读，零第三方依赖）：
 *   1. `finger/spi` 取 buvid3
 *   2. `x/web-interface/nav` 取 WBI 密钥与登录 uid
 *   3. `Room/get_info` 取真实房间号与当前开播状态
 *   4. `getDanmuInfo` (WBI 签名) 取 wss 弹幕服务器与 token
 *   5. 原生 WebSocket 长连 + 认证包 + 30s 心跳 + 退避重连
 */
import { createHash } from "node:crypto";
import { encodePacket, OP, parseFrame } from "./wire.ts";

export const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

const HEARTBEAT_MS = 30_000;
const BACKOFF_MIN_MS = 2_000;
const BACKOFF_MAX_MS = 60_000;
const BOOTSTRAP_TIMEOUT_MS = 15_000;

const MIXIN_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29,
  28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25,
  54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
];

export type LivePhase = "stopped" | "connecting" | "connected" | "retrying";

export interface LiveStatus {
  phase: LivePhase;
  roomId: number;
  realRoomId: number | null;
  title: string;
  living: boolean;
  selfUid: number;
  lastError: string | null;
}

export interface BiliSocketLike {
  binaryType?: string;
  send(data: string | Uint8Array | ArrayBuffer): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: string, listener: (event: any) => void): void;
}

export type FetchJson = <T = unknown>(url: string, init?: RequestInit) => Promise<T>;

export interface LiveClientOptions {
  roomId: number;
  sessdata?: string;
  onCmd: (msg: Record<string, unknown>) => void;
  onStatus?: (status: LiveStatus) => void;
  onPopularity?: (value: number) => void;
  fetchJson?: FetchJson;
  createSocket?: (url: string) => BiliSocketLike;
}

export function wbiSign(params: Record<string, string | number>, imgKey: string, subKey: string): string {
  const raw = imgKey + subKey;
  const mixin = MIXIN_TAB.map((i) => raw[i] ?? "").join("").slice(0, 32);
  const wts = Math.floor(Date.now() / 1000);
  const all: Record<string, string> = {};
  for (const [k, v] of Object.entries({ ...params, wts })) {
    all[k] = String(v).replace(/[!'()*]/g, "");
  }
  const query = Object.keys(all)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(all[k])}`)
    .join("&");
  const w_rid = createHash("md5").update(query + mixin).digest("hex");
  return `${query}&w_rid=${w_rid}`;
}

export class LiveClient {
  private readonly opts: LiveClientOptions;
  private readonly fetchJson: FetchJson;
  private ws: BiliSocketLike | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private backoff = BACKOFF_MIN_MS;
  private stopped = true;
  private status: LiveStatus;

  constructor(opts: LiveClientOptions) {
    this.opts = opts;
    this.fetchJson =
      opts.fetchJson ??
      (async <T = unknown>(url: string, init?: RequestInit): Promise<T> => {
        const res = await fetch(url, { ...init, signal: AbortSignal.timeout(BOOTSTRAP_TIMEOUT_MS) });
        if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
        return (await res.json()) as T;
      });
    this.status = {
      phase: "stopped",
      roomId: opts.roomId,
      realRoomId: null,
      title: "",
      living: false,
      selfUid: 0,
      lastError: null,
    };
  }

  current(): LiveStatus {
    return { ...this.status };
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      try {
        ws.close(1000, "stopped");
      } catch {
        /* ignore */
      }
    }
    this.updateStatus({ phase: "stopped" });
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    this.updateStatus({ phase: "connecting", lastError: null });
    try {
      const headers: Record<string, string> = {
        "User-Agent": UA,
        Referer: `https://live.bilibili.com/${this.opts.roomId}`,
      };
      if (this.opts.sessdata) {
        headers.Cookie = `SESSDATA=${this.opts.sessdata}`;
      }

      const spi = await this.fetchJson<any>("https://api.bilibili.com/x/frontend/finger/spi", { headers });
      const buvid3 = String(spi?.data?.b_3 ?? "");

      const nav = await this.fetchJson<any>("https://api.bilibili.com/x/web-interface/nav", { headers });
      const navData = nav?.data ?? {};
      const selfUid = Number(navData.mid ?? 0) || 0;
      const imgKey = extractKey(String(navData?.wbi_img?.img_url ?? ""));
      const subKey = extractKey(String(navData?.wbi_img?.sub_url ?? ""));

      const info = await this.fetchJson<any>(
        `https://api.live.bilibili.com/room/v1/Room/get_info?room_id=${this.opts.roomId}`,
        { headers },
      );
      const roomData = info?.data ?? {};
      const realRoomId = Number(roomData.room_id ?? this.opts.roomId);
      const title = String(roomData.title ?? "");
      const living = Number(roomData.live_status ?? 0) === 1;

      const danmuQuery = imgKey && subKey
        ? wbiSign({ id: realRoomId, type: 0 }, imgKey, subKey)
        : `id=${realRoomId}&type=0`;
      const danmu = await this.fetchJson<any>(
        `https://api.live.bilibili.com/xlive/web-interface/v1/index/getDanmuInfo?${danmuQuery}`,
        { headers },
      );
      const token = String(danmu?.data?.token ?? "");
      const hostInfo = danmu?.data?.host_list?.[0];
      const wssUrl = hostInfo
        ? `wss://${hostInfo.host}:${hostInfo.wss_port ?? 443}/sub`
        : "wss://broadcastlv.chat.bilibili.com:443/sub";

      this.updateStatus({ realRoomId, title, living, selfUid });
      if (this.stopped) return;

      const ws = (this.opts.createSocket ?? defaultCreateSocket)(wssUrl);
      ws.binaryType = "arraybuffer";
      this.ws = ws;

      ws.addEventListener("open", () => {
        ws.send(
          encodePacket(
            OP.AUTH,
            JSON.stringify({
              uid: selfUid,
              roomid: realRoomId,
              protover: 3,
              buvid: buvid3,
              platform: "web",
              type: 2,
              key: token,
            }),
          ),
        );
      });

      ws.addEventListener("message", (event: any) => {
        void this.handleMessage(event.data);
      });

      ws.addEventListener("close", () => {
        if (this.ws === ws) this.ws = null;
        this.clearHeartbeat();
        if (!this.stopped) this.scheduleReconnect("WebSocket closed");
      });

      ws.addEventListener("error", () => {
        /* close handles reconnect */
      });
    } catch (err) {
      this.scheduleReconnect(err instanceof Error ? err.message : String(err));
    }
  }

  private async handleMessage(raw: unknown): Promise<void> {
    let buf: Buffer;
    if (Buffer.isBuffer(raw)) buf = raw;
    else if (raw instanceof ArrayBuffer) buf = Buffer.from(raw);
    else if (ArrayBuffer.isView(raw)) buf = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
    else if (typeof Blob !== "undefined" && raw instanceof Blob) buf = Buffer.from(await raw.arrayBuffer());
    else return;

    for (const frame of parseFrame(buf)) {
      if (frame.kind === "auth") {
        if (frame.code === 0) {
          this.backoff = BACKOFF_MIN_MS;
          this.updateStatus({ phase: "connected", lastError: null });
          this.startHeartbeat();
        } else {
          this.ws?.close(4001, `auth code ${frame.code}`);
        }
      } else if (frame.kind === "popularity") {
        this.opts.onPopularity?.(frame.value);
      } else if (frame.kind === "cmd") {
        this.opts.onCmd(frame.msg);
      }
    }
  }

  private startHeartbeat(): void {
    this.clearHeartbeat();
    this.heartbeat = setInterval(() => {
      try {
        this.ws?.send(encodePacket(OP.HEARTBEAT, ""));
      } catch {
        /* ignore */
      }
    }, HEARTBEAT_MS);
    this.heartbeat.unref?.();
  }

  private clearHeartbeat(): void {
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
  }

  private scheduleReconnect(reason: string): void {
    if (this.stopped || this.retry) return;
    this.updateStatus({ phase: "retrying", lastError: reason });
    const delay = this.backoff;
    this.backoff = Math.min(BACKOFF_MAX_MS, this.backoff * 2);
    this.retry = setTimeout(() => {
      this.retry = null;
      if (!this.stopped) void this.connect();
    }, delay);
    this.retry.unref?.();
  }

  private clearTimers(): void {
    this.clearHeartbeat();
    if (this.retry) {
      clearTimeout(this.retry);
      this.retry = null;
    }
  }

  private updateStatus(patch: Partial<LiveStatus>): void {
    this.status = { ...this.status, ...patch };
    this.opts.onStatus?.(this.current());
  }
}

function extractKey(url: string): string {
  const slash = url.lastIndexOf("/");
  const dot = url.lastIndexOf(".");
  if (slash < 0 || dot <= slash) return "";
  return url.slice(slash + 1, dot);
}

function defaultCreateSocket(url: string): BiliSocketLike {
  return new WebSocket(url) as unknown as BiliSocketLike;
}
