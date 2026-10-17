import { existsSync } from 'node:fs'
import { join } from 'node:path'
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
  plugins: [rankingManifestPreloadPlugin(), homepagePrerenderPlugin(), liveTournamentFeedPlugin(), react(), tailwindcss()],
  build: { manifest: true },
  server: {
    allowedHosts: ['coding.tailbc92d.ts.net'],
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
})

function rankingManifestPreloadPlugin(): Plugin {
  let dataUrl = '/data/ranking-summary.json'
  return {
    name: 'ranking-manifest-preload',
    configResolved(config) {
      dataUrl = config.env.VITE_RANKING_DATA_URL || dataUrl
    },
    transformIndexHtml() {
      return [{
        tag: 'script',
        injectTo: 'head-prepend',
        children: `if (location.pathname === '/' && !/^#tournaments(?:\\?|$)/.test(location.hash)) {
          const preload = document.createElement('link');
          preload.rel = 'preload';
          preload.as = 'fetch';
          preload.href = ${JSON.stringify(dataUrl).replaceAll('<', '\\u003c')};
          preload.crossOrigin = 'anonymous';
          document.head.append(preload);
        }`,
      }]
    },
  }
}

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
      const { publicDir } = server.config
      server.middlewares.use((request, response, next) => {
        const path = new URL(request.url ?? '/', 'http://localhost').pathname
        if (path !== '/tournament-data/feed.json' && path !== '/tournament-data/feed.json.health.json') return next()
        // A local feed.json replaces the live feed and health; Vite serves public files after this middleware.
        if (publicDir && existsSync(join(publicDir, 'tournament-data', 'feed.json'))) return next()
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
