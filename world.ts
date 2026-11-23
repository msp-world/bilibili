/**
 * B 站直播间 MSP World：
 * - 工具：bilibili_status, bilibili_stats
 * - 信号：bilibili.danmaku, bilibili.superchat, bilibili.superchat-del, bilibili.gift,
 *         bilibili.guard, bilibili.guard-renew, bilibili.enter-guard, bilibili.room,
 *         bilibili.block, bilibili.warning, bilibili.feed, bilibili.audience
 */
import type { MSPNode } from "../shared/msp.ts";
import { CoalescingBuffer } from "./coalescing-buffer.ts";
import { LiveClient, type BiliSocketLike, type FetchJson, type LiveStatus } from "./client.ts";
import { normalize, type LiveEvent } from "./normalize.ts";

export interface BilibiliConfig {
  roomId: number;
  sessdata?: string;
  giftFlushYuan?: number;
  coalesceWindowMs?: number;
  coalesceMaxItems?: number;
  audienceFlushMs?: number;
}

export interface BilibiliWorldOptions {
  config: BilibiliConfig;
  fetchJson?: FetchJson;
  createSocket?: (url: string) => BiliSocketLike;
}

export class BilibiliWorld {
  private readonly cfg: Required<BilibiliConfig>;
  private readonly client: LiveClient;
  private readonly buffer: CoalescingBuffer<LiveEvent>;
  private node: MSPNode | null = null;
  private counts = { enter: 0, like: 0, freeGift: 0 };
  private gauges: Record<string, number> = {};
  private audienceTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: BilibiliWorldOptions) {
    this.cfg = {
      roomId: options.config.roomId,
      sessdata: options.config.sessdata ?? "",
      giftFlushYuan: options.config.giftFlushYuan ?? 10,
      coalesceWindowMs: options.config.coalesceWindowMs ?? 300,
      coalesceMaxItems: options.config.coalesceMaxItems ?? 64,
      audienceFlushMs: options.config.audienceFlushMs ?? 15_000,
    };

    this.buffer = new CoalescingBuffer<LiveEvent>((groups) => {
      for (const group of groups) {
        this.emitGroup(group.items);
      }
    });

    this.client = new LiveClient({
      roomId: this.cfg.roomId,
      sessdata: this.cfg.sessdata,
      fetchJson: options.fetchJson,
      createSocket: options.createSocket,
      onCmd: (msg) => this.handleCmd(msg),
      onPopularity: (value) => {
        this.gauges.popularity = value;
      },
      onStatus: (status) => this.handleStatus(status),
    });
  }

  attach(node: MSPNode): void {
    this.node = node;
    const signals: [string, string][] = [
      ["bilibili.danmaku", "观众弹幕（带短窗同文归并）"],
      ["bilibili.superchat", "醒目留言 (SuperChat)"],
      ["bilibili.superchat-del", "醒目留言被删除"],
      ["bilibili.gift", "付费礼物（支持 V1 与 V2 Protobuf 解码）"],
      ["bilibili.guard", "开通大航海（舰长/提督/总督）"],
      ["bilibili.guard-renew", "大航海续费/上舰横幅"],
      ["bilibili.enter-guard", "舰长等大航海成员进场"],
      ["bilibili.room", "开播/下播/改标题/全员禁言"],
      ["bilibili.block", "房管禁言观众"],
      ["bilibili.warning", "超管警告/切断直播"],
      ["bilibili.feed", "直播间长连状态变化"],
      ["bilibili.audience", "进场/点赞/免费礼物计数与在线人数读数"],
    ];
    for (const [path, desc] of signals) node.declareSignal(path, desc);

    node.tool(
      "bilibili_status",
      "查询当前 B 站直播间连接状态、真实房间号、标题与登录态",
      () => this.client.current() as unknown as Record<string, unknown>,
      { type: "object", additionalProperties: false, properties: {} },
    );

    node.tool(
      "bilibili_stats",
      "查询当前归并缓冲区统计与累积的观众计数/在线读数",
      () => ({
        coalescing: this.buffer.stats(),
        counts: { ...this.counts },
        gauges: { ...this.gauges },
      }),
      { type: "object", additionalProperties: false, properties: {} },
    );
  }

  async start(): Promise<void> {
    if (this.cfg.audienceFlushMs > 0) {
      this.audienceTimer = setInterval(() => this.flushAudience(), this.cfg.audienceFlushMs);
      this.audienceTimer.unref?.();
    }
    await this.client.start();
  }

  stop(): void {
    if (this.audienceTimer) {
      clearInterval(this.audienceTimer);
      this.audienceTimer = null;
    }
    this.buffer.flush();
    this.flushAudience();
    this.client.stop();
  }

  private handleStatus(status: LiveStatus): void {
    this.node?.publish("bilibili.feed", {
      phase: status.phase,
      roomId: status.roomId,
      realRoomId: status.realRoomId,
      title: status.title,
      living: status.living,
      selfUid: status.selfUid,
      lastError: status.lastError,
    });
  }

  private handleCmd(msg: Record<string, unknown>): void {
    const item = normalize(msg, { giftFlushYuan: this.cfg.giftFlushYuan });
    if (!item) return;

    if (item.kind === "count") {
      this.counts[item.field] += item.by;
      return;
    }
    if (item.kind === "gauge") {
      this.gauges[item.field] = item.value;
      return;
    }

    if (item.trigger === "flush" || !item.coalesce) {
      this.buffer.flush();
      this.publishEvent(item);
      return;
    }

    if (item.coalesce.kind === "danmaku") {
      const uidKey = item.senderKey ?? "anon";
      this.buffer.add(`dm:${uidKey}:${item.coalesce.key}`, item, {
        windowMs: this.cfg.coalesceWindowMs,
        maxItems: this.cfg.coalesceMaxItems,
      });
    } else {
      const uidKey = item.senderKey ?? `anon-${Math.random()}`;
      this.buffer.add(`gift:${uidKey}:${item.coalesce.key}`, item, {
        windowMs: this.cfg.coalesceWindowMs,
        maxItems: this.cfg.coalesceMaxItems,
        runScope: "gift",
      });
    }
  }

  private emitGroup(items: readonly LiveEvent[]): void {
    if (items.length === 0) return;
    if (items.length === 1) {
      this.publishEvent(items[0]);
      return;
    }
    const first = items[0];
    if (first.coalesce?.kind === "danmaku") {
      const uname = String(first.meta?.uname ?? "观众");
      this.node?.publish(first.type, {
        text: `[弹幕×${items.length}|${uname}] ${first.coalesce.body}`,
        count: items.length,
        senderKey: first.senderKey ?? null,
        meta: first.meta ?? {},
      });
    } else if (first.coalesce?.kind === "gift") {
      const uname = String(first.meta?.uname ?? "观众");
      const totalNum = items.reduce((s, it) => s + (it.coalesce?.kind === "gift" ? it.coalesce.num : 1), 0);
      const totalYuan = items.reduce(
        (s, it) => s + (it.coalesce?.kind === "gift" && it.coalesce.yuan !== null ? it.coalesce.yuan : 0),
        0,
      );
      const hasYuan = first.coalesce.yuan !== null;
      this.node?.publish(first.type, {
        text: hasYuan
          ? `[礼物×${items.length}笔 ¥${Number.isInteger(totalYuan) ? totalYuan : totalYuan.toFixed(2)}|${uname}] ${first.coalesce.gift}×${totalNum}`
          : `[礼物×${items.length}笔|${uname}] ${first.coalesce.gift}×${totalNum}`,
        count: items.length,
        totalNum,
        ...(hasYuan ? { totalYuan } : {}),
        senderKey: first.senderKey ?? null,
        meta: first.meta ?? {},
      });
    } else {
      for (const it of items) this.publishEvent(it);
    }
  }

  private publishEvent(ev: LiveEvent): void {
    this.node?.publish(ev.type, {
      text: ev.text,
      senderKey: ev.senderKey ?? null,
      meta: ev.meta ?? {},
    });
  }

  flushAudience(): void {
    if (!this.node) return;
    const hasCounts = this.counts.enter > 0 || this.counts.like > 0 || this.counts.freeGift > 0;
    const hasGauges = Object.keys(this.gauges).length > 0;
    if (!hasCounts && !hasGauges) return;
    this.node.publish("bilibili.audience", {
      counts: { ...this.counts },
      gauges: { ...this.gauges },
    });
    this.counts = { enter: 0, like: 0, freeGift: 0 };
  }
}
