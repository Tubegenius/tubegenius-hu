// Egyetlen, közös topic-identitás szerződés — kliens ÉS szerver oldalon
// egyaránt ugyanazt az identitást kell használnia, mint amit a
// upsert_creator_memory() RPC ténylegesen tárol (ld.
// supabase/migrations/067_creator_lane_expand.sql: `v_topic text :=
// btrim(coalesce(p_topic, ''))`). Kizárólag whitespace-trim — SZÁNDÉKOSAN
// nincs lowercase vagy egyéb Unicode-normalizálás, mert a creator_memory
// jelenlegi egyediségi szerződése (idx_creator_memory_user_topic_pending /
// idx_creator_memory_user_topic_lane, és korábban creator_memory_user_id_
// topic_key) a `topic` oszlopot AS-IS, case-sensitive módon kezeli — egy
// önkényes kliensoldali lowercase itt hamis identitás-egyezést hozna létre
// olyan témák között, amik a szerver szemében ténylegesen különbözőek.
export function normalizeTopicKey(topic: string): string {
  return topic.trim()
}

export function isValidTopicKey(key: string): boolean {
  return key.length > 0
}

// A "korábban elmentett témák" batch lookup (POST /api/memory/saved-lookup)
// szerveroldali, szigorú korlátai — mindkét oldal (kliens defenzív vágás +
// szerver tényleges validáció) ugyanezt a két konstanst használja, hogy a
// kliens sose küldjön olyan kérést, amit a szerver úgyis elutasítana.
export const SAVED_LOOKUP_MAX_TOPICS = 50
export const SAVED_LOOKUP_MAX_TOPIC_LENGTH = 300
