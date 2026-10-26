// Offline punches. A punch is saved on the device first, then sent. If the bar
// Wi-Fi is down, it waits in the queue and is retried when the connection
// comes back. The server accepts each punch id once, so retrying never makes
// duplicates. This is the fix for 7shifts' "my punch disappeared" complaints.

import type { PunchType } from "./hours";

export type QueuedPunch = {
  id: string;
  staffId: string;
  type: PunchType;
  clientTime: string;
  pin: string;
  receiptCode: string;
};

export type KeyValueStore = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

type Send = (p: QueuedPunch) => Promise<"saved" | "rejected" | "failed">;

const KEY = "rondo.punchQueue";

export class PunchQueue {
  constructor(
    private store: KeyValueStore,
    private send: Send,
  ) {}

  pending(): QueuedPunch[] {
    try {
      return JSON.parse(this.store.getItem(KEY) ?? "[]");
    } catch {
      return [];
    }
  }

  private save(items: QueuedPunch[]) {
    this.store.setItem(KEY, JSON.stringify(items));
  }

  add(p: QueuedPunch) {
    this.save([...this.pending(), p]);
  }

  // Sends queued punches oldest first. Stops at the first network failure so
  // order is kept; "rejected" (server said no, e.g. unknown staff) is dropped
  // from the queue and reported so the screen can tell the person.
  async flush(): Promise<{ sent: number; rejected: QueuedPunch[]; remaining: number }> {
    let sent = 0;
    const rejected: QueuedPunch[] = [];
    for (const p of this.pending()) {
      const result = await this.send(p);
      if (result === "failed") break;
      this.save(this.pending().filter((q) => q.id !== p.id));
      if (result === "saved") sent++;
      else rejected.push(p);
    }
    return { sent, rejected, remaining: this.pending().length };
  }
}
