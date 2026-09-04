import { useEffect, useState } from 'react'

export interface Palette {
  id: string
  name: string
  primary: string
  secondary: string
  accent: string
  background: string
  surface: string
  card: string
  text: string
  muted: string
  success: string
  danger: string
}

// 20 Minecraft-inspired color themes. All are dark (they replace the panel's
// dark-mode palette); the user's light/dark/system switch still chooses between
// the dark palette set and the standard light theme.
export const PALETTES: Palette[] = [
  { id: 'ender-purple', name: 'Ender Purple', primary: '#8B5CF6', secondary: '#A855F7', accent: '#C084FC', background: '#0B0712', surface: '#151020', card: '#1C1529', text: '#F5F3FF', muted: '#A8A0B8', success: '#22C55E', danger: '#EF4444' },
  { id: 'nether-red', name: 'Nether Red', primary: '#EF4444', secondary: '#DC2626', accent: '#F97316', background: '#100707', surface: '#1A0D0D', card: '#241414', text: '#FFF5F5', muted: '#B9A1A1', success: '#22C55E', danger: '#FF3B30' },
  { id: 'diamond', name: 'Diamond', primary: '#06B6D4', secondary: '#0891B2', accent: '#22D3EE', background: '#061014', surface: '#0B1B20', card: '#10262C', text: '#ECFEFF', muted: '#8FAEB5', success: '#10B981', danger: '#F43F5E' },
  { id: 'emerald', name: 'Emerald', primary: '#10B981', secondary: '#059669', accent: '#34D399', background: '#06110D', surface: '#0B1B15', card: '#10271E', text: '#ECFDF5', muted: '#8FAFA3', success: '#22C55E', danger: '#EF4444' },
  { id: 'amethyst', name: 'Amethyst', primary: '#A855F7', secondary: '#7C3AED', accent: '#D8B4FE', background: '#0D0714', surface: '#170D21', card: '#21132F', text: '#FAF5FF', muted: '#AA98B8', success: '#34D399', danger: '#F87171' },
  { id: 'redstone', name: 'Redstone', primary: '#F04438', secondary: '#C92A2A', accent: '#FF6B35', background: '#110807', surface: '#1D0E0D', card: '#291412', text: '#FFF7F5', muted: '#B89D98', success: '#22C55E', danger: '#FF3B30' },
  { id: 'obsidian', name: 'Obsidian', primary: '#6366F1', secondary: '#4F46E5', accent: '#818CF8', background: '#050507', surface: '#0D0D12', card: '#15151C', text: '#F4F4F5', muted: '#92929D', success: '#22C55E', danger: '#EF4444' },
  { id: 'creeper', name: 'Creeper', primary: '#84CC16', secondary: '#65A30D', accent: '#A3E635', background: '#080D05', surface: '#101A0B', card: '#17240F', text: '#F7FEE7', muted: '#9CAF86', success: '#22C55E', danger: '#EF4444' },
  { id: 'ocean', name: 'Ocean', primary: '#3B82F6', secondary: '#2563EB', accent: '#60A5FA', background: '#050A14', surface: '#0B1424', card: '#101D32', text: '#EFF6FF', muted: '#91A4BF', success: '#22C55E', danger: '#F43F5E' },
  { id: 'blaze', name: 'Blaze', primary: '#F59E0B', secondary: '#EA580C', accent: '#FBBF24', background: '#100A04', surface: '#1B1007', card: '#27170A', text: '#FFFBEB', muted: '#B8A486', success: '#22C55E', danger: '#EF4444' },
  { id: 'ice', name: 'Ice', primary: '#38BDF8', secondary: '#0EA5E9', accent: '#7DD3FC', background: '#071016', surface: '#0D1B24', card: '#132631', text: '#F0F9FF', muted: '#91A8B5', success: '#22C55E', danger: '#F43F5E' },
  { id: 'ancient', name: 'Ancient', primary: '#D97706', secondary: '#92400E', accent: '#F59E0B', background: '#0C0906', surface: '#19130D', card: '#251C12', text: '#FEF3C7', muted: '#A99A7D', success: '#65A30D', danger: '#DC2626' },
  { id: 'sakura', name: 'Sakura', primary: '#EC4899', secondary: '#DB2777', accent: '#F9A8D4', background: '#11070D', surface: '#1D0D17', card: '#291321', text: '#FDF2F8', muted: '#B99AAA', success: '#22C55E', danger: '#EF4444' },
  { id: 'midnight', name: 'Midnight', primary: '#6366F1', secondary: '#7C3AED', accent: '#A78BFA', background: '#030305', surface: '#0A0A10', card: '#12121A', text: '#F8FAFC', muted: '#8B8FA3', success: '#22C55E', danger: '#EF4444' },
  { id: 'toxic', name: 'Toxic', primary: '#22C55E', secondary: '#16A34A', accent: '#A3E635', background: '#050B07', surface: '#0B160E', card: '#112116', text: '#F0FDF4', muted: '#8DAA96', success: '#4ADE80', danger: '#EF4444' },
  { id: 'netherite', name: 'Netherite', primary: '#737373', secondary: '#525252', accent: '#A3A3A3', background: '#080808', surface: '#111111', card: '#1A1A1A', text: '#FAFAFA', muted: '#929292', success: '#22C55E', danger: '#EF4444' },
  { id: 'gold', name: 'Gold', primary: '#EAB308', secondary: '#CA8A04', accent: '#FACC15', background: '#0D0B04', surface: '#191505', card: '#241E08', text: '#FEFCE8', muted: '#ADA37C', success: '#22C55E', danger: '#DC2626' },
  { id: 'skyblock', name: 'Skyblock', primary: '#14B8A6', secondary: '#0D9488', accent: '#2DD4BF', background: '#05100F', surface: '#0A1A18', card: '#102522', text: '#F0FDFA', muted: '#8BAEA9', success: '#22C55E', danger: '#F43F5E' },
  { id: 'dark-forest', name: 'Dark Forest', primary: '#15803D', secondary: '#166534', accent: '#4ADE80', background: '#040A06', surface: '#09140C', card: '#102018', text: '#F0FDF4', muted: '#899E90', success: '#22C55E', danger: '#EF4444' },
  { id: 'cyber-end', name: 'Cyber End', primary: '#00FF9C', secondary: '#00D9FF', accent: '#B000FF', background: '#030509', surface: '#080D14', card: '#0D141D', text: '#F5FFFC', muted: '#82949A', success: '#00FF9C', danger: '#FF3864' },
]

const DEFAULT_PALETTE = 'ender-purple'

export type PaletteId = string

// Returns the current saved palette id and a setter that persists + applies it.
// Applied as `data-palette` on <html>, consumed by styles/themes.css. Only takes
// effect in dark/system-resolved-dark mode (the palettes are dark themes).
export function usePalette() {
  const [palette, setPalette] = useState<PaletteId>(
    () => (localStorage.getItem('uh_palette') as PaletteId) || DEFAULT_PALETTE
  )

  useEffect(() => {
    document.documentElement.dataset.palette = palette
    localStorage.setItem('uh_palette', palette)
  }, [palette])

  return { palette, setPalette }
}

export function paletteById(id: string): Palette {
  return PALETTES.find((p) => p.id === id) || PALETTES[0]
}
