// PR #7 Logout/Back Navigation gate -- local-only fixtures for a disposable credit user.
// Talks ONLY to the local Supabase DB container (same guard as e2e/support/db.ts).
import { execSync } from 'node:child_process'
import { assertLocalStackAvailable } from './db'

const CONTAINER = 'supabase_db_WillViralFinal'

function psql(sql: string): string {
  return execSync(`docker exec -i ${CONTAINER} psql -U postgres -d postgres -t -A -q -v ON_ERROR_STOP=1 -f -`, {
    input: sql,
    encoding: 'utf-8',
  })
}

export { assertLocalStackAvailable }

export function seedOnboardedProfile(userId: string, channelName: string): void {
  psql(`insert into profiles (user_id, onboarding_completed, channel_name) values ('${userId}', true, '${channelName.replace(/'/g, "''")}') on conflict (user_id) do update set onboarding_completed = true, channel_name = excluded.channel_name;`)
}

// The DB trigger (091) already issued the 50-credit starter grant; this only
// moves the subscription bucket to a distinct number so two users are distinguishable.
export function setSubscriptionBalance(userId: string, balance: number): void {
  psql(`update user_credits set subscription_credit_balance = ${Number(balance)} where user_id = '${userId}';`)
}

export function readBalance(userId: string): number {
  return Number(psql(`select balance from user_credits where user_id = '${userId}';`).trim())
}

export function cleanupUserRows(userIds: string[]): void {
  for (const id of userIds) {
    psql(`delete from profiles where user_id = '${id}'; delete from credit_ledger where user_id = '${id}';`)
  }
}
