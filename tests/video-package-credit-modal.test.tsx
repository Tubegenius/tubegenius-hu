// @vitest-environment jsdom
//
// VALÓDI renderelt (React Testing Library + jsdom) tesztek a Video Package kreditablakra
// (components/video-package/VideoPackageCreditModal.tsx): a három egyenleghelyzet tényleges DOM-ja, gombnyomással.
// Az ablak nem állíthat feltétel nélküli költséget és biztos "futtatás után marad" egyenleget, mert cache-találat esetén
// a meglévő eredmény megnyitása 0 kredit; az új generálás legfeljebb a megadott összeg.
import React from 'react'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import VideoPackageCreditModal from '@/components/video-package/VideoPackageCreditModal'
import { buildVideoPackageCreditCheck } from '@/lib/video-package-credit-gate'

afterEach(() => cleanup())

function renderModal(balance: number | null, cost = 6, feature = 'Video Package (Long)') {
  const onConfirm = vi.fn()
  const onCancel = vi.fn()
  render(<VideoPackageCreditModal check={buildVideoPackageCreditCheck({ feature, cost, balance })} onConfirm={onConfirm} onCancel={onCancel} />)
  return { onConfirm, onCancel, dialog: screen.getByRole('dialog') }
}

// Szöveg a teljes ablakban (a sorok címke/érték párosa külön elemekben van).
const textOf = (el: HTMLElement) => (el.textContent || '').replace(/\s+/g, ' ')

describe('rendered modal — balance covers the maximum price (40 >= 6)', () => {
  it('states the free opening (0 kredit) and the conditional "legfeljebb 6 kredit"; the worst-case remainder is labelled as conditional', () => {
    const { dialog } = renderModal(40)
    expect(dialog.getAttribute('data-credit-mode')).toBe('covered')
    const text = textOf(dialog)
    expect(text).toContain('Gyártási csomag indítása')
    expect(text).toContain('Meglévő eredmény megnyitása0 kredit')
    expect(text).toContain('Új generáláslegfeljebb 6 kredit')
    expect(text).toContain('legfeljebb 6 kreditbe kerül')
    expect(text).toContain('díjmentesen megnyitjuk')
    expect(text).toContain('Jelenlegi kredited40')
    expect(text).toContain('Új generálás esetén legalább ennyi marad34')
  })

  it('never says "Futtatás után marad" or an unconditional "Művelet költsége"', () => {
    const { dialog } = renderModal(40)
    const text = textOf(dialog)
    expect(text).not.toContain('Futtatás után marad')
    expect(text).not.toContain('Művelet költsége')
    expect(text).not.toMatch(/Ez a művelet \d+ kreditbe kerül/)
  })

  it('has a Mégse and a Folytatás button; the buttons call the right handlers; no top-up link', () => {
    const { dialog, onConfirm, onCancel } = renderModal(40)
    expect(within(dialog).queryByText('Kredit feltöltése')).toBeNull()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Folytatás' }))
    expect(onConfirm).toHaveBeenCalledTimes(1)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Mégse' }))
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('shorts: the maximum is 2 credits', () => {
    const { dialog } = renderModal(10, 2, 'Video Package (Shorts)')
    const text = textOf(dialog)
    expect(text).toContain('Gyártási csomag (Shorts)')
    expect(text).toContain('legfeljebb 2 kredit')
    expect(text).toContain('Új generálás esetén legalább ennyi marad8')
  })

  it('a balance of exactly the price is still "covered" and the worst-case remainder is 0', () => {
    const { dialog } = renderModal(6)
    expect(dialog.getAttribute('data-credit-mode')).toBe('covered')
    expect(textOf(dialog)).toContain('Új generálás esetén legalább ennyi marad0')
  })
})

describe('rendered modal — balance below the maximum price (2 < 6)', () => {
  it('explains: an existing identical result may open for free, otherwise 402 with no AI generation and no credit deduction', () => {
    const { dialog } = renderModal(2)
    expect(dialog.getAttribute('data-credit-mode')).toBe('insufficient')
    const text = textOf(dialog)
    expect(text).toContain('Új generáláshoz nincs elég kredited')
    expect(text).toContain('azt díjmentesen megnyithatjuk')
    expect(text).toContain('402-es elutasítást ad')
    expect(text).toContain('nincs AI-generálás és nincs kreditlevonás')
    expect(text).toContain('Meglévő eredmény megnyitása0 kredit')
    expect(text).toContain('6 kredit szükséges')
    expect(text).toContain('Jelenlegi kredited2')
  })

  it('is NOT a dead end: a confirm button ("Meglévő eredmény keresése") proceeds, plus a cancel and a top-up link; no remainder line is shown', () => {
    const { dialog, onConfirm, onCancel } = renderModal(2)
    const text = textOf(dialog)
    expect(text).not.toContain('legalább ennyi marad')
    expect(text).not.toContain('Futtatás után marad')
    expect(text).not.toContain('Művelet költsége')
    expect(within(dialog).getByText('Kredit feltöltése').getAttribute('href')).toBe('/dashboard/credits')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Meglévő eredmény keresése' }))
    expect(onConfirm).toHaveBeenCalledTimes(1)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Mégse' }))
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('zero balance renders the same insufficient state', () => {
    const { dialog } = renderModal(0)
    expect(dialog.getAttribute('data-credit-mode')).toBe('insufficient')
    expect(textOf(dialog)).toContain('Jelenlegi kredited0')
  })
})

describe('rendered modal — unreadable balance', () => {
  it('shows the unknown-balance explanation with the conditional maximum, never a made-up balance or remainder', () => {
    const { dialog } = renderModal(null)
    expect(dialog.getAttribute('data-credit-mode')).toBe('unknown')
    const text = textOf(dialog)
    expect(text).toContain('Az egyenleged most nem olvasható')
    expect(text).toContain('legfeljebb 6 kreditbe kerül')
    expect(text).toContain('402-vel elutasít, AI-generálás és kreditlevonás nélkül')
    expect(text).toContain('Jelenlegi kredited—')
    expect(text).not.toContain('legalább ennyi marad')
  })

  it.each([Number.NaN, Number.POSITIVE_INFINITY])('a non-finite balance (%s) is treated as unreadable', (balance) => {
    const { dialog } = renderModal(balance)
    expect(dialog.getAttribute('data-credit-mode')).toBe('unknown')
  })

  it('has a Folytatás button that proceeds', () => {
    const { dialog, onConfirm } = renderModal(null)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Folytatás' }))
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })
})

describe('keyboard and backdrop behave like the shared modal (cancel only)', () => {
  it('Escape cancels, a click on the backdrop cancels, a click inside the dialog does not', () => {
    const { dialog, onCancel, onConfirm } = renderModal(40)
    fireEvent.click(dialog)
    expect(onCancel).not.toHaveBeenCalled()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onCancel).toHaveBeenCalledTimes(1)
    fireEvent.click(dialog.parentElement as HTMLElement)
    expect(onCancel).toHaveBeenCalledTimes(2)
    expect(onConfirm).not.toHaveBeenCalled()
  })
})
