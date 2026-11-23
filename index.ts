/**
 * B 站直播间 MSP 节点启动入口。
 *
 * 环境变量：
 *   BILI_ROOM_ID     直播间号（必填，支持短号）
 *   BILI_SESSDATA    登录态 SESSDATA Cookie（可选，匿名可收弹幕但 uid=0）
 *   BILI_GIFT_FLUSH  礼物立即投递门槛（元，默认 10）
 */
import { MSPNode, installShutdownHooks, mspOptionsFromEnv } from "../shared/msp.ts";
import { BilibiliWorld } from "./world.ts";

export async function startBilibiliNode(): Promise<{ node: MSPNode; world: BilibiliWorld }> {
  const roomId = Number(process.env.BILI_ROOM_ID || 0);
  if (!Number.isInteger(roomId) || roomId <= 0) {
    throw new Error("请通过 BILI_ROOM_ID 指定有效的 B 站直播间号");
  }
  const node = new MSPNode(process.env.BILI_NODE_ID || "bilibili", mspOptionsFromEnv("BILI"));
  const world = new BilibiliWorld({
    config: {
      roomId,
      sessdata: process.env.BILI_SESSDATA || "",
      giftFlushYuan: process.env.BILI_GIFT_FLUSH ? Number(process.env.BILI_GIFT_FLUSH) : 10,
    },
  });

  world.attach(node);
  const ep = await node.start();
  await world.start();
  console.log(`[bilibili] MSP node "${node.nodeId}" (room ${roomId}) listening on ${ep.host}:${ep.port}`);
  return { node, world };
}

if (import.meta.main) {
  const { node, world } = await startBilibiliNode();
  installShutdownHooks(() => {
    world.stop();
    node.stop();
  });
}
