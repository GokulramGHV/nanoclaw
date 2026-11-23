import type { CardRecord, CardStore } from 'slack-ui-kit';

import { getDb } from '../../../db/connection.js';

interface KitCardRow {
  record_json: string;
}

function metaString(meta: Record<string, unknown> | undefined, key: string): string | null {
  const v = meta?.[key];
  return typeof v === 'string' && v !== '' ? v : null;
}

/**
 * The kit's `CardStore` over the central database. `put` is a compare-and-set:
 * insert only when absent, or update only while the stored version still equals
 * the one the caller read. Host columns are copied from `card.meta`.
 */
export class KitCardStore implements CardStore {
  async get(channel: string, ts: string): Promise<CardRecord | undefined> {
    const row = await getDb().get<KitCardRow>(
      'SELECT record_json FROM ui_kit_cards WHERE channel_id = ? AND message_ts = ?',
      channel,
      ts,
    );
    return row ? (JSON.parse(row.record_json) as CardRecord) : undefined;
  }

  async put(card: CardRecord, expectedVersion: number | null): Promise<boolean> {
    const now = new Date().toISOString();
    const json = JSON.stringify(card);
    if (expectedVersion === null) {
      const kind = metaString(card.meta, 'kind') === 'ask' ? 'ask' : 'card';
      const res = await getDb().run(
        `INSERT INTO ui_kit_cards (
           channel_id, message_ts, card_id, agent_group_id, session_id, instance, kind,
           template_name, record_json, version, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT DO NOTHING`,
        card.channel,
        card.ts,
        metaString(card.meta, 'cardId'),
        metaString(card.meta, 'agentGroupId') ?? '',
        metaString(card.meta, 'sessionId') ?? '',
        metaString(card.meta, 'instance') ?? '',
        kind,
        metaString(card.meta, 'template'),
        json,
        card.version,
        card.createdAt || now,
        now,
      );
      return res.changes === 1;
    }
    const res = await getDb().run(
      `UPDATE ui_kit_cards SET record_json = ?, version = ?, updated_at = ?
       WHERE channel_id = ? AND message_ts = ? AND version = ?`,
      json,
      card.version,
      now,
      card.channel,
      card.ts,
      expectedVersion,
    );
    return res.changes === 1;
  }
}

/**
 * Open (unlocked) ask cards of one session that answer the same inbound message, oldest first.
 * The lock lives in the stored record, so rows are filtered after the query.
 */
export async function listOpenAskCards(sessionId: string, inReplyTo: string): Promise<CardRecord[]> {
  const rows = await getDb().all<KitCardRow>(
    "SELECT record_json FROM ui_kit_cards WHERE kind = 'ask' AND session_id = ? ORDER BY created_at",
    sessionId,
  );
  return rows
    .map((r) => JSON.parse(r.record_json) as CardRecord)
    .filter((c) => !c.locked && metaString(c.meta, 'inReplyTo') === inReplyTo);
}

/** The card a `post_card` call with this container card id posted, if any. */
export async function getCardById(cardId: string): Promise<CardRecord | undefined> {
  const row = await getDb().get<KitCardRow>('SELECT record_json FROM ui_kit_cards WHERE card_id = ?', cardId);
  return row ? (JSON.parse(row.record_json) as CardRecord) : undefined;
}
