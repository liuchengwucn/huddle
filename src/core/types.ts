export type Category = "messages" | "cards";
export type MsgType = "message" | "reply" | "decline" | "card";
export type DeclineReason = "low_confidence" | "refused" | "timeout" | "error" | "rate_limited";
export type ResponderType = "reply" | "decline";

export interface Meta {
  type: MsgType;
  to?: string;            // opening message only, required there
  re?: string;            // reply/decline only, required
  reason?: DeclineReason; // decline only, required
}

export interface Message {
  id: string;          // platform id: the Discussion id for the opening message, the comment id for comments
  author: string;      // author login as returned by the platform
  createdAt: Date;
  body: string;        // body with the metadata line removed
  meta: Meta | null;   // null means a plain human comment or corrupted metadata
  url: string;
}

export interface Thread {
  id: string;
  number: number;
  url: string;
  title: string;
  category: Category;
  author: string;
  closed: boolean;
  updatedAt: Date;           // bumped by any activity, including comments
  editedAt: Date;            // last edit of the opening post, else its creation
  messages: Message[];       // messages[0] is the opening message
  viewerCanUpdate: boolean;
}

export interface User {
  login: string;
}
