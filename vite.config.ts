import { fileURLToPath, URL } from 'node:url'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import {
  HOMEPAGE_PRERENDER_MARKER,
  injectHomepagePrerender,
  renderFallbackHomepagePrerender,
  renderHomepagePrerenderFromPublicData,
} from './scripts/seo-prerender'

// https://vite.dev/config/
export default defineConfig({
  plugins: [homepagePrerenderPlugin(), react(), tailwindcss()],
  server: {
    allowedHosts: ['coding.tailbc92d.ts.net'],
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
})

function homepagePrerenderPlugin(): Plugin {
  return {
    name: 'homepage-prerender',
    async transformIndexHtml(html) {
      if (!html.includes(HOMEPAGE_PRERENDER_MARKER)) return html
      let prerendered = renderFallbackHomepagePrerender()
      try {
        prerendered = await renderHomepagePrerenderFromPublicData()
      } catch (error) {
        console.warn(`Homepage prerender fallback used: ${error instanceof Error ? error.message : String(error)}`)
      }
      return injectHomepagePrerender(html.replace(HOMEPAGE_PRERENDER_MARKER, ''), prerendered)
    },
  }
}
