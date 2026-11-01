export default defineNuxtConfig({
  modules: ['@nuxt/ui', '@nuxtjs/i18n'],
  ssr: false,
  devtools: { enabled: false },
  css: ['~/assets/css/main.css'],
  colorMode: {
    preference: 'dark',
    fallback: 'dark',
  },
  devServer: { port: 4320 },
  // Bundle the lucide icons used by the UI into the client build: UDMT is a
  // local desktop tool and must not call api.iconify.design at runtime.
  icon: {
    clientBundle: { scan: true, sizeLimitKb: 1024 },
    serverBundle: 'local',
  },
  i18n: {
    locales: [
      { code: 'en', language: 'en-US', name: 'English', file: 'en.json' },
      { code: 'vi', language: 'vi-VN', name: 'Tiếng Việt', file: 'vi.json' },
    ],
    defaultLocale: 'en',
    strategy: 'no_prefix',
    detectBrowserLanguage: {
      useCookie: true,
      cookieKey: 'udmt_locale',
      redirectOn: 'root',
    },
  },
  compatibilityDate: '2025-01-01',
  app: {
    head: {
      title: 'UDMT',
      charset: 'utf-8',
      link: [{ rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' }],
      viewport: 'width=device-width, initial-scale=1',
      meta: [{ name: 'theme-color', content: '#0b0b14' }],
    },
  },
  // The GUI is always served from the same origin as the local API:
  // - `udmt gui` serves app/.output/public from the API server
  // - `npm run dev:gui` proxies /api to the running `udmt serve`
  nitro: {
    devProxy: {
      '/api': { target: 'http://127.0.0.1:4004', changeOrigin: false },
    },
  },
})
