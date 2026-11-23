/**
 * `SEND_GIFT_V2` 的 protobuf 帧 → V1 的 JSON 字段形状。
 */
import { pbFromBase64, pbInt, pbSub, pbText, type PbField } from "./protobuf.ts";

export function giftFrameData(data: Record<string, unknown>): Record<string, unknown> {
  if (str(data.giftName) || str(data.gift_name)) return data;
  const top = pbFromBase64(data.pb);
  const gift = pbSub(top, 10);
  const giftName = pbText(gift, 2);
  if (!gift || !giftName) return data;

  const sender = pbSub(top, 15);
  const senderBase = pbSub(sender, 2);
  const uid = pbInt(top, 1) ?? pbInt(sender, 1);
  const uname = pbText(top, 2) || pbText(senderBase, 1);
  const face = pbText(top, 3) || pbText(senderBase, 2);
  const num = pbInt(gift, 3);
  const coinType = pbText(gift, 8);
  const totalCoin = coinTotal(gift);
  const giftId = pbInt(gift, 1);
  const tid = pbText(gift, 9);
  return {
    ...data,
    ...(uid !== undefined ? { uid } : {}),
    ...(uname ? { uname } : {}),
    giftName,
    ...(giftId !== undefined ? { giftId } : {}),
    ...(num !== undefined ? { num } : {}),
    ...(coinType ? { coin_type: coinType } : {}),
    ...(totalCoin !== undefined ? { total_coin: totalCoin } : {}),
    ...(tid ? { tid } : {}),
    sender_uinfo: senderUinfo(top, uid, uname, face),
  };
}

function senderUinfo(
  top: readonly PbField[] | null,
  uid: number | undefined,
  uname: string,
  face: string,
): Record<string, unknown> {
  const medal = pbSub(top, 8);
  const medalLevel = pbInt(medal, 5);
  const medalName = pbText(medal, 6);
  const hasMedal = medalLevel !== undefined || medalName !== "";
  return {
    ...(uid !== undefined ? { uid } : {}),
    base: {
      ...(uname ? { name: uname } : {}),
      ...(face ? { face } : {}),
    },
    ...(hasMedal
      ? {
          medal: {
            ...(medalLevel !== undefined ? { level: medalLevel } : {}),
            ...(medalName ? { name: medalName } : {}),
          },
        }
      : {}),
  };
}

function coinTotal(gift: readonly PbField[]): number | undefined {
  const slots = [5, 6, 7]
    .map((field) => pbInt(gift, field))
    .filter((value): value is number => value !== undefined && value > 0);
  if (slots.length === 0) return undefined;
  return Math.max(...slots);
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}
