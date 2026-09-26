function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("'", "&apos;")
    .replaceAll('"', "&quot;");
}

/** A deliberately small passive reply: it contains neither article data nor sender data. */
export function serializePassiveTextReply(input: {
  readonly toUserName: string;
  readonly fromUserName: string;
  readonly createTime: number;
  readonly content: string;
}): string {
  return `<xml><ToUserName>${escapeXml(input.toUserName)}</ToUserName><FromUserName>${escapeXml(input.fromUserName)}</FromUserName><CreateTime>${input.createTime}</CreateTime><MsgType>text</MsgType><Content>${escapeXml(input.content)}</Content></xml>`;
}

export function passiveResultText(resultUrl: string): string {
  return `已收下这篇文章。处理结果将在这里更新：${resultUrl}`;
}
