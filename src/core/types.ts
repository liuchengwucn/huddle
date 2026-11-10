export type Category = "ask" | "kb";
export type MsgType = "ask" | "followup" | "answer" | "clarify" | "decline" | "kb";
export type DeclineReason = "low_confidence" | "refused" | "timeout" | "error" | "rate_limited";
export type ResponderType = "answer" | "clarify" | "decline";

export interface Meta {
  type: MsgType;
  to?: string;          // ask only, required
  re?: string;          // answer/clarify/decline only, required
  reason?: DeclineReason; // decline only, required
  files?: string[];
  commit?: string;      // kb only
  source?: string;      // kb only
  supersedes?: string;  // kb only, number of the superseded card
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
  answerId: string | null;   // id of the comment marked as the answer
  updatedAt: Date;
  messages: Message[];       // messages[0] is the opening message
  viewerCanUpdate: boolean;
  viewerCanDelete: boolean;
}

export interface User {
  login: string;
}
