/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        // ─── IDIRA theme tokens (CSS-variable driven, swap on dark) ────
        'bg':       'rgb(var(--rgb-bg) / <alpha-value>)',
        'bg-card':  'rgb(var(--rgb-surface) / <alpha-value>)',
        'bg-muted': 'rgb(var(--rgb-bg-alt) / <alpha-value>)',
        'border':   'rgb(var(--rgb-line) / <alpha-value>)',
        'surface':  'rgb(var(--rgb-surface) / <alpha-value>)',
        'line':     'rgb(var(--rgb-line) / <alpha-value>)',
        'text':     'rgb(var(--rgb-text) / <alpha-value>)',
        'text-2':   'rgb(var(--rgb-text-2) / <alpha-value>)',
        'text-muted': 'rgb(var(--rgb-text-muted) / <alpha-value>)',

        // ─── Brand accents (constant in both themes) ───────────────────
        idira: {
          blue:        '#0067ff',
          'blue-2':    '#2589ff',
          'blue-deep': '#0048b8',
          orange:      '#fa582d',
          magenta:     '#ff2d8a',
          cyan:        '#00d4ff',
          gold:        '#ffb800',
          deep:        '#001236',
        },

        // ─── Domain accents (constant) — re-pointed to IDIRA tones ─────
        'mi-red':   '#fa582d',      // was #e63946 → IDIRA orange
        'mi-cyan':  '#00d4ff',      // was #00d9ff → IDIRA cyan
        'mi-gold':  '#ffb800',      // was #ffc107 → IDIRA gold
        'spiffe':   '#10b981',      // unchanged — SPIFFE green stays
        'pki':      '#6048d6',
        'k8s':      '#0067ff',
        'mtls':     '#fa582d',
      },
      fontFamily: {
        'sans':    ['Onest', 'system-ui', '-apple-system', 'sans-serif'],
        'display': ['Onest', 'system-ui', '-apple-system', 'sans-serif'],
        'mono':    ['IBM Plex Mono', 'ui-monospace', 'SF Mono', 'monospace'],
      },
      animation: {
        'pulse-slow': 'pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'fade-up':    'fadeUp 0.6s ease-out',
        'shimmer':    'shimmer 14s linear infinite',
      },
      keyframes: {
        fadeUp: {
          '0%':   { opacity: '0', transform: 'translateY(20px)' },
          '100%': { opacity: '1', transform: 'translateY(0)'    },
        },
        shimmer: { to: { backgroundPosition: '200% 0' } },
      },
      boxShadow: {
        'idira-blue': '0 12px 40px -8px rgba(0, 103, 255, 0.35)',
      },
    },
  },
  plugins: [],
}
