import { hashString } from "../util.js";

export type JournalCategory =
  | "TRADE"
  | "REJECTED_SETUP"
  | "ORDER"
  | "STOP_MOVEMENT"
  | "PARTIAL_CLOSE"
  | "SYSTEM_EVENT"
  | "RISK_EVENT"
  | "ERROR";

export interface JournalEntry {
  id: string;
  timestamp: number;
  symbol: string;
  category: JournalCategory;
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

export class Journal {
  private entries: JournalEntry[] = [];

  add(entry: Omit<JournalEntry, "id">): JournalEntry {
    const e: JournalEntry = {
      ...entry,
      id: `J-${hashString(`${entry.timestamp}:${entry.category}:${entry.symbol}:${entry.title}`)}`,
    };
    this.entries.push(e);
    if (this.entries.length > 20000) this.entries = this.entries.slice(-20000);
    return e;
  }

  getAll(): JournalEntry[] {
    return [...this.entries].reverse();
  }

  /**
   * Replace the journal with a persisted snapshot. Entries are stored newest
   * first by `getAll`, so the snapshot is reversed back into insertion order.
   */
  restore(entries: JournalEntry[]): void {
    this.entries = [...entries]
      .filter((e) => Number.isFinite(e.timestamp))
      .sort((a, b) => a.timestamp - b.timestamp)
      .slice(-20000);
  }

  filter(fn: (e: JournalEntry) => boolean): JournalEntry[] {
    return [...this.entries].reverse().filter(fn);
  }

  clear(): void {
    this.entries = [];
  }
}

export interface ActivityEvent {
  timestamp: number;
  kind: string;
  symbol: string;
  detail: string;
  level: "info" | "success" | "warning" | "danger";
}

export class ActivityFeed {
  private events: ActivityEvent[] = [];
  private listeners: Array<(ev: ActivityEvent) => void> = [];

  /** Subscribe to every new activity event (feeds the real-time stream). */
  onAdd(listener: (ev: ActivityEvent) => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  add(ev: Omit<ActivityEvent, "timestamp">): ActivityEvent {
    const e: ActivityEvent = { ...ev, timestamp: Date.now() };
    this.events.push(e);
    if (this.events.length > 5000) this.events = this.events.slice(-5000);
    for (const listener of this.listeners) listener(e);
    return e;
  }

  getAll(): ActivityEvent[] {
    return [...this.events].reverse();
  }

  /** Replace the feed with a persisted snapshot without notifying listeners. */
  restore(events: ActivityEvent[]): void {
    this.events = [...events]
      .filter((e) => Number.isFinite(e.timestamp))
      .sort((a, b) => a.timestamp - b.timestamp)
      .slice(-5000);
  }

  clear(): void {
    this.events = [];
  }
}
