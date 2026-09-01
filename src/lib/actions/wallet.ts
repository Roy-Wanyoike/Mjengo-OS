// Money-core actions (spec §36-§40, §57) — payment requests, wallet ops,
// double-entry ledger posting and reversals. Dispatched from lib/mjengo.ts
// applyAction(), which auto-writes the AuditEvent for every success.
//
// Thin controller, fat service: every rule lives in
// src/modules/wallet/service.ts + src/modules/ledger/service.ts.
// F-MONEY implements the services.

import {
  createPaymentRequest,
  decidePaymentRequest,
  payPaymentRequest,
  createWallet,
  depositWallet,
  withdrawWallet,
  transferWallet,
  reverseTransaction,
  postJournal,
} from '@/modules/wallet/service'

export const WALLET_ACTIONS = [
  'payment.request', // { description, amount, payee, method?, costCode?, relatedEntityType?, relatedEntityId? } — requester stamped from the session
  'payment.decide', // { id, decision: 'approve'|'reject', note? } — decider resolved from the session (client/finance queue)
  'payment.pay', // { id, method?, reference?, costCode? } — provider seam + double-entry ledger, atomic; balance checked in-tx
  'wallet.create', // { label, ownerType?, ownerId? }
  'wallet.deposit', // { walletId | code, amount, reference? } — posts CASH→WALLET ledger rows
  'wallet.withdraw', // { walletId, amount, note? } — balance re-checked inside the transaction
  'wallet.transfer', // { fromWalletId, toWalletId, amount, note? }
  'transaction.reverse', // { id, reason } — reversal entry; history is never edited/deleted (spec §39)
  'ledger.post', // { description, lines: [{ accountCode, side, amount }] } — manual journal entry
] as const

export async function applyWalletAction(
  type: string,
  payload: any,
  projectId: string,
): Promise<any> {
  const p = payload ?? {}
  switch (type) {
    case 'payment.request':
      return createPaymentRequest(projectId, p)
    case 'payment.decide':
      return decidePaymentRequest(projectId, p)
    case 'payment.pay':
      return payPaymentRequest(projectId, p)
    case 'wallet.create':
      return createWallet(projectId, p)
    case 'wallet.deposit':
      return depositWallet(projectId, p)
    case 'wallet.withdraw':
      return withdrawWallet(projectId, p)
    case 'wallet.transfer':
      return transferWallet(projectId, p)
    case 'transaction.reverse':
      return reverseTransaction(projectId, p)
    case 'ledger.post':
      return postJournal(projectId, p)
    default:
      throw new Error(`Unknown wallet action: ${type}`)
  }
}
