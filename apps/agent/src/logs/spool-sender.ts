import type { AttemptSpool, SpoolChunk } from '@rbo/executor';
import { iterUnacked } from '@rbo/executor';

export type SpoolSendFn = (chunk: {
  sequence: number;
  stream: 'stdout' | 'stderr';
  bytes: string;
}) => boolean;

export interface SpoolSenderOptions {
  /** Max in-memory pending send queue depth. */
  maxQueue: number;
  /** Attempt to send one chunk over the wire; return false if WS unavailable. */
  send: SpoolSendFn;
  /** Spool used for replay after reconnect. */
  getSpool: () => AttemptSpool;
}

/**
 * Bounded in-memory sender over a durable AttemptSpool.
 * Never blocks the job process: enqueue is O(1) and drops when the queue is full
 * (disk already holds the chunk; startReplay recovers).
 */
export class SpoolSender {
  private readonly queue: SpoolChunk[] = [];
  private lastAcked = 0;
  private pumping = false;
  private needsReplay = false;

  constructor(private readonly opts: SpoolSenderOptions) {}

  /** Highest contiguous sequence acknowledged by the Controller. */
  get lastAckedSequence(): number {
    return this.lastAcked;
  }

  /** True when the in-memory send queue is saturated and disk must carry backlog. */
  isUnderPressure(): boolean {
    return this.needsReplay || this.queue.length >= this.opts.maxQueue;
  }

  enqueue(chunk: SpoolChunk): void {
    if (chunk.sequence <= this.lastAcked) {
      return;
    }
    if (this.queue.some((c) => c.sequence === chunk.sequence)) {
      return;
    }
    if (this.queue.length >= this.opts.maxQueue) {
      // Memory-bound: leave on disk; replay when capacity frees.
      this.needsReplay = true;
      return;
    }
    this.queue.push(chunk);
    this.queue.sort((a, b) => a.sequence - b.sequence);
    this.pump();
  }

  onAck(sequence: number): void {
    if (sequence > this.lastAcked) {
      this.lastAcked = sequence;
    }
    while (this.queue.length > 0) {
      const head = this.queue[0];
      if (!head || head.sequence > this.lastAcked) {
        break;
      }
      this.queue.shift();
    }
    this.pump();
    if (this.needsReplay && this.queue.length < this.opts.maxQueue) {
      this.needsReplay = false;
      void this.startReplay();
    }
  }

  /** Seed ack cursor (e.g. from disk ack.json on open). */
  setAcked(sequence: number): void {
    this.lastAcked = Math.max(0, sequence);
  }

  /**
   * Enqueue all disk chunks with sequence > lastAcked.
   * Intended for reconnect (Task 3); also used when the send queue overflows.
   */
  async startReplay(): Promise<void> {
    const spool = this.opts.getSpool();
    for await (const chunk of iterUnacked(spool, this.lastAcked)) {
      this.enqueue(chunk);
    }
  }

  private pump(): void {
    if (this.pumping) {
      return;
    }
    this.pumping = true;
    try {
      while (this.queue.length > 0) {
        const chunk = this.queue[0];
        if (!chunk) {
          break;
        }
        if (chunk.sequence <= this.lastAcked) {
          this.queue.shift();
          continue;
        }
        const ok = this.opts.send({
          sequence: chunk.sequence,
          stream: chunk.stream,
          bytes: chunk.bytes,
        });
        if (!ok) {
          break;
        }
        // Sent — remove from memory; durable confirmation via onAck.
        this.queue.shift();
      }
    } finally {
      this.pumping = false;
    }
  }
}
