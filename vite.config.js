import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api/archidekt': {
        target: 'https://archidekt.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/archidekt/, '/api'),
      },
      '/api/moxfield': {
        target: 'https://api2.moxfield.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/moxfield/, ''),
        headers: {
          'User-Agent': 'CardListCompare/1.0',
        },
      },
      '/api/deckcheck': {
        target: 'https://deckcheck.co/api',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/deckcheck/, ''),
      },
      '/api/tappedout': {
        target: 'https://tappedout.net',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/tappedout/, ''),
      },
      '/api/deckstats': {
        target: 'https://deckstats.net',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/deckstats/, ''),
      },
      '/api/scryfall': {
        target: 'https://api.scryfall.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/scryfall/, ''),
      },
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
})
