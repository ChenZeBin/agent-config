export interface WeChatCallbackQuery {
  readonly signature: string | null;
  readonly msgSignature: string | null;
  readonly timestamp: string | null;
  readonly nonce: string | null;
  readonly echoStr: string | null;
  readonly encryptType: "aes" | null;
}

export interface LinkMessage {
  readonly toUserName: string;
  readonly fromUserName: string;
  readonly createTime: number;
  readonly msgType: "link";
  readonly title: string;
  readonly description: string;
  readonly url: string;
  readonly msgId: string;
  readonly msgDataId: string | null;
  readonly idx: number | null;
}

export interface TextMessage {
  readonly toUserName: string;
  readonly fromUserName: string;
  readonly createTime: number;
  readonly msgType: "text";
  readonly content: string;
  readonly msgId: string;
}

export type ParsedInboundMessage =
  | { readonly kind: "link"; readonly message: LinkMessage }
  | { readonly kind: "text"; readonly message: TextMessage }
  | { readonly kind: "unsupported"; readonly msgType: string };
