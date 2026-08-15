import { describe, expect, it } from 'vitest'
import { isCameraJunkFile, isSidecarFile } from '../upload-store'

/**
 * Classification of a dropped camera-card folder (§23a/§23c).
 *
 * These three predicates decide, per file, between "upload it as an asset",
 * "send it to the sidecar matcher", and "drop it silently". Getting the last
 * one wrong in either direction is the expensive case: too eager and real
 * footage disappears without a word, too shy and a card folder produces one
 * 400 per housekeeping file, which is the bug this change exists to fix.
 */

function file(name: string, type = ''): File {
  return new File(['x'], name, { type })
}

describe('isCameraJunkFile', () => {
  it.each([
    ['C0001.PPN', 'Sony playback index'],
    ['C0001.SMI', 'Sony playback index'],
    ['GOPR0001.THM', 'GoPro thumbnail'],
    ['A001_C001.rtn', 'RED thumbnail'],
    ['00000.BMP', 'Panasonic thumbnail'],
    ['INDEX.MIF', 'Canon card index'],
    ['LASTCLIP.TXT', 'Panasonic card index'],
    ['.DS_Store', 'macOS'],
    ['Thumbs.db', 'Windows'],
    ['._C0001.MP4', 'AppleDouble resource fork'],
  ])('drops %s (%s)', (name) => {
    expect(isCameraJunkFile(file(name))).toBe(true)
  })

  it.each([
    'GOPR0001.LRV',   // a real offline-edit proxy, explicitly not junk
    'C0001.MP4',
    'A001_C001.R3D',
    'clip.mov',
    'A001C001.cdl',
    'DJI_0001.SRT',
    'thumbnail.jpg',  // "thumb" in a name is not the .thm extension
  ])('keeps %s', (name) => {
    expect(isCameraJunkFile(file(name))).toBe(false)
  })

  it('matches on the basename, so a path never changes the verdict', () => {
    expect(isCameraJunkFile(file('PRIVATE/AVCHD/BDMV/CLIPINF/00000.BMP'))).toBe(true)
    expect(isCameraJunkFile(file('THM/holiday.mp4'))).toBe(false)
  })

  it('is case-insensitive, since cards write filenames in upper case', () => {
    expect(isCameraJunkFile(file('index.mif'))).toBe(true)
    expect(isCameraJunkFile(file('gopr0001.thm'))).toBe(true)
  })
})

describe('isSidecarFile', () => {
  it.each([
    'A001C001.cdl',
    'shot.CC',
    'grade.ccc',
    'dailies.ale',
    'C0001M01.XML',
    'DJI_0001.SRT',
    '00000.CPI',
    'DSC_0001.nksc',
    'A001_C001.RMD',
    'C0001.BIM',
    'MVI_0001.CIF',
  ])('routes %s to the sidecar matcher', (name) => {
    expect(isSidecarFile(file(name))).toBe(true)
  })

  it.each(['C0001.MP4', 'A001_C001.R3D', 'GOPR0001.LRV', 'still.jpg'])(
    'leaves %s to upload as an asset',
    (name) => {
      expect(isSidecarFile(file(name))).toBe(false)
    },
  )
})

describe('the three categories do not overlap', () => {
  const everything = [
    'C0001.MP4', 'A001_C001.R3D', 'GOPR0001.LRV', 'still.jpg', 'clip.mov',
    'A001C001.cdl', 'dailies.ale', 'C0001M01.XML', 'DJI_0001.SRT', '00000.CPI',
    'DSC_0001.nksc', 'A001_C001.RMD', 'C0001.BIM', 'MVI_0001.CIF',
    'C0001.PPN', 'GOPR0001.THM', 'INDEX.MIF', '.DS_Store', '00000.BMP',
  ]

  it('never classifies one file as both a sidecar and junk', () => {
    // A file in both sets would be silently dropped or double-handled
    // depending on which filter the caller happens to apply first.
    const both = everything.filter((n) => isSidecarFile(file(n)) && isCameraJunkFile(file(n)))
    expect(both).toEqual([])
  })
})
