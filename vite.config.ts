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
import { createTournamentFeedService } from './scripts/leaguepedia-tournament-feed'

// https://vite.dev/config/
export default defineConfig({
  plugins: [homepagePrerenderPlugin(), liveTournamentFeedPlugin(), react(), tailwindcss()],
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

/** Serves the live Leaguepedia feed in development, as the Railway server does. */
function liveTournamentFeedPlugin(): Plugin {
  return {
    name: 'live-tournament-feed',
    // Ordered after other plugins, so test fixture middleware answers first.
    enforce: 'post',
    configureServer(server) {
      const service = createTournamentFeedService()
      server.middlewares.use((request, response, next) => {
        const path = new URL(request.url ?? '/', 'http://localhost').pathname
        if (path !== '/tournament-data/feed.json' && path !== '/tournament-data/feed.json.health.json') return next()
        void service.read().then(({ feed, health }) => {
          const body = path === '/tournament-data/feed.json' ? feed : health
          response.statusCode = body ? 200 : 503
          response.setHeader('content-type', 'application/json; charset=utf-8')
          response.setHeader('cache-control', 'no-store')
          response.end(JSON.stringify(body ?? { ok: false, error: health?.warnings.join(' ') || 'Tournament feed is unavailable' }))
        }, next)
      })
    },
  }
}
