import { clsx, type ClassValue } from 'clsx'
import { extendTailwindMerge } from 'tailwind-merge'

/** Knows the custom `tracking-label` token from src/index.css so it merges with other tracking classes. */
const twMerge = extendTailwindMerge({ extend: { theme: { tracking: ['label'] } } })

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
